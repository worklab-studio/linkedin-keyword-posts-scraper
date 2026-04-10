# LinkedIn Keyword Posts URL Scraper

An Apify Actor built with [Crawlee](https://crawlee.dev) that scrapes LinkedIn post URLs by keyword — with date filters, result limits, and optional Playwright browser mode.

---

## Features

- Search LinkedIn posts by one or more keywords
- Preset date ranges (last 1 day → last 1 year) or custom from/to dates
- Two scraping modes:
  - **HTTP mode** (default) — fast, uses LinkedIn Voyager internal API
  - **Playwright mode** — browser-based fallback for when API gets blocked
- Apify Residential proxy support built-in
- Output: `author_name`, `keyword`, `post_url`, `scraped_at`
- Export results as JSON, CSV, or Excel from Apify console

---

## Input

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `keywords` | string[] | ✅ | Keywords to search for |
| `li_at` | string | ✅ | LinkedIn session cookie (see below) |
| `date` | string | ❌ | Preset date range (default: `last-3-months`) |
| `from` | string | ❌ | Start date `YYYY-MM-DD` (used when `date` = `ignore`) |
| `to` | string | ❌ | End date `YYYY-MM-DD` (used when `date` = `ignore`) |
| `limit` | integer | ❌ | Max posts per keyword (default: 50, max: 500) |
| `use_playwright` | boolean | ❌ | Use browser mode instead of API (default: false) |
| `proxy` | object | ❌ | Proxy config (Apify or custom URLs) |

### Date presets
`ignore` · `last-1-day` · `last-3-days` · `last-1-week` · `last-2-weeks` · `last-1-month` · `last-2-months` · `last-3-months` · `last-6-months` · `last-1-year`

### Input examples

**Basic**
```json
{
    "keywords": ["product design", "AI tools"],
    "li_at": "YOUR_LI_AT_COOKIE",
    "date": "last-1-month",
    "limit": 100
}
```

**Custom date range**
```json
{
    "keywords": ["saas"],
    "li_at": "YOUR_LI_AT_COOKIE",
    "date": "ignore",
    "from": "2024-01-01",
    "to": "2024-03-31",
    "limit": 50
}
```

**With Apify Residential proxies**
```json
{
    "keywords": ["indie hacker"],
    "li_at": "YOUR_LI_AT_COOKIE",
    "proxy": {
        "useApifyProxy": true,
        "apifyProxyGroups": ["RESIDENTIAL"]
    }
}
```

**Playwright mode (browser fallback)**
```json
{
    "keywords": ["startup founder"],
    "li_at": "YOUR_LI_AT_COOKIE",
    "use_playwright": true,
    "limit": 30
}
```

---

## Output

Each result in the dataset:

```json
{
    "author_name": "Priya Sharma",
    "keyword": "product design",
    "post_url": "https://www.linkedin.com/feed/update/urn:li:activity:7193847362819047424/",
    "scraped_at": "2024-04-10T09:15:32.000Z"
}
```

---

## How to get your `li_at` cookie

1. Log into LinkedIn in Chrome/Firefox
2. Open DevTools (`F12` or `Cmd+Option+I`)
3. Go to **Application** → **Cookies** → `https://www.linkedin.com`
4. Find the cookie named `li_at`
5. Copy the value — paste it into the `li_at` input field

> ⚠️ Keep your `li_at` cookie private. It gives full access to your LinkedIn account. The Actor marks it as `isSecret` so Apify encrypts it at rest.

---

## Local development

### Prerequisites
- Node.js 18+
- Apify CLI: `npm install -g apify-cli`

### Setup
```bash
# Clone / unzip the project
cd linkedin-keyword-posts-scraper

# Install dependencies
npm install

# Login to Apify (get token from console.apify.com/account?tab=integrations)
apify login -t YOUR_API_TOKEN

# Edit the test input
# storage/key_value_stores/default/INPUT.json
# → paste your li_at cookie value

# Run locally
apify run
# or
npm run dev
```

### Deploy to Apify
```bash
# Build TypeScript
npm run build

# Push to Apify platform
apify push

# Actor is now live at:
# https://console.apify.com/actors
```

---

## Architecture

```
Input (keywords + li_at + date range)
        │
        ▼
┌─────────────────────────────────────┐
│  Mode selection                     │
│  HTTP mode (default)                │
│  → Voyager API (/search/blended)    │
│  → 10 results/page, paginated       │
│                                     │
│  Playwright mode (fallback)         │
│  → Real browser, cookie injected    │
│  → Scroll + DOM extraction          │
└─────────────────────────────────────┘
        │
        ▼
  Dataset.pushData()
  { author_name, keyword, post_url, scraped_at }
        │
        ▼
  Actor.setValue('OUTPUT_SUMMARY')
  { total_posts, keywords: {...}, completed_at }
```

---

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| `401 auth error` | `li_at` expired | Refresh cookie from browser |
| Empty results | Rate limited | Add Apify Residential proxy |
| Non-JSON response | IP blocked | Switch to Playwright mode |
| 0 posts scraped | Wrong cookie | Double-check `li_at` value |

---

## Notes

- LinkedIn's Voyager API is an internal API — not officially supported for third-party use
- Use responsibly and respect LinkedIn's Terms of Service
- Residential proxies are strongly recommended for production runs
- `li_at` cookies expire periodically — refresh from your browser as needed
- For high-volume scraping (1000+ posts), use Playwright mode with proxies

---

## Tech stack

- [Crawlee](https://crawlee.dev) v3.16
- [Apify SDK](https://docs.apify.com/sdk/js) v3
- TypeScript / Node.js 18
- Playwright (browser mode)

---

Built for the **Apify Hackathon** · Powered by Crawlee
