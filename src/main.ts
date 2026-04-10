import { Actor } from 'apify';
import { Dataset, log } from 'crawlee';
import { chromium, Page } from 'playwright';

interface Input {
    urls: string[];
    limit?: number;
    proxy?: {
        useApifyProxy?: boolean;
        apifyProxyGroups?: string[];
    };
}

// ─── Browser warmup (appear human) ──────────────────────────────────────────

async function warmUpBrowser(page: Page): Promise<void> {
    const sites = ['https://www.google.com', 'https://www.wikipedia.org'];
    for (const site of sites) {
        try {
            await page.goto(site, { waitUntil: 'domcontentloaded', timeout: 8000 });
            await page.waitForTimeout(1000);
        } catch { /* ok */ }
    }
    log.info('Browser warmed up');
}

// ─── Build posts URL ────────────────────────────────────────────────────────

function buildPostsUrl(url: string): string {
    url = url.split('?')[0].replace(/\/+$/, '');
    if (!url.includes('/posts')) url += '/posts/';
    return url;
}

// ─── Extract posts from page ────────────────────────────────────────────────

async function extractPostsFromPage(page: Page): Promise<any[]> {
    return page.evaluate(() => {
        const posts: any[] = [];
        const html = document.body.innerHTML;
        const seenUrns = new Set<string>();

        function parseCount(text: string): number {
            if (!text) return 0;
            const cleaned = text.trim().toLowerCase().replace(/,/g, '');
            if (cleaned.includes('k')) return Math.round(parseFloat(cleaned) * 1000);
            if (cleaned.includes('m')) return Math.round(parseFloat(cleaned) * 1000000);
            return parseInt(cleaned, 10) || 0;
        }

        // Find all activity URNs in the page
        const urnMatches = html.matchAll(/urn:li:activity:(\d+)/g);

        for (const match of urnMatches) {
            const urn = match[0];
            if (seenUrns.has(urn)) continue;
            seenUrns.add(urn);

            // Find element with this URN via data-urn attribute
            const el = document.querySelector(`[data-urn="${urn}"]`);
            if (!el) continue;

            // Extract post text
            let text = '';
            const textSelectors = [
                '.feed-shared-update-v2__description',
                '.update-components-text',
                '.feed-shared-text',
                '[data-test-id="main-feed-activity-card__commentary"]',
                '.break-words',
            ];
            for (const sel of textSelectors) {
                const textEl = el.querySelector(sel);
                if (textEl) {
                    const t = (textEl as HTMLElement).innerText?.trim() || '';
                    if (t.length > text.length && t.length > 20) text = t;
                }
            }

            // Fallback: find largest text block
            if (!text || text.length < 30) {
                const allDivs = el.querySelectorAll('div, span');
                let maxLen = 0;
                allDivs.forEach(div => {
                    const t = (div as HTMLElement).innerText?.trim() || '';
                    if (t.length > maxLen && t.length > 50
                        && !t.includes('followers')
                        && !t.includes('reactions')) {
                        text = t;
                        maxLen = t.length;
                    }
                });
            }

            if (!text || text.length < 20) continue;

            // Time posted
            const timeEl = el.querySelector('[class*="actor__sub-description"]');
            const timeText = timeEl ? (timeEl as HTMLElement).innerText : '';
            let postedAgo = '';
            const timeMatch = timeText.match(/(\d+[hdwmy]|\d+\s*(?:hour|day|week|month|year)s?\s*ago)/i);
            if (timeMatch) postedAgo = timeMatch[1].trim();

            // Author name
            let authorName = '';
            const authorEl = el.querySelector('[class*="actor__name"] span, [class*="actor__title"] span');
            if (authorEl) authorName = (authorEl as HTMLElement).innerText?.trim() || '';
            if (!authorName) {
                const ariaLabel = el.querySelector('[aria-label*="post by"]');
                if (ariaLabel) {
                    const m = ariaLabel.getAttribute('aria-label')?.match(/post by (.+)/i);
                    if (m) authorName = m[1].trim();
                }
            }

            // Reactions
            const reactionsEl = el.querySelector('[class*="social-counts__reactions"], button[aria-label*="reaction"]');
            const reactionsText = reactionsEl ? (reactionsEl as HTMLElement).innerText : '';
            const reactions = parseCount(reactionsText);

            // Comments
            const commentsEl = el.querySelector('button[aria-label*="comment"]');
            const commentsText = commentsEl ? (commentsEl as HTMLElement).innerText : '';
            const comments = parseCount(commentsText);

            // Reposts
            const repostsEl = el.querySelector('button[aria-label*="repost"]');
            const repostsText = repostsEl ? (repostsEl as HTMLElement).innerText : '';
            const reposts = parseCount(repostsText);

            // Images
            const images: string[] = [];
            el.querySelectorAll('img[src*="media"]').forEach(img => {
                const src = (img as HTMLImageElement).src;
                if (src && !src.includes('profile') && !src.includes('logo')) images.push(src);
            });

            posts.push({
                urn,
                text: text.substring(0, 2000),
                authorName,
                postedAgo,
                reactions,
                comments,
                reposts,
                images,
            });
        }

        return posts;
    });
}

// ─── Scroll for more posts ──────────────────────────────────────────────────

async function scrollForPosts(page: Page, limit: number): Promise<any[]> {
    const allPosts: any[] = [];
    const seenUrns = new Set<string>();
    let emptyScrolls = 0;
    let scrollCount = 0;
    const maxScrolls = Math.min(Math.ceil(limit / 3) + 2, 30);

    // Initial extraction
    const initial = await extractPostsFromPage(page);
    for (const p of initial) {
        if (!seenUrns.has(p.urn)) { seenUrns.add(p.urn); allPosts.push(p); }
    }
    log.info(`  Initial: ${allPosts.length} posts`);

    while (allPosts.length < limit && scrollCount < maxScrolls && emptyScrolls < 3) {
        const prevCount = allPosts.length;

        // Scroll down
        await page.keyboard.press('End');
        await page.waitForTimeout(2500);

        // Extract new posts
        const newPosts = await extractPostsFromPage(page);
        for (const p of newPosts) {
            if (!seenUrns.has(p.urn)) { seenUrns.add(p.urn); allPosts.push(p); }
        }

        scrollCount++;
        if (allPosts.length === prevCount) {
            emptyScrolls++;
            log.info(`  Scroll ${scrollCount}: no new (${emptyScrolls}/3)`);
        } else {
            emptyScrolls = 0;
            log.info(`  Scroll ${scrollCount}: ${allPosts.length} posts total`);
        }
    }

    return allPosts.slice(0, limit);
}

// ─── Trigger lazy load ──────────────────────────────────────────────────────

async function triggerLazyLoad(page: Page): Promise<void> {
    await page.evaluate(() => {
        const h = document.documentElement?.scrollHeight || 5000;
        const steps = 8;
        const step = Math.min(h / steps, 400);
        for (let i = 1; i <= steps; i++) {
            setTimeout(() => window.scrollTo(0, step * i), i * 200);
        }
    });
    await page.waitForTimeout(2500);
    await page.evaluate(() => window.scrollTo(0, 400));
    await page.waitForTimeout(1000);
}

// ─── Wait for posts to appear ───────────────────────────────────────────────

async function waitForPosts(page: Page): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
        await triggerLazyLoad(page);

        const hasPosts = await page.evaluate(() =>
            document.body.innerHTML.includes('urn:li:activity:')
        );

        if (hasPosts) {
            log.info('  Posts found');
            return true;
        }
        await page.waitForTimeout(2000);
    }
    log.warning('  No posts found after 3 attempts');
    return false;
}

// ─── Main ───────────────────────────────────────────────────────────────────

await Actor.main(async () => {
    const input = (await Actor.getInput<Input>())!;
    if (!input?.urls?.length) throw new Error('Provide at least one LinkedIn company or profile URL.');

    const limit = input.limit ?? 20;

    log.info('='.repeat(60));
    log.info('LinkedIn Posts Scraper');
    log.info(`URLs: ${input.urls.length}`);
    log.info(`Limit per URL: ${limit}`);
    log.info('='.repeat(60));

    // Launch browser
    let proxyUrl: string | undefined;
    if (input.proxy?.useApifyProxy) {
        const pc = await Actor.createProxyConfiguration({
            groups: input.proxy.apifyProxyGroups ?? ['RESIDENTIAL'],
        });
        proxyUrl = await pc!.newUrl();
    }

    const launchOptions: any = {
        headless: true,
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    };
    if (proxyUrl) launchOptions.proxy = { server: proxyUrl };

    const browser = await chromium.launch(launchOptions);
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 },
    });
    const page = await context.newPage();

    // Warm up browser
    await warmUpBrowser(page);

    let totalPosts = 0;

    for (const rawUrl of input.urls) {
        const url = buildPostsUrl(rawUrl);
        log.info(`Scraping: ${url}`);

        try {
            try {
                await page.goto(url, { waitUntil: 'commit', timeout: 90000 });
            } catch {
                log.warning('  Navigation slow, continuing...');
            }
            await page.waitForTimeout(5000);

            log.info(`  Current URL: ${page.url()}`);

            // Check for login wall
            if (page.url().includes('/login') || page.url().includes('/authwall')) {
                log.warning(`  Login required for ${url} — this page may not be public. Skipping.`);
                continue;
            }

            // Wait for posts
            const found = await waitForPosts(page);
            if (!found) {
                log.warning(`  No posts loaded for ${url}`);
                continue;
            }

            // Extract posts with scrolling
            const posts = await scrollForPosts(page, limit);

            for (const post of posts) {
                const activityId = post.urn.replace('urn:li:activity:', '');
                await Dataset.pushData({
                    post_url: `https://www.linkedin.com/feed/update/urn:li:activity:${activityId}/`,
                    urn: post.urn,
                    author_name: post.authorName || 'Unknown',
                    post_text: post.text,
                    posted_ago: post.postedAgo,
                    reactions: post.reactions,
                    comments: post.comments,
                    reposts: post.reposts,
                    images: post.images,
                    source_url: url,
                    scraped_at: new Date().toISOString(),
                });
                totalPosts++;
            }

            log.info(`  ✓ ${posts.length} posts scraped from ${url}`);

        } catch (err) {
            log.error(`  Error: ${(err as Error).message.slice(0, 100)}`);
        }

        await page.waitForTimeout(2000 + Math.random() * 3000);
    }

    await browser.close();

    log.info('='.repeat(60));
    log.info(`Done. Total: ${totalPosts} posts`);
    log.info('='.repeat(60));

    await Actor.setValue('OUTPUT_SUMMARY', { total_posts: totalPosts, completed_at: new Date().toISOString() });
});
