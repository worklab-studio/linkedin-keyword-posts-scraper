import { Actor } from 'apify';
import { Dataset, log, CheerioCrawler } from 'crawlee';

interface Input {
    keywords: string[];
    date?: string;
    limit?: number;
    li_at: string;
    proxy?: {
        useApifyProxy?: boolean;
        apifyProxyGroups?: string[];
        proxyUrls?: string[];
    };
}

const DATE_MAP: Record<string, string> = {
    'last-1-day': 'past-24h',
    'last-3-days': 'past-week',
    'last-1-week': 'past-week',
    'last-2-weeks': 'past-month',
    'last-1-month': 'past-month',
    'last-2-months': 'past-month',
    'last-3-months': 'past-month',
};

function getHeaders(li_at: string): Record<string, string> {
    return {
        'accept': 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9',
        'cookie': `li_at=${li_at}`,
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    };
}

function extractUrns(html: string): string[] {
    const seen = new Set<string>();
    const regex = /urn:li:(activity|ugcPost):(\d+)/g;
    let m;
    while ((m = regex.exec(html)) !== null) {
        seen.add(m[0]);
    }
    return [...seen];
}

function parsePostPage(html: string): { author: string; text: string; reactions: number; comments: number } {
    let author = 'Unknown', text = '', reactions = 0, comments = 0;

    const ogTitle = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/i)
        ?? html.match(/<meta[^>]*content="([^"]+)"[^>]*property="og:title"/i);
    if (ogTitle) {
        const parts = ogTitle[1].split(/\s+on\s+LinkedIn/i);
        if (parts[0]) author = parts[0].trim().replace(/&amp;/g, '&');
    }

    const ogDesc = html.match(/<meta[^>]*property="og:description"[^>]*content="([^"]+)"/i)
        ?? html.match(/<meta[^>]*content="([^"]+)"[^>]*property="og:description"/i);
    if (ogDesc) text = ogDesc[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();

    const rm = html.match(/(\d[\d,]*)\s*(?:reactions?|likes?)/i);
    if (rm) reactions = parseInt(rm[1].replace(/,/g, ''), 10) || 0;

    const cm = html.match(/(\d[\d,]*)\s*comments?/i);
    if (cm) comments = parseInt(cm[1].replace(/,/g, ''), 10) || 0;

    return { author, text, reactions, comments };
}

await Actor.main(async () => {
    const input = (await Actor.getInput<Input>())!;
    if (!input?.keywords?.length) throw new Error('Input must include at least one keyword.');
    if (!input?.li_at) throw new Error('LinkedIn li_at cookie is required.');

    const limit = input.limit ?? 50;
    const dateFilter = input.date && input.date !== 'ignore' ? DATE_MAP[input.date] ?? '' : '';

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
    }

    // Step 1: Fetch LinkedIn search pages to get post URNs
    // Multiple variants per keyword to maximize unique URNs
    log.info('Step 1: Collecting post URNs from LinkedIn search...');
    const allUrns: { urn: string; keyword: string }[] = [];
    const seenUrns = new Set<string>();

    for (const keyword of input.keywords) {
        const variants = [
            { sort: 'date_posted', filter: dateFilter },
            { sort: 'relevance', filter: dateFilter },
            { sort: 'date_posted', filter: '' },
            { sort: 'relevance', filter: '' },
        ];

        for (const v of variants) {
            if (allUrns.filter(u => u.keyword === keyword).length >= limit) break;

            let url = `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(keyword)}&origin=FACETED_SEARCH&sortBy=%5B%22${v.sort}%22%5D`;
            if (v.filter) url += `&datePosted=%5B%22${v.filter}%22%5D`;

            try {
                const res = await fetch(url, { headers: getHeaders(input.li_at), redirect: 'follow' });
                const html = await res.text();
                const urns = extractUrns(html);

                let newCount = 0;
                for (const urn of urns) {
                    if (seenUrns.has(urn)) continue;
                    if (allUrns.filter(u => u.keyword === keyword).length >= limit) break;
                    seenUrns.add(urn);
                    allUrns.push({ urn, keyword });
                    newCount++;
                }
                log.info(`"${keyword}" (${v.sort}/${v.filter || 'all'}): ${urns.length} URNs, ${newCount} new`);
            } catch (err) {
                log.warning(`Fetch error: ${(err as Error).message.slice(0, 100)}`);
            }

            await new Promise(r => setTimeout(r, 1500));
        }
    }

    log.info(`Step 1 done: ${allUrns.length} unique post URNs`);

    // Step 2: Fetch each post's public page for full details
    if (allUrns.length > 0) {
        log.info('Step 2: Fetching post details...');

        const postRequests = allUrns.map(({ urn, keyword }) => ({
            url: `https://www.linkedin.com/feed/update/${urn}/`,
            userData: { keyword },
        }));

        const crawler = new CheerioCrawler({
            proxyConfiguration,
            maxRequestRetries: 2,
            requestHandlerTimeoutSecs: 30,
            maxConcurrency: 3,
            additionalMimeTypes: ['application/octet-stream'],

            async requestHandler({ request, body }) {
                const { keyword } = request.userData as { keyword: string };
                const parsed = parsePostPage(body.toString());

                // Skip private/login-required posts
                if (parsed.author === 'Sign Up' || parsed.author === 'LinkedIn' || !parsed.text) {
                    log.info(`⊘ Skipped private post`);
                    return;
                }

                log.info(`✓ ${parsed.author} | ${parsed.reactions} reactions | ${parsed.comments} comments`);

                await Dataset.pushData({
                    author_name: parsed.author,
                    keyword,
                    post_url: request.url,
                    post_text: parsed.text.slice(0, 500),
                    reactions: parsed.reactions,
                    comments: parsed.comments,
                    scraped_at: new Date().toISOString(),
                });
            },

            failedRequestHandler({ request, error }) {
                log.warning(`Failed: ${request.url.slice(0, 80)} — ${(error as Error).message}`);
            },
        });

        await crawler.run(postRequests);
    }

    log.info('='.repeat(60));
    log.info(`Done. Total: ${allUrns.length} URNs collected`);
    log.info('='.repeat(60));

    await Actor.setValue('OUTPUT_SUMMARY', { total_posts: allUrns.length, completed_at: new Date().toISOString() });
});
