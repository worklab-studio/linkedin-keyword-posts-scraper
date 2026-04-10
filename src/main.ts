import { Actor } from 'apify';
import { PlaywrightCrawler, Dataset, log } from 'crawlee';

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

// ─── URL builder ──────────────────────────────────────────────────────────────

function buildSearchUrl(keyword: string, dateFilter: string): string {
    let url = `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(keyword)}&origin=GLOBAL_SEARCH_HEADER&sortBy=%22date_posted%22`;
    if (dateFilter) {
        url += `&datePosted=%22${dateFilter}%22`;
    }
    return url;
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
    let proxyConfiguration: any = undefined;
    if (input.proxy?.useApifyProxy) {
        proxyConfiguration = await Actor.createProxyConfiguration({
            groups: input.proxy.apifyProxyGroups ?? ['RESIDENTIAL'],
        });
        log.info('Using Apify Residential proxies');
    } else if (input.proxy?.proxyUrls?.length) {
        proxyConfiguration = await Actor.createProxyConfiguration({
            proxyUrls: input.proxy.proxyUrls,
        });
    }

    const keywordCounts: Record<string, number> = {};
    for (const kw of input.keywords) keywordCounts[kw] = 0;
    const seenUrls = new Set<string>();

    const crawler = new PlaywrightCrawler({
        proxyConfiguration,
        maxRequestRetries: 2,
        requestHandlerTimeoutSecs: 120,
        maxConcurrency: 1,
        headless: true,
        launchContext: {
            launchOptions: { args: ['--disable-blink-features=AutomationControlled'] },
        },

        async requestHandler({ request, page }) {
            const { keyword } = request.userData as { keyword: string };
            const kwLimit = Math.min(limit, 500);

            // Set LinkedIn cookie before navigating
            await page.context().addCookies([{
                name: 'li_at',
                value: input.li_at,
                domain: '.linkedin.com',
                path: '/',
                httpOnly: true,
                secure: true,
            }]);

            const url = buildSearchUrl(keyword, dateFilter);
            log.info(`Navigating to search for "${keyword}"...`);
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

            // Wait for results to load
            await page.waitForTimeout(3000);

            // Check if logged in
            const pageContent = await page.content();
            if (pageContent.includes('login') && !pageContent.includes('search-results')) {
                log.warning('May not be logged in — checking...');
            }

            const now = new Date().toISOString();
            let collected = 0;
            let noNewResults = 0;

            while (collected < kwLimit && noNewResults < 3) {
                // Extract post data from the page
                const posts = await page.evaluate(() => {
                    const results: { url: string; author: string }[] = [];

                    // Get all post update links
                    const links = document.querySelectorAll('a[href*="/feed/update/"], a[href*="/posts/"]');
                    const seenLocal = new Set<string>();

                    for (const link of links) {
                        const href = (link as HTMLAnchorElement).href;
                        if (!href || seenLocal.has(href)) continue;
                        if (!href.includes('/feed/update/') && !href.includes('/posts/')) continue;
                        seenLocal.add(href);

                        // Try to find author name near this link
                        let author = 'Unknown';
                        const container = link.closest('.feed-shared-update-v2, .update-components-actor, [data-urn], .reusable-search__result-container');
                        if (container) {
                            const nameEl = container.querySelector('.update-components-actor__name span, .entity-result__title-text a span, .app-aware-link span[aria-hidden="true"], .feed-shared-actor__name span');
                            if (nameEl?.textContent?.trim()) {
                                author = nameEl.textContent.trim();
                            }
                        }

                        results.push({ url: href, author });
                    }

                    return results;
                });

                const prevCollected = collected;

                for (const post of posts) {
                    if (collected >= kwLimit) break;
                    // Normalize URL
                    let postUrl = post.url.split('?')[0];
                    if (!postUrl.endsWith('/')) postUrl += '/';

                    if (seenUrls.has(postUrl)) continue;
                    seenUrls.add(postUrl);

                    await Dataset.pushData({
                        author_name: post.author,
                        keyword,
                        post_url: postUrl,
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

                if (collected >= kwLimit) break;

                // Scroll down to load more
                await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
                await page.waitForTimeout(2000);

                // Click "Show more results" button if present
                try {
                    const showMore = await page.$('button.scaffold-finite-scroll__load-button, button[aria-label*="more results"]');
                    if (showMore) {
                        await showMore.click();
                        await page.waitForTimeout(2000);
                    }
                } catch { /* ignore */ }
            }

            log.info(`"${keyword}": scraped ${collected} posts`);
        },

        failedRequestHandler({ request, error }) {
            log.error(`Failed: ${request.url} — ${(error as Error).message}`);
        },
    });

    // One request per keyword
    const requests = input.keywords.map(keyword => ({
        url: buildSearchUrl(keyword, dateFilter),
        userData: { keyword },
    }));

    await crawler.run(requests);

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
