import { Actor } from 'apify';
import { Dataset, log } from 'crawlee';

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

// ─── LinkedIn helpers ─────────────────────────────────────────────────────────

const JSESSIONID = `ajax:${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`.slice(0, 24);

function buildSearchPageUrl(keyword: string, start: number, dateFilter: string): string {
    let url = `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(keyword)}&origin=GLOBAL_SEARCH_HEADER&sortBy=%22date_posted%22&start=${start}`;
    if (dateFilter) {
        url += `&datePosted=%22${dateFilter}%22`;
    }
    return url;
}

function getPageHeaders(li_at: string): Record<string, string> {
    return {
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'cookie': `li_at=${li_at}; JSESSIONID="${JSESSIONID}"`,
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'same-origin',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    };
}

function getApiHeaders(li_at: string): Record<string, string> {
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

// Extract embedded JSON data from LinkedIn's SSR HTML
// LinkedIn embeds initial state in <code> tags with specific formats
function extractPostsFromHtml(html: string, keyword: string): PostResult[] {
    const results: PostResult[] = [];
    const now = new Date().toISOString();
    const seen = new Set<string>();

    // Method 1: Extract activity URNs from the HTML directly
    // LinkedIn embeds post URNs in various attributes and embedded JSON
    const activityRegex = /urn:li:activity:(\d+)/g;
    let match;
    while ((match = activityRegex.exec(html)) !== null) {
        const activityId = match[1];
        const postUrl = `https://www.linkedin.com/feed/update/urn:li:activity:${activityId}/`;
        if (!seen.has(postUrl)) {
            seen.add(postUrl);
            results.push({ author_name: 'Unknown', keyword, post_url: postUrl, scraped_at: now });
        }
    }

    // Method 2: Extract ugcPost URNs
    const ugcRegex = /urn:li:ugcPost:(\d+)/g;
    while ((match = ugcRegex.exec(html)) !== null) {
        const postId = match[1];
        const postUrl = `https://www.linkedin.com/feed/update/urn:li:ugcPost:${postId}/`;
        if (!seen.has(postUrl)) {
            seen.add(postUrl);
            results.push({ author_name: 'Unknown', keyword, post_url: postUrl, scraped_at: now });
        }
    }

    // Method 3: Try to extract author names from embedded JSON
    // LinkedIn stores data in <code> elements; try to find and parse them
    const codeBlockRegex = /<code[^>]*>(.*?)<\/code>/gs;
    while ((match = codeBlockRegex.exec(html)) !== null) {
        try {
            const decoded = match[1]
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&amp;/g, '&')
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'");

            // Try to parse as JSON
            const jsonData = JSON.parse(decoded);
            if (jsonData?.included && Array.isArray(jsonData.included)) {
                log.info(`Found embedded JSON with ${jsonData.included.length} included items`);
                enrichResultsFromIncluded(jsonData.included, results);
            }
        } catch {
            // Not valid JSON, skip
        }
    }

    return results;
}

// Enrich results with author names from LinkedIn's included data
function enrichResultsFromIncluded(included: any[], results: PostResult[]): void {
    // Build maps: activityUrn -> author info
    const activityToAuthor = new Map<string, string>();

    for (const item of included) {
        const type = item.$type ?? item['$type'] ?? '';

        // Look for actor/author information linked to activities
        if (type.includes('Update') || type.includes('Activity') || type.includes('Post')) {
            const urn = item.entityUrn ?? item['*entityUrn'] ?? '';
            const authorName =
                item.actorName ??
                item.actor?.name?.text ??
                item.title?.text ??
                '';
            if (urn && authorName) {
                activityToAuthor.set(urn, authorName);
            }
        }

        // MiniProfile type - map profile URN to name
        if (type.includes('MiniProfile') || type.includes('Profile')) {
            const name = [item.firstName, item.lastName].filter(Boolean).join(' ');
            if (name && item.entityUrn) {
                activityToAuthor.set(item.entityUrn, name);
            }
        }
    }

    // Update results with author names where possible
    for (const result of results) {
        const urn = result.post_url.match(/urn:li:(activity|ugcPost):(\d+)/)?.[0];
        if (urn && activityToAuthor.has(`urn:li:fsd_update:(urn:li:${urn},)`)) {
            result.author_name = activityToAuthor.get(`urn:li:fsd_update:(urn:li:${urn},)`)!;
        }
    }
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

    const keywordCounts: Record<string, number> = {};
    for (const kw of input.keywords) keywordCounts[kw] = 0;
    const seenUrls = new Set<string>();

    for (const keyword of input.keywords) {
        const prevCount = keywordCounts[keyword];

        const url = buildSearchPageUrl(keyword, 0, dateFilter);
        log.info(`Fetching "${keyword}"...`);

        try {
            const res = await fetch(url, {
                headers: getPageHeaders(input.li_at),
                redirect: 'follow',
            });

            if (!res.ok) {
                log.warning(`HTTP ${res.status} for "${keyword}" — stopping`);
                continue;
            }

            const html = await res.text();
            log.info(`Got ${html.length} chars of HTML for "${keyword}"`);

            // Check if we're redirected to login
            if (html.includes('/login') && !html.includes('search-results')) {
                log.error('Redirected to login — li_at cookie may be expired');
                continue;
            }

            // Log a sample of the HTML around search results for debugging
            const srIdx = html.indexOf('search-result');
            if (srIdx >= 0) {
                log.info(`Found "search-result" in HTML at pos ${srIdx}`);
                log.info(`HTML sample: ${html.slice(srIdx, srIdx + 500)}`);
            } else {
                log.info('No "search-result" found in HTML');
            }

            // Log embedded <code> blocks count
            const codeMatches = html.match(/<code[^>]*id="bpr-guid/g);
            log.info(`Found ${codeMatches?.length ?? 0} LinkedIn <code> data blocks`);

            const posts = extractPostsFromHtml(html, keyword);
            log.info(`Extracted ${posts.length} unique posts for "${keyword}"`);
            if (posts.length > 0) {
                log.info(`Sample post: ${JSON.stringify(posts[0])}`);
            }

            for (const post of posts) {
                if (keywordCounts[keyword] >= limit) break;
                if (seenUrls.has(post.post_url)) continue;
                seenUrls.add(post.post_url);
                await Dataset.pushData(post);
                keywordCounts[keyword]++;
            }
        } catch (err) {
            log.error(`Fetch error for "${keyword}": ${(err as Error).message}`);
        }

        log.info(`"${keyword}": ${keywordCounts[keyword]} posts collected`);
    }

    const total = Object.values(keywordCounts).reduce((a, b) => a + b, 0);
    log.info('='.repeat(60));
    log.info(`Done. Total: ${total} posts`);
    log.info('='.repeat(60));

    await Actor.setValue('OUTPUT_SUMMARY', {
        total_posts: total,
        keywords: keywordCounts,
        completed_at: new Date().toISOString(),
    });
});
