import { Actor } from 'apify';
import { Dataset, log } from 'crawlee';
import { chromium } from 'playwright';

interface Input {
    keywords: string[];
    date?: string;
    from?: string;
    to?: string;
    limit?: number;
    li_at: string;
    proxy?: {
        useApifyProxy?: boolean;
        apifyProxyGroups?: string[];
        proxyUrls?: string[];
    };
}

interface PostResult {
    author_name: string;
    author_profile: string;
    keyword: string;
    post_url: string;
    reactions: number;
    comments: number;
    scraped_at: string;
}

const LINKEDIN_DATE_FILTER_MAP: Record<string, string> = {
    'last-1-day': 'past-24h',
    'last-3-days': 'past-week',
    'last-1-week': 'past-week',
    'last-2-weeks': 'past-month',
    'last-1-month': 'past-month',
    'last-2-months': 'past-month',
    'last-3-months': 'past-month',
    'last-6-months': '',
    'last-1-year': '',
};

function resolveLinkedInDateFilter(input: Input): string {
    if (input.date && input.date !== 'ignore') return LINKEDIN_DATE_FILTER_MAP[input.date] ?? '';
    if (input.from || input.to) {
        const now = Date.now();
        const start = input.from ? new Date(input.from).getTime() : now - 180 * 86400000;
        const days = (now - start) / 86400000;
        if (days <= 1) return 'past-24h';
        if (days <= 7) return 'past-week';
        if (days <= 30) return 'past-month';
        return '';
    }
    return '';
}

function buildSearchUrl(keyword: string, dateFilter: string): string {
    let url = `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(keyword)}&origin=FACETED_SEARCH&sortBy=%5B%22date_posted%22%5D`;
    if (dateFilter) url += `&datePosted=%5B%22${dateFilter}%22%5D`;
    return url;
}

// Extract post data from intercepted API responses
function extractPostsFromApiData(included: any[]): Map<string, any> {
    const posts = new Map<string, any>();

    for (const item of included) {
        const urn = item.entityUrn ?? item['$id'] ?? '';
        const type = item['$type'] ?? '';

        // Look for update/activity entities
        if (urn.includes('fsd_update') || urn.includes('activity') || urn.includes('ugcPost')) {
            posts.set(urn, item);
        }

        // Also collect actor/profile data
        if (type.includes('MiniProfile') || type.includes('Actor')) {
            posts.set(urn, item);
        }
    }

    return posts;
}

await Actor.main(async () => {
    const input = (await Actor.getInput<Input>())!;
    if (!input?.keywords?.length) throw new Error('Input must include at least one keyword.');
    if (!input?.li_at) throw new Error('LinkedIn li_at cookie is required.');

    const limit = input.limit ?? 50;
    const dateFilter = resolveLinkedInDateFilter(input);

    log.info('='.repeat(60));
    log.info('LinkedIn Keyword Posts Scraper');
    log.info(`Keywords: ${input.keywords.join(', ')}`);
    log.info(`Limit per keyword: ${limit}`);
    log.info(`Date filter: ${dateFilter || 'none (all time)'}`);
    log.info('='.repeat(60));

    let proxyUrl: string | undefined;
    if (input.proxy?.useApifyProxy) {
        const pc = await Actor.createProxyConfiguration({ groups: input.proxy.apifyProxyGroups ?? ['RESIDENTIAL'] });
        proxyUrl = await pc!.newUrl();
        log.info('Using Apify Residential proxy');
    } else if (input.proxy?.proxyUrls?.length) {
        proxyUrl = input.proxy.proxyUrls[0];
    }

    const launchOptions: any = {
        headless: true,
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    };
    if (proxyUrl) launchOptions.proxy = { server: proxyUrl };

    const browser = await chromium.launch(launchOptions);
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 },
    });

    await context.addCookies([
        { name: 'li_at', value: input.li_at, domain: '.linkedin.com', path: '/', httpOnly: true, secure: true },
        { name: 'JSESSIONID', value: `"ajax:${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}"`, domain: '.linkedin.com', path: '/', secure: true },
    ]);

    const page = await context.newPage();

    // Warmup
    log.info('Warming up session...');
    try {
        await page.goto('https://www.linkedin.com/check/ring/dashboard', { waitUntil: 'commit', timeout: 15000 });
    } catch { log.info('Warmup slow, continuing...'); }
    await page.waitForTimeout(2000);

    if (page.url().includes('/login') || page.url().includes('/authwall')) {
        await browser.close();
        throw new Error('LinkedIn auth failed. Refresh your li_at cookie.');
    }
    log.info('Session established');

    const keywordCounts: Record<string, number> = {};
    for (const kw of input.keywords) keywordCounts[kw] = 0;
    const seenUrls = new Set<string>();

    for (const keyword of input.keywords) {
        log.info(`Searching for "${keyword}"...`);

        try {
            // Intercept API responses to capture post data
            const apiData: any[] = [];
            const responseHandler = async (response: any) => {
                const url = response.url();
                if (url.includes('/graphql') || url.includes('/search/')) {
                    try {
                        const json = await response.json();
                        if (json?.included) apiData.push(...json.included);
                        if (json?.data?.included) apiData.push(...json.data.included);
                    } catch { /* not JSON */ }
                }
            };
            page.on('response', responseHandler);

            await page.goto(buildSearchUrl(keyword, dateFilter), { waitUntil: 'domcontentloaded', timeout: 60000 });

            // Wait for actual post content to render
            try {
                await page.waitForSelector('[role="listitem"]', { timeout: 15000 });
                log.info('Posts rendered');
            } catch {
                log.warning('No posts found after 15s, trying longer wait...');
                await page.waitForTimeout(8000);
            }

            // Extra wait for API responses to complete
            await page.waitForTimeout(3000);

            log.info(`Page loaded, intercepted ${apiData.length} API items`);

            // Extract from DOM
            const domPosts = await page.evaluate(() => {
                const results: { author: string; profileUrl: string; reactions: number; comments: number }[] = [];

                function parseNum(t: string | null | undefined): number {
                    if (!t) return 0;
                    const c = t.trim().toLowerCase().replace(/,/g, '');
                    if (c.includes('k')) return Math.round(parseFloat(c) * 1000);
                    if (c.includes('m')) return Math.round(parseFloat(c) * 1000000);
                    return parseInt(c, 10) || 0;
                }

                const containers = document.querySelectorAll('[role="listitem"]');
                for (const el of containers) {
                    const profileLink = el.querySelector('a[href*="/in/"], a[href*="/company/"]') as HTMLAnchorElement;
                    if (!profileLink) continue;

                    let author = 'Unknown';
                    const menuBtn = el.querySelector('[aria-label*="post by"]');
                    if (menuBtn) {
                        const m = menuBtn.getAttribute('aria-label')?.match(/post by (.+)/i);
                        if (m) author = m[1].trim();
                    }
                    if (author === 'Unknown') {
                        const p = el.querySelector('p');
                        if (p?.textContent?.trim() && p.textContent.trim().length < 50) author = p.textContent.trim();
                    }

                    let reactions = 0, comments = 0;
                    for (const span of el.querySelectorAll('span')) {
                        const t = span.textContent?.trim().toLowerCase() ?? '';
                        if (t.match(/^\d+\s*reactions?$/)) reactions = parseNum(t.match(/(\d+)/)?.[1]);
                        else if (t.match(/^\d+\s*comments?$/)) comments = parseNum(t.match(/(\d+)/)?.[1]);
                    }

                    results.push({ author, profileUrl: profileLink.href.split('?')[0], reactions, comments });
                }
                return results;
            });

            log.info(`DOM: ${domPosts.length} posts, API: ${apiData.length} items`);

            // Extract activity URNs from API data and page HTML
            const activityUrns: string[] = [];
            for (const item of apiData) {
                const urn = item.entityUrn ?? item['$id'] ?? '';
                if (urn.includes('fsd_update')) {
                    // fsd_update URNs contain the activity ID: urn:li:fsd_update:(urn:li:activity:123,...)
                    const actMatch = urn.match(/activity:(\d+)/);
                    if (actMatch) activityUrns.push(actMatch[1]);
                }
            }

            // Also extract from page HTML as fallback
            if (activityUrns.length === 0) {
                const html = await page.content();
                const matches = [...html.matchAll(/urn:li:activity:(\d+)/g)];
                for (const m of matches) {
                    if (!activityUrns.includes(m[1])) activityUrns.push(m[1]);
                }
            }

            log.info(`Found ${activityUrns.length} activity IDs`);

            const now = new Date().toISOString();
            for (let i = 0; i < domPosts.length; i++) {
                if (keywordCounts[keyword] >= limit) break;
                const post = domPosts[i];

                // Match post URL from activity URNs (by order)
                let postUrl = post.profileUrl;
                if (i < activityUrns.length) {
                    postUrl = `https://www.linkedin.com/feed/update/urn:li:activity:${activityUrns[i]}/`;
                }

                if (seenUrls.has(postUrl)) continue;
                seenUrls.add(postUrl);

                await Dataset.pushData({
                    author_name: post.author,
                    author_profile: post.profileUrl,
                    keyword,
                    post_url: postUrl,
                    reactions: post.reactions,
                    comments: post.comments,
                    scraped_at: now,
                } as PostResult);

                keywordCounts[keyword]++;
            }

            log.info(`"${keyword}": ${keywordCounts[keyword]} posts`);

            // Remove listener for next keyword
            page.removeListener('response', responseHandler);

            // Scroll for more if needed
            if (keywordCounts[keyword] < limit) {
                await page.evaluate(() => window.scrollBy(0, window.innerHeight * 3));
                await page.waitForTimeout(3000);
            }

        } catch (err) {
            log.error(`Error scraping "${keyword}": ${(err as Error).message}`);
        }

        await page.waitForTimeout(2000 + Math.random() * 3000);
    }

    await browser.close();

    const total = Object.values(keywordCounts).reduce((a, b) => a + b, 0);
    log.info('='.repeat(60));
    log.info(`Done. Total: ${total} posts`);
    for (const [kw, count] of Object.entries(keywordCounts)) log.info(`  "${kw}": ${count}`);
    log.info('='.repeat(60));

    await Actor.setValue('OUTPUT_SUMMARY', { total_posts: total, keywords: keywordCounts, completed_at: new Date().toISOString() });
});
