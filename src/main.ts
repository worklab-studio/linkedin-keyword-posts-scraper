import { Actor } from 'apify';
import { Dataset, log, CheerioCrawler } from 'crawlee';

interface Input {
    keywords: string[];
    date?: string;
    from?: string;
    to?: string;
    limit?: number;
    li_at?: string;
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

// Map date presets to Google's tbs param
const DATE_TO_GOOGLE_TBS: Record<string, string> = {
    'last-1-day': 'qdr:d',
    'last-3-days': 'qdr:d3',
    'last-1-week': 'qdr:w',
    'last-2-weeks': 'qdr:w2',
    'last-1-month': 'qdr:m',
    'last-2-months': 'qdr:m2',
    'last-3-months': 'qdr:m3',
    'last-6-months': 'qdr:m6',
    'last-1-year': 'qdr:y',
};

function resolveGoogleTbs(input: Input): string {
    if (input.date && input.date !== 'ignore') {
        return DATE_TO_GOOGLE_TBS[input.date] ?? '';
    }
    if (input.from || input.to) {
        const now = Date.now();
        const start = input.from ? new Date(input.from).getTime() : now - 180 * 86400000;
        const days = (now - start) / 86400000;
        if (days <= 1) return 'qdr:d';
        if (days <= 7) return 'qdr:w';
        if (days <= 30) return 'qdr:m';
        if (days <= 90) return 'qdr:m3';
        if (days <= 180) return 'qdr:m6';
        return 'qdr:y';
    }
    return 'qdr:w'; // Default: past week
}

function buildGoogleSearchUrl(keyword: string, tbs: string, start: number = 0): string {
    const query = `site:linkedin.com/posts "${keyword}"`;
    let url = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=10`;
    if (tbs) url += `&tbs=${tbs}`;
    if (start > 0) url += `&start=${start}`;
    return url;
}

function extractLinkedInPostsFromGoogle(html: string): { url: string; author: string }[] {
    const results: { url: string; author: string }[] = [];
    const seen = new Set<string>();

    // Google results contain LinkedIn post URLs in various formats
    // Match linkedin.com/posts/username_slug patterns
    const urlRegex = /https?:\/\/(?:www\.)?linkedin\.com\/posts\/[a-zA-Z0-9_-]+_[a-zA-Z0-9_-]+/g;
    let match;
    while ((match = urlRegex.exec(html)) !== null) {
        let postUrl = match[0].split('&')[0].split('"')[0]; // Clean up trailing params
        if (seen.has(postUrl)) continue;
        seen.add(postUrl);

        // Extract author from URL: /posts/firstname-lastname_slug
        const authorMatch = postUrl.match(/\/posts\/([a-zA-Z0-9_-]+?)_/);
        let author = 'Unknown';
        if (authorMatch) {
            author = authorMatch[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        }

        results.push({ url: postUrl, author });
    }

    // Also match /feed/update/ URLs
    const feedRegex = /https?:\/\/(?:www\.)?linkedin\.com\/feed\/update\/urn:li:activity:(\d+)/g;
    while ((match = feedRegex.exec(html)) !== null) {
        const postUrl = `https://www.linkedin.com/feed/update/urn:li:activity:${match[1]}/`;
        if (seen.has(postUrl)) continue;
        seen.add(postUrl);
        results.push({ url: postUrl, author: 'Unknown' });
    }

    return results;
}

await Actor.main(async () => {
    const input = (await Actor.getInput<Input>())!;
    if (!input?.keywords?.length) throw new Error('Input must include at least one keyword.');

    const limit = input.limit ?? 50;
    const tbs = resolveGoogleTbs(input);

    log.info('='.repeat(60));
    log.info('LinkedIn Keyword Posts Scraper (via Google Search)');
    log.info(`Keywords: ${input.keywords.join(', ')}`);
    log.info(`Limit per keyword: ${limit}`);
    log.info(`Time filter: ${tbs || 'none'}`);
    log.info('='.repeat(60));

    // Proxy config
    let proxyConfiguration: any = undefined;
    if (input.proxy?.useApifyProxy) {
        proxyConfiguration = await Actor.createProxyConfiguration({
            groups: input.proxy.apifyProxyGroups ?? ['GOOGLE_SERP'],
        });
        log.info('Using Apify proxy');
    } else if (input.proxy?.proxyUrls?.length) {
        proxyConfiguration = await Actor.createProxyConfiguration({
            proxyUrls: input.proxy.proxyUrls,
        });
    }

    const keywordCounts: Record<string, number> = {};
    for (const kw of input.keywords) keywordCounts[kw] = 0;
    const seenUrls = new Set<string>();

    // Build all requests
    const requests: { url: string; userData: { keyword: string } }[] = [];
    for (const keyword of input.keywords) {
        const pages = Math.ceil(limit / 10);
        for (let p = 0; p < pages; p++) {
            requests.push({
                url: buildGoogleSearchUrl(keyword, tbs, p * 10),
                userData: { keyword },
            });
        }
    }

    const crawler = new CheerioCrawler({
        proxyConfiguration,
        maxRequestRetries: 3,
        requestHandlerTimeoutSecs: 30,
        maxConcurrency: 1,

        async requestHandler({ request, body }) {
            const { keyword } = request.userData as { keyword: string };
            const html = body.toString();

            // Check if Google blocked us
            if (html.includes('detected unusual traffic') || html.includes('CAPTCHA')) {
                log.warning(`Google CAPTCHA for "${keyword}" — retrying with different proxy`);
                throw new Error('Google CAPTCHA detected');
            }

            const posts = extractLinkedInPostsFromGoogle(html);
            log.info(`Google page for "${keyword}": found ${posts.length} LinkedIn posts`);

            const now = new Date().toISOString();
            for (const post of posts) {
                if (keywordCounts[keyword] >= limit) break;
                if (seenUrls.has(post.url)) continue;
                seenUrls.add(post.url);

                await Dataset.pushData({
                    author_name: post.author,
                    keyword,
                    post_url: post.url,
                    scraped_at: now,
                } as PostResult);

                keywordCounts[keyword]++;
            }
        },

        failedRequestHandler({ request, error }) {
            log.error(`Failed: ${request.url.slice(0, 100)} — ${(error as Error).message}`);
        },
    });

    await crawler.run(requests);

    const total = Object.values(keywordCounts).reduce((a, b) => a + b, 0);
    log.info('='.repeat(60));
    log.info(`Done. Total: ${total} posts`);
    for (const [kw, count] of Object.entries(keywordCounts)) log.info(`  "${kw}": ${count}`);
    log.info('='.repeat(60));

    await Actor.setValue('OUTPUT_SUMMARY', { total_posts: total, keywords: keywordCounts, completed_at: new Date().toISOString() });
});
