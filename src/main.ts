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

// ─── LinkedIn API ─────────────────────────────────────────────────────────────

const JSESSIONID = `ajax:${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`.slice(0, 24);

function getHeaders(li_at: string, accept: string): Record<string, string> {
    return {
        'accept': accept,
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

// Build GraphQL search URL
function buildGraphqlUrl(keyword: string, start: number, dateFilter: string): string {
    const filters: string[] = ['(key:resultType,value:List(CONTENT))'];
    if (dateFilter) {
        filters.push(`(key:datePosted,value:List(${dateFilter}))`);
    }
    const queryParameters = `List(${filters.join(',')})`;
    const variables = `(start:${start},count:10,origin:GLOBAL_SEARCH_HEADER,query:(keywords:${encodeURIComponent(keyword)},flagshipSearchIntent:SEARCH_SRP,queryParameters:${queryParameters},includeFiltersInResponse:false))`;
    const queryId = 'voyagerSearchDashClusters.b0928897b71bd00a5a7291755dcd64f0';
    return `https://www.linkedin.com/voyager/api/graphql?variables=${variables}&queryId=${queryId}&includeWebMetadata=true`;
}

// Build HTML search page URL
function buildSearchPageUrl(keyword: string, dateFilter: string): string {
    let url = `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(keyword)}&origin=GLOBAL_SEARCH_HEADER&sortBy=%22date_posted%22`;
    if (dateFilter) {
        url += `&datePosted=%22${dateFilter}%22`;
    }
    return url;
}

async function tryApproach(
    name: string,
    url: string,
    headers: Record<string, string>,
    keyword: string,
    dateFilter: string,
): Promise<PostResult[]> {
    log.info(`[${name}] Trying: ${url.slice(0, 120)}...`);
    try {
        const res = await fetch(url, { headers, redirect: 'follow' });
        const text = await res.text();
        log.info(`[${name}] Status: ${res.status}, Size: ${text.length}, Content-Type: ${res.headers.get('content-type')}`);

        if (!res.ok) {
            log.warning(`[${name}] Failed: HTTP ${res.status}`);
            return [];
        }

        // Try to parse as JSON
        let data: any;
        try {
            data = JSON.parse(text);
        } catch {
            // Not JSON — treat as HTML
            return extractPostsFromHtml(text, keyword);
        }

        // Log response structure
        const topKeys = Object.keys(data);
        log.info(`[${name}] Response keys: ${JSON.stringify(topKeys)}`);

        if (data.included && Array.isArray(data.included)) {
            log.info(`[${name}] Included: ${data.included.length} items`);
            const types = [...new Set(data.included.map((i: any) => i.$type).filter(Boolean))];
            log.info(`[${name}] Types: ${JSON.stringify(types.slice(0, 10))}`);
        }

        // Try to find search results in various paths
        const searchResult =
            data?.data?.data?.searchDashClustersByAll ??
            data?.data?.searchDashClustersByAll ??
            data?.searchDashClustersByAll;

        if (searchResult) {
            log.info(`[${name}] Found clusters! Total: ${searchResult.metadata?.totalResultCount}`);
            return extractPostsFromClusters(searchResult, data?.included ?? [], keyword);
        }

        // Check for elements directly (REST format)
        if (data?.elements) {
            log.info(`[${name}] Found elements directly: ${data.elements.length}`);
            return extractPostsFromElements(data.elements, data?.included ?? [], keyword);
        }

        log.info(`[${name}] No recognized data structure. First 500 chars: ${JSON.stringify(data).slice(0, 500)}`);
        return [];
    } catch (err) {
        log.warning(`[${name}] Error: ${(err as Error).message}`);
        return [];
    }
}

// Extract posts from GraphQL cluster response
function extractPostsFromClusters(searchResult: any, included: any[], keyword: string): PostResult[] {
    const results: PostResult[] = [];
    const now = new Date().toISOString();
    const includedMap = buildIncludedMap(included);

    for (const cluster of searchResult.elements ?? []) {
        for (const searchItem of cluster.items ?? []) {
            const item = searchItem?.item;
            if (!item) continue;

            let entity = item.entityResult;

            // Try resolving URN reference (Rest.li normalized format uses * prefix)
            if (!entity && item['*entityResult']) {
                entity = includedMap.get(item['*entityResult']);
            }

            if (!entity) continue;

            const post = entityToPost(entity, keyword, now, includedMap);
            if (post) results.push(post);
        }
    }

    // Fallback: scan included for activities
    if (results.length === 0) {
        log.info('Clusters had no entities, scanning included array...');
        return extractPostsFromIncluded(included, keyword);
    }

    return results;
}

// Extract posts from REST elements response
function extractPostsFromElements(elements: any[], included: any[], keyword: string): PostResult[] {
    const results: PostResult[] = [];
    const now = new Date().toISOString();
    const includedMap = buildIncludedMap(included);

    for (const el of elements) {
        // Could be the element itself or nested items
        if (el.items) {
            for (const searchItem of el.items) {
                const entity = searchItem?.item?.entityResult ?? searchItem?.entityResult ?? searchItem;
                const post = entityToPost(entity, keyword, now, includedMap);
                if (post) results.push(post);
            }
        } else {
            const post = entityToPost(el, keyword, now, includedMap);
            if (post) results.push(post);
        }
    }

    if (results.length === 0) {
        return extractPostsFromIncluded(included, keyword);
    }

    return results;
}

// Extract posts from included array directly
function extractPostsFromIncluded(included: any[], keyword: string): PostResult[] {
    const results: PostResult[] = [];
    const now = new Date().toISOString();
    const seen = new Set<string>();

    for (const item of included) {
        const urn = item.entityUrn ?? item['$id'] ?? '';
        if (!urn.includes('activity') && !urn.includes('ugcPost')) continue;

        const activityId = urn.split(':').pop();
        if (!activityId) continue;

        const postUrl = urn.includes('activity')
            ? `https://www.linkedin.com/feed/update/urn:li:activity:${activityId}/`
            : `https://www.linkedin.com/feed/update/urn:li:ugcPost:${activityId}/`;

        if (seen.has(postUrl)) continue;
        seen.add(postUrl);

        const authorName =
            item.actorName ?? item.actor?.name?.text ?? item.title?.text ??
            item.name?.text ?? item.firstName ? `${item.firstName} ${item.lastName}` : 'Unknown';

        results.push({ author_name: authorName, keyword, post_url: postUrl, scraped_at: now });
    }

    log.info(`Found ${results.length} posts from included array`);
    return results;
}

function buildIncludedMap(included: any[]): Map<string, any> {
    const map = new Map<string, any>();
    for (const item of included) {
        const key = item.entityUrn ?? item['$id'];
        if (key) map.set(key, item);
    }
    return map;
}

function entityToPost(entity: any, keyword: string, now: string, includedMap: Map<string, any>): PostResult | null {
    if (!entity) return null;

    const trackingUrn: string = entity.trackingUrn ?? '';
    const entityUrn: string = entity.entityUrn ?? '';

    let postUrl = '';
    if (entityUrn.includes('activity')) {
        postUrl = `https://www.linkedin.com/feed/update/urn:li:activity:${entityUrn.split(':').pop()}/`;
    } else if (trackingUrn.includes('activity')) {
        postUrl = `https://www.linkedin.com/feed/update/urn:li:activity:${trackingUrn.split(':').pop()}/`;
    } else if (entity.navigationUrl?.includes('linkedin.com')) {
        postUrl = entity.navigationUrl;
    }

    if (!postUrl) return null;

    const authorName: string =
        entity.title?.text ?? entity.primarySubtitle?.text ?? entity.summary?.text ?? 'Unknown';

    return { author_name: authorName, keyword, post_url: postUrl, scraped_at: now };
}

// Extract activity URNs from HTML
function extractPostsFromHtml(html: string, keyword: string): PostResult[] {
    const results: PostResult[] = [];
    const now = new Date().toISOString();
    const seen = new Set<string>();

    const urnRegex = /urn:li:(activity|ugcPost):(\d+)/g;
    let match;
    while ((match = urnRegex.exec(html)) !== null) {
        const [fullUrn, type, id] = match;
        const postUrl = `https://www.linkedin.com/feed/update/${fullUrn}/`;
        if (seen.has(postUrl)) continue;
        seen.add(postUrl);
        results.push({ author_name: 'Unknown', keyword, post_url: postUrl, scraped_at: now });
    }

    return results;
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
        let allPosts: PostResult[] = [];
        let start = 0;

        // Try paginated API calls first
        while (allPosts.length < limit && start < limit * 2) {
            const apiUrl = buildGraphqlUrl(keyword, start, dateFilter);
            const apiHeaders = getHeaders(input.li_at, 'application/vnd.linkedin.normalized+json+2.1');
            const apiPosts = await tryApproach(`API-${keyword}-p${start}`, apiUrl, apiHeaders, keyword, dateFilter);

            if (apiPosts.length > 0) {
                const newPosts = apiPosts.filter(p => !seenUrls.has(p.post_url));
                if (newPosts.length === 0) {
                    log.info(`No new posts at start=${start}, stopping pagination`);
                    break;
                }
                allPosts.push(...newPosts);
                for (const p of newPosts) seenUrls.add(p.post_url);
            } else if (start === 0) {
                // API returned nothing on first page, try HTML fallback
                log.info('API returned no posts, trying HTML fallback...');
                const htmlUrl = buildSearchPageUrl(keyword, dateFilter);
                const htmlHeaders = getHeaders(input.li_at, 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
                const htmlPosts = await tryApproach(`HTML-${keyword}`, htmlUrl, htmlHeaders, keyword, dateFilter);
                allPosts.push(...htmlPosts.filter(p => !seenUrls.has(p.post_url)));
                for (const p of allPosts) seenUrls.add(p.post_url);
                break;
            } else {
                break;
            }

            start += 10;
            await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
        }

        // Push results
        for (const post of allPosts) {
            if (keywordCounts[keyword] >= limit) break;
            await Dataset.pushData(post);
            keywordCounts[keyword]++;
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
