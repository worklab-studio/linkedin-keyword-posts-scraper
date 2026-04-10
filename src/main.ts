import { Actor } from 'apify';
import { Dataset, log, CheerioCrawler } from 'crawlee';

interface Input {
    urls: string[];
    limit?: number;
    proxy?: {
        useApifyProxy?: boolean;
        apifyProxyGroups?: string[];
    };
}

function buildPostsUrl(url: string): string {
    url = url.split('?')[0].replace(/\/+$/, '');
    if (!url.includes('/posts')) url += '/posts/';
    return url;
}

function extractUrns(html: string): string[] {
    const seen = new Set<string>();
    const regex = /urn:li:(activity|ugcPost):(\d+)/g;
    let m;
    while ((m = regex.exec(html)) !== null) seen.add(m[0]);
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
    if (!input?.urls?.length) throw new Error('Provide at least one LinkedIn company or profile URL.');

    const limit = input.limit ?? 20;

    log.info('='.repeat(60));
    log.info('LinkedIn Company Posts Scraper');
    log.info(`URLs: ${input.urls.length}`);
    log.info(`Limit per URL: ${limit}`);
    log.info('='.repeat(60));

    let proxyConfiguration: any = undefined;
    if (input.proxy?.useApifyProxy) {
        proxyConfiguration = await Actor.createProxyConfiguration({
            groups: input.proxy.apifyProxyGroups ?? ['RESIDENTIAL'],
        });
    }

    // Step 1: Fetch each company/profile posts page to collect URNs
    log.info('Step 1: Fetching company/profile pages for post URNs...');
    const allUrns: { urn: string; sourceUrl: string }[] = [];
    const seenUrns = new Set<string>();

    for (const rawUrl of input.urls) {
        const url = buildPostsUrl(rawUrl);
        log.info(`Fetching: ${url}`);

        try {
            const res = await fetch(url, {
                headers: {
                    'accept': 'text/html,application/xhtml+xml',
                    'accept-language': 'en-US,en;q=0.9',
                    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                },
                redirect: 'follow',
            });
            const html = await res.text();
            log.info(`  Got ${html.length} chars`);

            const urns = extractUrns(html);
            let newCount = 0;
            for (const urn of urns) {
                if (seenUrns.has(urn)) continue;
                if (allUrns.filter(u => u.sourceUrl === url).length >= limit) break;
                seenUrns.add(urn);
                allUrns.push({ urn, sourceUrl: url });
                newCount++;
            }
            log.info(`  Found ${urns.length} URNs, ${newCount} new`);
        } catch (err) {
            log.error(`  Error: ${(err as Error).message.slice(0, 100)}`);
        }

        await new Promise(r => setTimeout(r, 1500));
    }

    log.info(`Step 1 done: ${allUrns.length} total URNs`);

    // Step 2: Fetch each post's public page for details
    if (allUrns.length > 0) {
        log.info('Step 2: Fetching post details...');

        const postRequests = allUrns.map(({ urn, sourceUrl }) => ({
            url: `https://www.linkedin.com/feed/update/${urn}/`,
            userData: { sourceUrl },
        }));

        const crawler = new CheerioCrawler({
            proxyConfiguration,
            maxRequestRetries: 2,
            requestHandlerTimeoutSecs: 30,
            maxConcurrency: 3,
            additionalMimeTypes: ['application/octet-stream'],

            async requestHandler({ request, body }) {
                const { sourceUrl } = request.userData as { sourceUrl: string };
                const parsed = parsePostPage(body.toString());

                if (parsed.author === 'Sign Up' || parsed.author === 'LinkedIn' || !parsed.text) {
                    log.info('  ⊘ Skipped private post');
                    return;
                }

                log.info(`  ✓ ${parsed.author} | ${parsed.reactions} reactions | ${parsed.comments} comments`);

                await Dataset.pushData({
                    author_name: parsed.author,
                    post_url: request.url,
                    post_text: parsed.text.slice(0, 500),
                    reactions: parsed.reactions,
                    comments: parsed.comments,
                    source_url: sourceUrl,
                    scraped_at: new Date().toISOString(),
                });
            },

            failedRequestHandler({ request, error }) {
                log.warning(`  Failed: ${request.url.slice(0, 80)} — ${(error as Error).message}`);
            },
        });

        await crawler.run(postRequests);
    }

    log.info('='.repeat(60));
    log.info(`Done. Total: ${allUrns.length} URNs collected`);
    log.info('='.repeat(60));

    await Actor.setValue('OUTPUT_SUMMARY', { total_posts: allUrns.length, completed_at: new Date().toISOString() });
});
