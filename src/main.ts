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

function getHeaders(li_at: string): Record<string, string> {
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

function buildSearchUrl(keyword: string, start: number, dateFilter: string): string {
    const filters: string[] = ['(key:resultType,value:List(CONTENT))'];
    if (dateFilter) {
        filters.push(`(key:datePosted,value:List(${dateFilter}))`);
    }
    const queryParameters = `List(${filters.join(',')})`;
    const variables = `(start:${start},origin:GLOBAL_SEARCH_HEADER,query:(keywords:${encodeURIComponent(keyword)},flagshipSearchIntent:SEARCH_SRP,queryParameters:${queryParameters},includeFiltersInResponse:false))`;
    const queryId = 'voyagerSearchDashClusters.b0928897b71bd00a5a7291755dcd64f0';
    return `https://www.linkedin.com/voyager/api/graphql?variables=${variables}&queryId=${queryId}&includeWebMetadata=true`;
}

async function fetchLinkedIn(url: string, headers: Record<string, string>): Promise<any> {
    const res = await fetch(url, { headers, redirect: 'follow' });
    const text = await res.text();
    if (!res.ok) {
        log.warning(`HTTP ${res.status} for ${url.slice(0, 100)}...`);
        log.warning(`Response: ${text.slice(0, 500)}`);
        return null;
    }
    try {
        return JSON.parse(text);
    } catch {
        log.warning(`Non-JSON response: ${text.slice(0, 500)}`);
        return null;
    }
}

function extractPosts(data: any, keyword: string): PostResult[] {
    const results: PostResult[] = [];
    const now = new Date().toISOString();

    // Build a lookup map from the 'included' array (LinkedIn's normalized format)
    const includedMap = new Map<string, any>();
    for (const item of data?.included ?? []) {
        if (item.entityUrn || item['$id']) {
            includedMap.set(item.entityUrn ?? item['$id'], item);
        }
    }
    log.info(`Included map size: ${includedMap.size}`);

    // Find clusters in the response - try multiple paths
    const searchResult =
        data?.data?.data?.searchDashClustersByAll ??
        data?.data?.searchDashClustersByAll ??
        data?.searchDashClustersByAll;

    if (!searchResult) {
        log.warning(`Could not find searchDashClustersByAll in response`);
        log.info(`Top keys: ${JSON.stringify(Object.keys(data ?? {}))}`);
        if (data?.data) log.info(`data.data keys: ${JSON.stringify(Object.keys(data.data))}`);
        if (data?.data?.data) log.info(`data.data.data keys: ${JSON.stringify(Object.keys(data.data.data))}`);
        return results;
    }

    log.info(`Total results: ${searchResult.metadata?.totalResultCount}, elements: ${searchResult.elements?.length}`);

    for (const cluster of searchResult.elements ?? []) {
        for (const searchItem of cluster.items ?? []) {
            const item = searchItem?.item;
            if (!item) continue;

            // Try to get entityResult directly or resolve from included map
            let entity = item.entityResult;

            // If entityResult is a string reference (URN), resolve it
            if (typeof entity === 'string') {
                entity = includedMap.get(entity) ?? null;
            }

            // If still null, try to find entity via the item's trackingUrn or other refs
            if (!entity && item['*entityResult']) {
                entity = includedMap.get(item['*entityResult']) ?? null;
            }

            if (!entity) continue;

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

            if (!postUrl) continue;

            const authorName: string =
                entity.title?.text ??
                entity.primarySubtitle?.text ??
                entity.summary?.text ??
                'Unknown';

            results.push({ author_name: authorName, keyword, post_url: postUrl, scraped_at: now });
        }
    }

    // Fallback: if no posts found from clusters, scan included array directly for activities
    if (results.length === 0 && includedMap.size > 0) {
        log.info('Trying fallback: scanning included array for activity URNs...');
        for (const [urn, item] of includedMap) {
            if (urn.includes('activity') || urn.includes('ugcPost')) {
                const activityId = urn.split(':').pop();
                if (!activityId) continue;
                const postUrl = urn.includes('activity')
                    ? `https://www.linkedin.com/feed/update/urn:li:activity:${activityId}/`
                    : `https://www.linkedin.com/feed/update/urn:li:ugcPost:${activityId}/`;
                const authorName = item.actorName ?? item.title?.text ?? item.name?.text ?? 'Unknown';
                results.push({ author_name: authorName, keyword, post_url: postUrl, scraped_at: now });
            }
        }
        log.info(`Fallback found ${results.length} posts from included array`);
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
    const headers = getHeaders(input.li_at);

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
        let start = 0;

        while (keywordCounts[keyword] < limit) {
            const url = buildSearchUrl(keyword, start, dateFilter);
            log.info(`Fetching "${keyword}" start=${start}...`);

            const data = await fetchLinkedIn(url, headers);
            if (!data) {
                log.warning(`No data for "${keyword}" at start=${start}, stopping`);
                break;
            }

            const posts = extractPosts(data, keyword);
            log.info(`"${keyword}" start=${start} — got ${posts.length} posts`);

            if (posts.length === 0) break;

            for (const post of posts) {
                if (keywordCounts[keyword] >= limit) break;
                if (seenUrls.has(post.post_url)) continue;
                seenUrls.add(post.post_url);
                await Dataset.pushData(post);
                keywordCounts[keyword]++;
            }

            start += 10;

            // Rate limit protection
            await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
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
