import { Actor } from 'apify';
import { Dataset, log, CheerioCrawler } from 'crawlee';
import { chromium } from 'playwright';

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

function buildSearchUrl(keyword: string, dateFilter: string): string {
    let url = `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(keyword)}&origin=FACETED_SEARCH&sortBy=%5B%22date_posted%22%5D`;
    if (dateFilter) url += `&datePosted=%5B%22${dateFilter}%22%5D`;
    return url;
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

    // Proxy
    let proxyUrl: string | undefined;
    let proxyConfiguration: any = undefined;
    if (input.proxy?.useApifyProxy) {
        const pc = await Actor.createProxyConfiguration({ groups: input.proxy.apifyProxyGroups ?? ['RESIDENTIAL'] });
        proxyUrl = await pc!.newUrl();
        proxyConfiguration = pc;
        log.info('Using Apify proxy');
    }

    // ── Step 1: Playwright scrolls LinkedIn search, captures URNs ──
    log.info('Step 1: Scrolling LinkedIn search pages to collect post URNs...');

    const launchOptions: any = { headless: true, args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'] };
    if (proxyUrl) launchOptions.proxy = { server: proxyUrl };

    const browser = await chromium.launch(launchOptions);
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 },
    });
    await context.addCookies([
        { name: 'li_at', value: input.li_at, domain: '.linkedin.com', path: '/', httpOnly: true, secure: true },
        { name: 'JSESSIONID', value: `"ajax:${Math.random().toString(36).slice(2)}"`, domain: '.linkedin.com', path: '/', secure: true },
    ]);

    const page = await context.newPage();

    // Warmup
    try { await page.goto('https://www.linkedin.com/check/ring/dashboard', { waitUntil: 'commit', timeout: 15000 }); }
    catch { /* ok */ }
    await page.waitForTimeout(2000);

    if (page.url().includes('/login') || page.url().includes('/authwall')) {
        await browser.close();
        throw new Error('LinkedIn auth failed. Refresh your li_at cookie.');
    }
    log.info('Session established');

    const allUrns: { urn: string; keyword: string }[] = [];
    const seenUrns = new Set<string>();

    for (const keyword of input.keywords) {
        log.info(`Scrolling search for "${keyword}"...`);

        // Capture URNs from network responses AND page HTML
        const capturedUrns = new Set<string>();

        const responseHandler = async (response: any) => {
            try {
                const text = await response.text();
                const matches = text.matchAll(/urn:li:(activity|ugcPost):(\d+)/g);
                for (const m of matches) capturedUrns.add(m[0]);
            } catch { /* ignore non-text responses */ }
        };
        page.on('response', responseHandler);

        try {
            await page.goto(buildSearchUrl(keyword, dateFilter), { waitUntil: 'commit', timeout: 30000 });
        } catch { log.info('Navigation slow, continuing...'); }

        // Wait for content
        await page.waitForTimeout(5000);

        // Also extract URNs from current page HTML
        const html = await page.content();
        const htmlMatches = html.matchAll(/urn:li:(activity|ugcPost):(\d+)/g);
        for (const m of htmlMatches) capturedUrns.add(m[0]);

        log.info(`  Initial: ${capturedUrns.size} URNs`);

        // Scroll to load more posts
        let prevSize = 0;
        let scrollAttempts = 0;
        const maxScrolls = Math.ceil(limit / 5); // ~5 new posts per scroll

        while (capturedUrns.size < limit + seenUrns.size && scrollAttempts < maxScrolls) {
            prevSize = capturedUrns.size;

            await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
            await page.waitForTimeout(2000);

            // Click "Load more" if visible
            try {
                const loadMore = await page.$('button:has-text("Load more")');
                if (loadMore) {
                    await loadMore.click();
                    await page.waitForTimeout(3000);
                }
            } catch { /* no button */ }

            // Extract URNs from updated page
            const newHtml = await page.content();
            const newMatches = newHtml.matchAll(/urn:li:(activity|ugcPost):(\d+)/g);
            for (const m of newMatches) capturedUrns.add(m[0]);

            scrollAttempts++;
            if (capturedUrns.size === prevSize) {
                log.info(`  No new URNs after scroll ${scrollAttempts}, stopping`);
                break;
            }
            log.info(`  Scroll ${scrollAttempts}: ${capturedUrns.size} URNs`);
        }

        page.removeListener('response', responseHandler);

        // Add new URNs
        let newCount = 0;
        for (const urn of capturedUrns) {
            if (seenUrns.has(urn)) continue;
            if (newCount >= limit) break;
            seenUrns.add(urn);
            allUrns.push({ urn, keyword });
            newCount++;
        }

        log.info(`"${keyword}": collected ${newCount} unique post URNs`);
        await page.waitForTimeout(2000);
    }

    await browser.close();
    log.info(`Step 1 done: ${allUrns.length} total URNs`);

    // ── Step 2: Fetch each post's public page for details ──
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
    log.info(`Done. Total: ${allUrns.length} posts`);
    log.info('='.repeat(60));

    await Actor.setValue('OUTPUT_SUMMARY', { total_posts: allUrns.length, completed_at: new Date().toISOString() });
});
