import { Actor } from 'apify';
import { HttpCrawler, PlaywrightCrawler, Dataset, log } from 'crawlee';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Input {
    keywords: string[];
    date?: string;
    from?: string;
    to?: string;
    limit?: number;
    li_at: string;
    use_playwright?: boolean;
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

// Maps our presets to LinkedIn Voyager's datePosted filter values
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

// ─── LinkedIn Voyager API helpers ─────────────────────────────────────────────

function buildVoyagerUrl(keyword: string, start: number = 0, dateFilter: string = ''): string {
    const filters = dateFilter
        ? `List(resultType->CONTENT,datePosted->${dateFilter})`
        : 'List(resultType->CONTENT)';

    const params = new URLSearchParams({
        decorationId: 'com.linkedin.voyager.deco.search.SearchClusterCollection-175',
        count: '10',
        filters,
        keywords: keyword,
        origin: 'GLOBAL_SEARCH_HEADER',
        q: 'all',
        queryContext: 'List(spellCorrectionEnabled->true,relatedSearchesEnabled->true)',
        start: String(start),
    });

    return `https://www.linkedin.com/voyager/api/search/blended?${params.toString()}`;
}

function buildLinkedInSearchUrl(keyword: string, dateFilter: string = ''): string {
    let url = `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(keyword)}&origin=GLOBAL_SEARCH_HEADER&sortBy=date`;
    if (dateFilter) {
        url += `&datePosted=${encodeURIComponent(dateFilter)}`;
    }
    return url;
}

// Generate a consistent random JSESSIONID for the run
const JSESSIONID = `ajax:${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`.slice(0, 24);

function buildLinkedInHeaders(li_at: string): Record<string, string> {
    return {
        'accept': 'application/vnd.linkedin.normalized+json+2.1',
        'accept-language': 'en-US,en;q=0.9',
        'cookie': `li_at=${li_at}; JSESSIONID="${JSESSIONID}"`,
        'csrf-token': JSESSIONID,
        'referer': 'https://www.linkedin.com/search/results/content/',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'x-li-lang': 'en_US',
        'x-li-page-instance': `urn:li:page:d_flagship3_search_srp_content;${Math.random().toString(36).slice(2)}`,
        'x-li-track': JSON.stringify({
            clientVersion: '1.13.15630',
            mpVersion: '1.13.15630',
            osName: 'web',
            timezoneOffset: 5.5,
            timezone: 'Asia/Kolkata',
            deviceFormFactor: 'DESKTOP',
            mpName: 'voyager-web',
            displayDensity: 2,
            displayWidth: 1920,
            displayHeight: 1080,
        }),
        'x-restli-protocol-version': '2.0.0',
    };
}

function extractPostsFromVoyagerResponse(data: any, keyword: string): PostResult[] {
    const results: PostResult[] = [];
    const now = new Date().toISOString();

    try {
        const elements = data?.elements ?? [];

        for (const element of elements) {
            const items = element?.items ?? [];

            for (const item of items) {
                const entity =
                    item?.item?.entityResult ??
                    item?.item?.contentResult ??
                    item?.item?.miniProfile;

                if (!entity) continue;

                const trackingUrn: string = entity.trackingUrn ?? '';
                const entityUrn: string = entity.entityUrn ?? '';

                let postUrl = '';

                if (entityUrn.includes('activity')) {
                    const activityId = entityUrn.split(':').pop();
                    postUrl = `https://www.linkedin.com/feed/update/urn:li:activity:${activityId}/`;
                } else if (trackingUrn.includes('activity')) {
                    const activityId = trackingUrn.split(':').pop();
                    postUrl = `https://www.linkedin.com/feed/update/urn:li:activity:${activityId}/`;
                } else if (entity.navigationUrl?.includes('linkedin.com')) {
                    postUrl = entity.navigationUrl;
                }

                if (!postUrl) continue;

                const authorName: string =
                    entity.title?.text ??
                    entity.primarySubtitle?.text ??
                    entity.actor?.name?.text ??
                    entity.name?.text ??
                    'Unknown';

                results.push({
                    author_name: authorName,
                    keyword,
                    post_url: postUrl,
                    scraped_at: now,
                });
            }
        }
    } catch (err) {
        log.warning(`Failed to parse Voyager response for keyword "${keyword}": ${err}`);
    }

    return results;
}

// ─── Build requests ───────────────────────────────────────────────────────────

function buildRequests(keywords: string[], limit: number, li_at: string, dateFilter: string) {
    const requests = [];
    const pages = Math.ceil(limit / 10);

    for (const keyword of keywords) {
        for (let page = 0; page < pages; page++) {
            requests.push({
                url: buildVoyagerUrl(keyword, page * 10, dateFilter),
                headers: buildLinkedInHeaders(li_at),
                userData: { keyword, page, limit },
            });
        }
    }

    return requests;
}

// ─── HTTP Crawler (fast, API-based) ──────────────────────────────────────────

async function runHttpCrawler(
    input: Input,
    keywordCounts: Record<string, number>,
    seenUrls: Set<string>,
    proxyConfiguration: any,
    dateFilter: string,
) {
    const crawler = new HttpCrawler({
        proxyConfiguration,
        maxRequestRetries: 3,
        requestHandlerTimeoutSecs: 30,
        maxConcurrency: 2,

        async requestHandler({ request, body }) {
            const { keyword, limit: kwLimit } = request.userData as {
                keyword: string;
                limit: number;
            };

            let data: any;
            try {
                data = JSON.parse(body.toString());
            } catch {
                log.warning(
                    `Non-JSON response for keyword "${keyword}" — possible auth failure or rate limit`,
                );
                return;
            }

            if (data?.status === 401 || data?.message?.toLowerCase().includes('auth')) {
                throw new Error(
                    'LinkedIn authentication failed. Your li_at cookie may be expired. Please refresh it.',
                );
            }

            const posts = extractPostsFromVoyagerResponse(data, keyword);
            log.info(
                `[HTTP] Keyword "${keyword}" page ${request.userData.page} — got ${posts.length} posts`,
            );

            if (posts.length === 0) {
                log.info(`[HTTP] No more results for "${keyword}" — stopping pagination`);
                return;
            }

            for (const post of posts) {
                if (keywordCounts[keyword] >= kwLimit) break;
                if (seenUrls.has(post.post_url)) continue;
                seenUrls.add(post.post_url);
                await Dataset.pushData(post);
                keywordCounts[keyword]++;
            }
        },

        failedRequestHandler({ request, error }) {
            log.error(`Request failed: ${request.url} — ${(error as Error).message}`);
        },
    });

    const requests = buildRequests(input.keywords, input.limit ?? 50, input.li_at, dateFilter);
    await crawler.run(requests);
}

// ─── Playwright Crawler (browser-based fallback) ──────────────────────────────

async function runPlaywrightCrawler(
    input: Input,
    keywordCounts: Record<string, number>,
    seenUrls: Set<string>,
    proxyConfiguration: any,
    dateFilter: string,
) {
    const crawler = new PlaywrightCrawler({
        proxyConfiguration,
        maxRequestRetries: 2,
        requestHandlerTimeoutSecs: 60,
        maxConcurrency: 1,
        launchContext: {
            launchOptions: {
                headless: true,
            },
        },

        async requestHandler({ request, page }) {
            const { keyword } = request.userData as { keyword: string; limit: number };
            const kwLimit = input.limit ?? 50;

            log.info(`[Playwright] Searching for keyword: "${keyword}"`);

            // Set LinkedIn cookie
            await page.context().addCookies([
                {
                    name: 'li_at',
                    value: input.li_at,
                    domain: '.linkedin.com',
                    path: '/',
                    httpOnly: true,
                    secure: true,
                },
            ]);

            await page.goto(buildLinkedInSearchUrl(keyword, dateFilter), {
                waitUntil: 'networkidle',
                timeout: 30000,
            });

            // Check if logged in
            const isLoggedIn = await page.$('.search-results-container, .search-no-results__container');
            if (!isLoggedIn) {
                log.warning('LinkedIn login check failed — li_at cookie may be expired');
                return;
            }

            const now = new Date().toISOString();
            let collected = 0;

            while (collected < kwLimit) {
                // Extract post links from current page
                const postLinks = await page.$$eval(
                    'a[href*="/feed/update/"], a[href*="/posts/"]',
                    (links) =>
                        links
                            .map((a) => (a as HTMLAnchorElement).href)
                            .filter(
                                (href) =>
                                    href.includes('/feed/update/') || href.includes('/posts/'),
                            ),
                );

                // Extract author names
                const authorElements = await page.$$eval(
                    '.update-components-actor__name, .entity-result__title-text a, .app-aware-link span[aria-hidden="true"]',
                    (els) => els.map((el) => el.textContent?.trim() ?? 'Unknown'),
                );

                for (let i = 0; i < postLinks.length; i++) {
                    if (collected >= kwLimit) break;
                    const postUrl = postLinks[i];
                    if (!postUrl || seenUrls.has(postUrl)) continue;
                    seenUrls.add(postUrl);

                    await Dataset.pushData({
                        author_name: authorElements[i] ?? 'Unknown',
                        keyword,
                        post_url: postUrl,
                        scraped_at: now,
                    } as PostResult);

                    keywordCounts[keyword]++;
                    collected++;
                }

                // Scroll to load more
                const prevCount = postLinks.length;
                await page.evaluate(() => window.scrollBy(0, window.innerHeight * 3));
                await page.waitForTimeout(2000);

                const newLinks = await page.$$('a[href*="/feed/update/"], a[href*="/posts/"]');
                if (newLinks.length === prevCount) break; // No new content
            }

            log.info(`[Playwright] Keyword "${keyword}" — scraped ${collected} posts`);
        },

        failedRequestHandler({ request, error }) {
            log.error(`Playwright request failed: ${request.url} — ${(error as Error).message}`);
        },
    });

    // One request per keyword for Playwright (it scrolls internally)
    const requests = input.keywords.map((keyword) => ({
        url: buildLinkedInSearchUrl(keyword, dateFilter),
        userData: { keyword, limit: input.limit ?? 50 },
    }));

    await crawler.run(requests);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

await Actor.main(async () => {
    const input = (await Actor.getInput<Input>())!;

    // Validate inputs
    if (!input?.keywords?.length) {
        throw new Error('Input must include at least one keyword.');
    }
    if (!input?.li_at) {
        throw new Error(
            'LinkedIn li_at cookie is required. Find it in DevTools > Application > Cookies > linkedin.com > li_at',
        );
    }

    const limit = input.limit ?? 50;
    const usePlaywright = input.use_playwright ?? false;
    const dateFilter = resolveLinkedInDateFilter(input);

    log.info('='.repeat(60));
    log.info('LinkedIn Keyword Posts Scraper');
    log.info(`Keywords: ${input.keywords.join(', ')}`);
    log.info(`Limit per keyword: ${limit}`);
    log.info(`Mode: ${usePlaywright ? 'Playwright (browser)' : 'HTTP (Voyager API)'}`);
    log.info(`Date filter: ${dateFilter || 'none (all time)'}`);
    log.info('='.repeat(60));

    // Proxy configuration
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
        log.info(`Using ${input.proxy.proxyUrls.length} custom proxy URL(s)`);
    } else {
        log.warning('No proxy configured — LinkedIn may rate limit or block requests at scale');
    }

    // Per-keyword result tracking + deduplication
    const keywordCounts: Record<string, number> = {};
    for (const kw of input.keywords) keywordCounts[kw] = 0;
    const seenUrls = new Set<string>();

    // Run the appropriate crawler
    if (usePlaywright) {
        await runPlaywrightCrawler(input, keywordCounts, seenUrls, proxyConfiguration, dateFilter);
    } else {
        await runHttpCrawler(input, keywordCounts, seenUrls, proxyConfiguration, dateFilter);
    }

    // Final summary
    const total = Object.values(keywordCounts).reduce((a, b) => a + b, 0);

    log.info('='.repeat(60));
    log.info(`Scrape complete. Total posts: ${total}`);
    for (const [kw, count] of Object.entries(keywordCounts)) {
        log.info(`  "${kw}": ${count} posts`);
    }
    log.info('='.repeat(60));

    await Actor.setValue('OUTPUT_SUMMARY', {
        total_posts: total,
        keywords: keywordCounts,
        mode: usePlaywright ? 'playwright' : 'http',
        completed_at: new Date().toISOString(),
    });
});
