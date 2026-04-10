import { Actor } from 'apify';
import { Dataset, log, CheerioCrawler } from 'crawlee';

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
    post_text: string;
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
    if (input.from) {
        const days = (Date.now() - new Date(input.from).getTime()) / 86400000;
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

function getHeaders(li_at: string): Record<string, string> {
    return {
        'accept': 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9',
        'cookie': `li_at=${li_at}`,
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    };
}

// Extract activity/ugcPost URNs from LinkedIn HTML
function extractPostUrns(html: string): string[] {
    const urns: string[] = [];
    const seen = new Set<string>();
    const regex = /urn:li:(activity|ugcPost):(\d+)/g;
    let m;
    while ((m = regex.exec(html)) !== null) {
        const [fullUrn] = m;
        if (!seen.has(fullUrn)) {
            seen.add(fullUrn);
            urns.push(fullUrn);
        }
    }
    return urns;
}

// Parse public LinkedIn post page for details
function parsePostPage(html: string): { author: string; text: string; reactions: number; comments: number } {
    let author = 'Unknown';
    let text = '';
    let reactions = 0;
    let comments = 0;

    // Author from og:title: "Author Name on LinkedIn: post preview..."
    const ogTitle = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/i)
        ?? html.match(/<meta[^>]*content="([^"]+)"[^>]*property="og:title"/i);
    if (ogTitle) {
        const parts = ogTitle[1].split(/\s+on\s+LinkedIn/i);
        if (parts[0]) author = parts[0].trim().replace(/&amp;/g, '&');
    }

    // Post text from og:description
    const ogDesc = html.match(/<meta[^>]*property="og:description"[^>]*content="([^"]+)"/i)
        ?? html.match(/<meta[^>]*content="([^"]+)"[^>]*property="og:description"/i);
    if (ogDesc) {
        text = ogDesc[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
    }

    // Reactions from social counts
    const reactMatch = html.match(/(\d[\d,]*)\s*(?:reactions?|likes?)/i);
    if (reactMatch) reactions = parseInt(reactMatch[1].replace(/,/g, ''), 10) || 0;

    // Comments
    const commentMatch = html.match(/(\d[\d,]*)\s*comments?/i);
    if (commentMatch) comments = parseInt(commentMatch[1].replace(/,/g, ''), 10) || 0;

    return { author, text, reactions, comments };
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
    log.info(`Date filter: ${dateFilter || 'none'}`);
    log.info('='.repeat(60));

    let proxyConfiguration: any = undefined;
    if (input.proxy?.useApifyProxy) {
        proxyConfiguration = await Actor.createProxyConfiguration({
            groups: input.proxy.apifyProxyGroups ?? ['RESIDENTIAL'],
        });
        log.info('Using Apify proxy');
    }

    // ── Step 1: Fetch LinkedIn search pages to get post URNs ──
    log.info('Step 1: Fetching LinkedIn search pages...');
    const postUrns: { urn: string; keyword: string }[] = [];
    const seenUrns = new Set<string>();

    for (const keyword of input.keywords) {
        const url = buildSearchUrl(keyword, dateFilter);
        log.info(`Fetching search for "${keyword}"...`);

        try {
            const res = await fetch(url, { headers: getHeaders(input.li_at), redirect: 'follow' });
            const html = await res.text();
            log.info(`Got ${html.length} chars for "${keyword}"`);

            const urns = extractPostUrns(html);
            log.info(`Found ${urns.length} post URNs for "${keyword}"`);

            for (const urn of urns) {
                if (seenUrns.has(urn)) continue;
                if (postUrns.filter(p => p.keyword === keyword).length >= limit) break;
                seenUrns.add(urn);
                postUrns.push({ urn, keyword });
            }
        } catch (err) {
            log.error(`Error fetching "${keyword}": ${(err as Error).message}`);
        }

        // Small delay between keywords
        await new Promise(r => setTimeout(r, 1000));
    }

    log.info(`Step 1 done: ${postUrns.length} total post URNs`);

    // ── Step 2: Fetch each post's public page for details ──
    if (postUrns.length > 0) {
        log.info('Step 2: Fetching post pages for details...');

        const postRequests = postUrns.map(({ urn, keyword }) => ({
            url: `https://www.linkedin.com/feed/update/${urn}/`,
            userData: { keyword, urn },
        }));

        const postCrawler = new CheerioCrawler({
            proxyConfiguration,
            maxRequestRetries: 2,
            requestHandlerTimeoutSecs: 30,
            maxConcurrency: 3,
            additionalMimeTypes: ['application/octet-stream'],

            async requestHandler({ request, body }) {
                const { keyword } = request.userData as { keyword: string };
                const html = body.toString();
                const parsed = parsePostPage(html);
                const now = new Date().toISOString();

                log.info(`✓ ${parsed.author} | ${parsed.reactions} reactions | ${parsed.comments} comments`);

                await Dataset.pushData({
                    author_name: parsed.author,
                    keyword,
                    post_url: request.url,
                    post_text: parsed.text.slice(0, 500),
                    reactions: parsed.reactions,
                    comments: parsed.comments,
                    scraped_at: now,
                } as PostResult);
            },

            failedRequestHandler({ request, error }) {
                log.warning(`Failed: ${request.url.slice(0, 80)} — ${(error as Error).message}`);
            },
        });

        await postCrawler.run(postRequests);
    }

    const total = postUrns.length;
    log.info('='.repeat(60));
    log.info(`Done. Total: ${total} posts`);
    log.info('='.repeat(60));

    await Actor.setValue('OUTPUT_SUMMARY', { total_posts: total, completed_at: new Date().toISOString() });
});
