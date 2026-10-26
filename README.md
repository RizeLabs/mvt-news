# MVT News Bot

A Telegram bot for the medical value travel business. It watches **RBI/FEMA notifications, medical tourism news, medical visas, forex & remittance rules (LRS/TCS), and foreign countries' money rules** across RBI, Indian news sites, Google News, and Reddit. It sends AI-triaged instant alerts for important changes and a daily digest at 23:30 IST.

## How it works

```
sources.json ─▶ fetcher (RSS/Atom, per-host 429 backoff)
                 │
                 ▼
            keyword gate (keywords.json; trusted sources skip it)
                 │
                 ▼
            dedupe (same story from another outlet → "+N more")
                 │
                 ▼
            Claude Haiku: relevant? score 1-10, category, urgency, countries, summary
                 │
                 ├─ score ≥ 8 or urgency high → instant Telegram alert (capped 15/hr)
                 └─ score ≥ 5 → stored → daily digest, /latest, /search, /ask
```

## Sources

| Source | What |
|---|---|
| RBI | Notifications + press release RSS (every item goes to the AI) |
| News RSS | ET NRI, ET Economy, ET Healthcare, Mint Money/Economy, BusinessLine Banking |
| Google News | 7 targeted queries: RBI/FEMA, LRS/TCS, medical tourism (India + abroad), medical visas, remittance rules abroad, capital controls |
| Reddit | r/nri, IndiaInvestments, personalfinanceindia, IndiaTax, medicaltourism, expats, plus keyword searches. These are folded into **2 requests per cycle** to avoid Reddit's 429s |
| LinkedIn | No public API, and scraping gets accounts banned. **Paste or forward a LinkedIn post (link + text) to the bot** and it is analysed and stored like any other item |

Add or remove feeds in `sources.json` and keywords in `keywords.json`. No code changes are needed. `npm run check` dry-runs every source without using the API.

## Setup

1. `npm install` (needs Node ≥ 22.5 for the built-in `node:sqlite`)
2. Create a bot with [@BotFather](https://t.me/BotFather) → copy the token
3. `cp .env.example .env` and fill in:
   - `ANTHROPIC_API_KEY`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID` (optional): a channel (`@yourchannel`, with the bot added as admin) or your own user id. It receives **every** alert and digest.
   - `TELEGRAM_ALLOWED_USERS` (optional): comma-separated user ids to keep the bot private
4. `npm start`, then message your bot `/start`

On first run it backfills the last 24h **without** instant alerts, so `/latest` works right away. Live alerts start after that.

> ⚠️ Use a **new** bot token. Don't reuse the reddit-monitor bot's token, because two processes polling the same token steal each other's updates.

## Bot commands

| Command | |
|---|---|
| `/start` / `/stop` | Subscribe / unsubscribe |
| `/topics` | Toggle categories with buttons |
| `/alerts on\|off`, `/daily on\|off` | Instant alerts / 11:30pm digest |
| `/latest [category]` | Last 10 relevant items |
| `/digest` | Last 24h, grouped by category |
| `/search <words>` | Search stored items |
| `/ask <question>` | AI answer from stored news, with linked citations |
| `/add <url>` or paste any link | Analyse and store a link |
| `/status` | Per-source health + 24h counts |

Categories: `rbi_fema`, `medical_tourism`, `visa_travel`, `forex_remittance`, `foreign_rules`, `tax`, `other`.

## Cost

Classification uses Claude Haiku 4.5 at about **$0.003 per item** (~1.5k input + ~250 output tokens). After the keyword gate and dedupe, expect roughly 50–150 new items a day, which works out to **about $5–15/month**. The one-time backfill on first run is ~120 items (~$0.40). `/ask` uses Claude Opus 5.5 at low effort, a few cents per question. Change models with `CLASSIFIER_MODEL` / `ASK_MODEL`.

## Deploy (Railway, same as reddit-monitor)

```bash
railway init            # new project
railway volume add --mount-path /data
railway variables --set ANTHROPIC_API_KEY=… --set TELEGRAM_BOT_TOKEN=… --set TELEGRAM_CHAT_ID=… --set DB_PATH=/data/news.db
railway up --ci
```

Only one instance should run, because Telegram long-polling allows a single consumer per token. Reddit may 429 more often from datacenter IPs. The fetcher backs off per host, and every other source keeps working.

## Tuning

- **Too noisy?** Raise `MIN_ALERT_SCORE` (default 8) or `MIN_DIGEST_SCORE` (default 5), or tighten the `AUDIENCE` text in `analyzer.js`.
- **Missing things?** Add Google News queries to `sources.json`. They're the cheapest way to cover a new topic or country.
- **Google News feeds** are licensed for personal, non-commercial use. For a commercial product, swap them for a paid news API.
