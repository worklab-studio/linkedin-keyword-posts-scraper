import { Actor } from 'apify';
import { Dataset, log, CheerioCrawler } from 'crawlee';

interface Input {
    keywords: string[];
    date?: string;
    from?: string;
    to?: string;
    limit?: number;
    proxy?: {
        useApifyProxy?: boolean;
        apifyProxyGroups?: string[];
        proxyUrls?: string[];
    };
}

interface PostResult {
    author_name: string;
    author_headline: string;
    author_profile: string;
    keyword: string;
    post_url: string;
    post_text: string;
    reactions: number;
    comments: number;
    scraped_at: string;
}

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
    if (input.date && input.date !== 'ignore') return DATE_TO_GOOGLE_TBS[input.date] ?? '';
    if (input.from) {
        const days = (Date.now() - new Date(input.from).getTime()) / 86400000;
        if (days <= 1) return 'qdr:d';
        if (days <= 7) return 'qdr:w';
        if (days <= 30) return 'qdr:m';
        if (days <= 90) return 'qdr:m3';
        return 'qdr:m6';
    }
    return 'qdr:w';
}

function buildGoogleUrl(keyword: string, tbs: string, start: number = 0): string {
    const q = `site:linkedin.com/posts "${keyword}"`;
    // Use &gbv=1 to force basic HTML mode (no JavaScript rendering needed)
    let url = `https://www.google.com/search?q=${encodeURIComponent(q)}&num=10&gbv=1&sei=1`;
    if (tbs) url += `&tbs=${tbs}`;
    if (start > 0) url += `&start=${start}`;
    return url;
}

function extractLinkedInUrls(html: string): string[] {
    const urls: string[] = [];
    const seen = new Set<string>();

    // Match linkedin.com/posts/author_slug-hash patterns
    const regex = /https?:\/\/(?:www\.)?linkedin\.com\/posts\/[a-zA-Z0-9_-]+_[a-zA-Z0-9_-]+/g;
    let m;
    while ((m = regex.exec(html)) !== null) {
        let url = m[0].split('&')[0].split('"')[0].split("'")[0];
        if (!seen.has(url)) { seen.add(url); urls.push(url); }
    }

    // Also match /feed/update/ URLs
    const feedRegex = /https?:\/\/(?:www\.)?linkedin\.com\/feed\/update\/urn:li:activity:(\d+)/g;
    while ((m = feedRegex.exec(html)) !== null) {
        const url = `https://www.linkedin.com/feed/update/urn:li:activity:${m[1]}/`;
        if (!seen.has(url)) { seen.add(url); urls.push(url); }
    }

    return urls;
}

// Parse a public LinkedIn post page for engagement data
function parsePostPage(html: string): { author: string; headline: string; profileUrl: string; text: string; reactions: number; comments: number } {
    let author = 'Unknown';
    let headline = '';
    let profileUrl = '';
    let text = '';
    let reactions = 0;
    let comments = 0;

    // Author name from meta og tags or page content
    const ogTitleMatch = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)
        ?? html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:title"/i);
    if (ogTitleMatch) {
        // "Author Name on LinkedIn: post preview..."
        const parts = ogTitleMatch[1].split(' on LinkedIn');
        if (parts[0]) author = parts[0].trim();
    }

    // Post text from og:description
    const ogDescMatch = html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i)
        ?? html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:description"/i);
    if (ogDescMatch) {
        text = ogDescMatch[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
    }

    // Profile URL
    const profileMatch = html.match(/https?:\/\/(?:www\.)?linkedin\.com\/in\/[a-zA-Z0-9_-]+/);
    if (profileMatch) profileUrl = profileMatch[0];

    // Reactions count - look for various patterns
    const reactionsMatch = html.match(/(\d[\d,]*)\s*(?:reactions?|likes?)/i);
    if (reactionsMatch) reactions = parseInt(reactionsMatch[1].replace(/,/g, ''), 10) || 0;

    // Comments count
    const commentsMatch = html.match(/(\d[\d,]*)\s*comments?/i);
    if (commentsMatch) comments = parseInt(commentsMatch[1].replace(/,/g, ''), 10) || 0;

    // Headline from meta description or page content
    const headlineMatch = html.match(/class="[^"]*top-card-layout__headline[^"]*"[^>]*>([^<]+)/i);
    if (headlineMatch) headline = headlineMatch[1].trim();

    return { author, headline, profileUrl, text, reactions, comments };
}

await Actor.main(async () => {
    const input = (await Actor.getInput<Input>())!;
    if (!input?.keywords?.length) throw new Error('Input must include at least one keyword.');

    const limit = input.limit ?? 50;
    const tbs = resolveGoogleTbs(input);

    log.info('='.repeat(60));
    log.info('LinkedIn Keyword Posts Scraper');
    log.info(`Keywords: ${input.keywords.join(', ')}`);
    log.info(`Limit per keyword: ${limit}`);
    log.info(`Time filter: ${tbs || 'none'}`);
    log.info('='.repeat(60));

    let proxyConfiguration: any = undefined;
    if (input.proxy?.useApifyProxy) {
        proxyConfiguration = await Actor.createProxyConfiguration({
            groups: input.proxy.apifyProxyGroups ?? ['RESIDENTIAL'],
        });
        log.info('Using Apify proxy');
    } else if (input.proxy?.proxyUrls?.length) {
        proxyConfiguration = await Actor.createProxyConfiguration({ proxyUrls: input.proxy.proxyUrls });
    }

    const keywordCounts: Record<string, number> = {};
    for (const kw of input.keywords) keywordCounts[kw] = 0;
    const seenUrls = new Set<string>();

    // Collected post URLs per keyword
    const postUrlsByKeyword: Record<string, string[]> = {};
    for (const kw of input.keywords) postUrlsByKeyword[kw] = [];

    // Step 1: Google SERP to find LinkedIn post URLs
    log.info('Step 1: Searching Google for LinkedIn posts...');
    const googleRequests: { url: string; userData: { keyword: string } }[] = [];
    for (const keyword of input.keywords) {
        const pages = Math.ceil(limit / 10);
        for (let p = 0; p < pages; p++) {
            googleRequests.push({
                url: buildGoogleUrl(keyword, tbs, p * 10),
                userData: { keyword },
            });
        }
    }

    const googleCrawler = new CheerioCrawler({
        proxyConfiguration,
        maxRequestRetries: 3,
        requestHandlerTimeoutSecs: 30,
        maxConcurrency: 1,
        preNavigationHooks: [
            (_ctx, goToOptions) => {
                goToOptions.headerGeneratorOptions = {
                    browsers: [{ name: 'chrome', minVersion: 120 }],
                    operatingSystems: ['windows'],
                };
            },
        ],

        async requestHandler({ request, body }) {
            const { keyword } = request.userData as { keyword: string };
            const html = body.toString();

            log.info(`Google response: ${html.length} chars`);

            if (html.includes('detected unusual traffic') || html.includes('CAPTCHA')) {
                log.warning('Google CAPTCHA detected');
                throw new Error('Google CAPTCHA');
            }

            // Log a sample to understand what Google returned
            if (html.length < 5000) {
                log.info(`Short response — might be blocked: ${html.slice(0, 500)}`);
            }

            // Log if linkedin.com appears at all
            const linkedinMentions = (html.match(/linkedin\.com/g) || []).length;
            log.info(`LinkedIn mentions in HTML: ${linkedinMentions}`);

            // Log first 1000 chars to understand what Google returned
            log.info(`HTML sample: ${html.slice(0, 1000)}`);

            // Check for Google consent page
            if (html.includes('consent.google') || html.includes('Before you continue')) {
                log.warning('Google consent page detected — need to handle cookies');
            }

            const urls = extractLinkedInUrls(html);
            log.info(`Google: "${keyword}" → ${urls.length} post URLs`);

            for (const url of urls) {
                if (postUrlsByKeyword[keyword].length >= limit) break;
                if (seenUrls.has(url)) continue;
                seenUrls.add(url);
                postUrlsByKeyword[keyword].push(url);
            }
        },

        failedRequestHandler({ request, error }) {
            log.error(`Google failed: ${(error as Error).message}`);
        },
    });

    await googleCrawler.run(googleRequests);

    const totalUrls = Object.values(postUrlsByKeyword).reduce((a, b) => a + b.length, 0);
    log.info(`Step 1 done: ${totalUrls} total post URLs found`);

    // Step 2: Fetch each LinkedIn post page for details
    log.info('Step 2: Fetching LinkedIn post pages for details...');

    // Use RESIDENTIAL proxy for LinkedIn pages (not GOOGLE_SERP)
    let linkedinProxy: any = undefined;
    if (input.proxy?.useApifyProxy) {
        linkedinProxy = await Actor.createProxyConfiguration({
            groups: ['RESIDENTIAL'],
        });
    }

    const postRequests: { url: string; userData: { keyword: string } }[] = [];
    for (const [keyword, urls] of Object.entries(postUrlsByKeyword)) {
        for (const url of urls) {
            postRequests.push({ url, userData: { keyword } });
        }
    }

    if (postRequests.length > 0) {
        const postCrawler = new CheerioCrawler({
            proxyConfiguration: linkedinProxy ?? proxyConfiguration,
            maxRequestRetries: 2,
            requestHandlerTimeoutSecs: 30,
            maxConcurrency: 3,
            additionalMimeTypes: ['application/octet-stream'],

            async requestHandler({ request, body }) {
                const { keyword } = request.userData as { keyword: string };
                const html = body.toString();
                const parsed = parsePostPage(html);
                const now = new Date().toISOString();

                // Fallback author from URL if not found in page
                if (parsed.author === 'Unknown') {
                    const m = request.url.match(/\/posts\/([a-zA-Z0-9_-]+?)_/);
                    if (m) parsed.author = m[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
                }

                await Dataset.pushData({
                    author_name: parsed.author,
                    author_headline: parsed.headline,
                    author_profile: parsed.profileUrl,
                    keyword,
                    post_url: request.url,
                    post_text: parsed.text.slice(0, 500),
                    reactions: parsed.reactions,
                    comments: parsed.comments,
                    scraped_at: now,
                } as PostResult);

                keywordCounts[keyword]++;
                log.info(`✓ ${parsed.author} | ${parsed.reactions} reactions | ${request.url.slice(0, 80)}...`);
            },

            failedRequestHandler({ request, error }) {
                log.warning(`Failed to fetch post: ${request.url.slice(0, 80)} — ${(error as Error).message}`);
            },
        });

        await postCrawler.run(postRequests);
    }

    const total = Object.values(keywordCounts).reduce((a, b) => a + b, 0);
    log.info('='.repeat(60));
    log.info(`Done. Total: ${total} posts`);
    for (const [kw, count] of Object.entries(keywordCounts)) log.info(`  "${kw}": ${count}`);
    log.info('='.repeat(60));

    await Actor.setValue('OUTPUT_SUMMARY', { total_posts: total, keywords: keywordCounts, completed_at: new Date().toISOString() });
});
