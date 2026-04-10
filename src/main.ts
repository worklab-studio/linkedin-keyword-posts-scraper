import { Actor } from 'apify';
import { Dataset, log } from 'crawlee';
import { chromium } from 'playwright';

// ─── Types ────────────────────────────────────────────────────────────────────

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
    keyword: string;
    post_url: string;
    reactions: number;
    comments: number;
    scraped_at: string;
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

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
    if (input.date && input.date !== 'ignore') {
        return LINKEDIN_DATE_FILTER_MAP[input.date] ?? '';
    }
    if (input.from || input.to) {
        const now = Date.now();
        const start = input.from ? new Date(input.from).getTime() : now - 180 * 24 * 60 * 60 * 1000;
        const diffDays = (now - start) / (24 * 60 * 60 * 1000);
        if (diffDays <= 1) return 'past-24h';
        if (diffDays <= 7) return 'past-week';
        if (diffDays <= 30) return 'past-month';
        return '';
    }
    return '';
}

function buildSearchUrl(keyword: string, dateFilter: string): string {
    let url = `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(keyword)}&origin=FACETED_SEARCH&sortBy=%5B%22date_posted%22%5D`;
    if (dateFilter) {
        url += `&datePosted=%5B%22${dateFilter}%22%5D`;
    }
    return url;
}

function parseCount(text: string | null | undefined): number {
    if (!text) return 0;
    const cleaned = text.trim().toLowerCase().replace(/,/g, '');
    if (cleaned.includes('k')) return Math.round(parseFloat(cleaned) * 1000);
    if (cleaned.includes('m')) return Math.round(parseFloat(cleaned) * 1000000);
    const num = parseInt(cleaned, 10);
    return isNaN(num) ? 0 : num;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

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

    // Proxy
    let proxyUrl: string | undefined;
    if (input.proxy?.useApifyProxy) {
        const proxyConfig = await Actor.createProxyConfiguration({
            groups: input.proxy.apifyProxyGroups ?? ['RESIDENTIAL'],
        });
        proxyUrl = await proxyConfig!.newUrl();
        log.info('Using Apify Residential proxy');
    } else if (input.proxy?.proxyUrls?.length) {
        proxyUrl = input.proxy.proxyUrls[0];
        log.info('Using custom proxy');
    }

    // Launch browser
    const launchOptions: any = {
        headless: true,
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    };
    if (proxyUrl) {
        launchOptions.proxy = { server: proxyUrl };
    }

    const browser = await chromium.launch(launchOptions);

    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 },
    });

    // Set LinkedIn cookies
    await context.addCookies([
        {
            name: 'li_at',
            value: input.li_at,
            domain: '.linkedin.com',
            path: '/',
            httpOnly: true,
            secure: true,
        },
        {
            name: 'JSESSIONID',
            value: `"ajax:${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}"`,
            domain: '.linkedin.com',
            path: '/',
            secure: true,
        },
    ]);

    const page = await context.newPage();

    // Warm up session — visit a lightweight LinkedIn page first
    log.info('Warming up LinkedIn session...');
    try {
        await page.goto('https://www.linkedin.com/check/ring/dashboard', { waitUntil: 'commit', timeout: 15000 });
    } catch {
        // Even if it times out, cookies are set and session may be established
        log.info('Warmup page slow, continuing anyway...');
    }
    await page.waitForTimeout(2000);

    const currentUrl = page.url();
    if (currentUrl.includes('/login') || currentUrl.includes('/authwall')) {
        log.error('li_at cookie is expired or invalid — redirected to login');
        await browser.close();
        throw new Error('LinkedIn authentication failed. Please refresh your li_at cookie.');
    }
    log.info('Session established');

    // Scrape each keyword
    const keywordCounts: Record<string, number> = {};
    for (const kw of input.keywords) keywordCounts[kw] = 0;
    const seenUrls = new Set<string>();

    for (const keyword of input.keywords) {
        const url = buildSearchUrl(keyword, dateFilter);
        log.info(`Searching for "${keyword}"...`);

        try {
            await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
            await page.waitForTimeout(5000);

            // Log current URL and page state
            log.info(`Current URL: ${page.url()}`);
            const title = await page.title();
            log.info(`Page title: ${title}`);

            // Save screenshot for debugging
            const screenshot = await page.screenshot({ fullPage: false });
            await Actor.setValue(`screenshot-${keyword}`, screenshot, { contentType: 'image/png' });
            log.info(`Screenshot saved as screenshot-${keyword}`);

            // Log how many links are on the page
            const linkCount = await page.evaluate(() => {
                const all = document.querySelectorAll('a[href*="/feed/update/"], a[href*="/posts/"]');
                return { total: all.length, hrefs: Array.from(all).slice(0, 5).map(a => (a as HTMLAnchorElement).href) };
            });
            log.info(`Post links found: ${linkCount.total}, samples: ${JSON.stringify(linkCount.hrefs)}`);

            // Check for redirect
            if (page.url().includes('/login') || page.url().includes('/authwall')) {
                log.warning(`Redirected to login for "${keyword}" — skipping`);
                continue;
            }

            const now = new Date().toISOString();
            let collected = 0;
            let noNewResults = 0;

            while (collected < limit && noNewResults < 3) {
                // Extract posts from DOM — LinkedIn uses role="listitem" for each post
                const posts = await page.evaluate(() => {
                    const results: { url: string; author: string; reactions: number; comments: number }[] = [];

                    function parseNum(text: string | null | undefined): number {
                        if (!text) return 0;
                        const cleaned = text.trim().toLowerCase().replace(/,/g, '');
                        if (cleaned.includes('k')) return Math.round(parseFloat(cleaned) * 1000);
                        if (cleaned.includes('m')) return Math.round(parseFloat(cleaned) * 1000000);
                        const num = parseInt(cleaned, 10);
                        return isNaN(num) ? 0 : num;
                    }

                    const postContainers = document.querySelectorAll('[role="listitem"]');

                    for (const container of postContainers) {
                        // Find profile link (author URL)
                        const profileLink = container.querySelector('a[href*="/in/"], a[href*="/company/"]') as HTMLAnchorElement;
                        if (!profileLink) continue;
                        const profileUrl = profileLink.href.split('?')[0];

                        // Author name from aria-label
                        let author = 'Unknown';
                        const authorEl = container.querySelector('[aria-label*="post by"]');
                        if (authorEl) {
                            const label = authorEl.getAttribute('aria-label') ?? '';
                            // "Open control menu for post by Palak Sharma"
                            const match = label.match(/post by (.+)/i);
                            if (match) author = match[1].trim();
                        }
                        if (author === 'Unknown') {
                            // Fallback: first bold name text in the container
                            const nameP = container.querySelector('p');
                            if (nameP?.textContent?.trim() && nameP.textContent.trim().length < 50) {
                                author = nameP.textContent.trim();
                            }
                        }

                        // Reactions from screen-reader span
                        let reactions = 0;
                        let comments = 0;
                        const srSpans = container.querySelectorAll('span');
                        for (const span of srSpans) {
                            const text = span.textContent?.trim().toLowerCase() ?? '';
                            if (text.match(/^\d+\s*reactions?$/)) {
                                reactions = parseNum(text.match(/(\d+)/)?.[1]);
                            } else if (text.match(/^\d+\s*comments?$/)) {
                                comments = parseNum(text.match(/(\d+)/)?.[1]);
                            }
                        }

                        results.push({ url: profileUrl, author, reactions, comments });
                    }

                    return results;
                });

                const prevCollected = collected;

                for (const post of posts) {
                    if (collected >= limit) break;
                    let postUrl = post.url.split('?')[0];
                    if (!postUrl.endsWith('/')) postUrl += '/';

                    if (seenUrls.has(postUrl)) continue;
                    seenUrls.add(postUrl);

                    await Dataset.pushData({
                        author_name: post.author,
                        keyword,
                        post_url: postUrl,
                        reactions: post.reactions,
                        comments: post.comments,
                        scraped_at: now,
                    } as PostResult);

                    keywordCounts[keyword]++;
                    collected++;
                }

                if (collected === prevCollected) {
                    noNewResults++;
                } else {
                    noNewResults = 0;
                }

                if (collected >= limit) break;

                // Scroll to load more
                await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
                await page.waitForTimeout(2000);

                // Click "Show more" button if present
                try {
                    const showMore = await page.$('button.scaffold-finite-scroll__load-button');
                    if (showMore) {
                        await showMore.click();
                        await page.waitForTimeout(2000);
                    }
                } catch { /* ignore */ }
            }

            log.info(`"${keyword}": scraped ${collected} posts`);

        } catch (err) {
            log.error(`Error scraping "${keyword}": ${(err as Error).message}`);
        }

        // Delay between keywords
        await page.waitForTimeout(2000 + Math.random() * 3000);
    }

    await browser.close();

    const total = Object.values(keywordCounts).reduce((a, b) => a + b, 0);
    log.info('='.repeat(60));
    log.info(`Done. Total: ${total} posts`);
    for (const [kw, count] of Object.entries(keywordCounts)) {
        log.info(`  "${kw}": ${count} posts`);
    }
    log.info('='.repeat(60));

    await Actor.setValue('OUTPUT_SUMMARY', {
        total_posts: total,
        keywords: keywordCounts,
        completed_at: new Date().toISOString(),
    });
});
