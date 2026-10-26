# MVT News Bot

## Overview
Node.js Telegram bot that monitors RBI/FEMA, medical tourism, medical visas, forex/remittance (LRS/TCS) and foreign-country money rules. Polls RSS/Atom feeds (RBI, ET, Mint, BusinessLine, Google News queries, Reddit), keyword-gates, dedupes, classifies with Claude Haiku, sends instant alerts + an 11:30pm IST daily digest, and answers `/ask` questions from stored items. Modeled on `../reddit-scrap-script` (same UA/429 backoff approach, `node:sqlite`, HTML-mode Telegram).

## Architecture
- `index.js` — Entry point and pipeline. `processItem`: skip seen → age check → keyword gate (`filtered`) → cross-source title dedupe (`duplicate`, adds to original's `also_in`) → classify → alert if score ≥ `minAlertScore` or urgency high, published within `alertMaxAgeHours` (6h), not from Reddit (digest-only, user-written), hourly cap; `markAlerted` only after ≥1 delivery. Classifier failures delete the row so the next poll retries; transient API errors (429/5xx/auth/connection) pause classification for a few minutes. Two pollers (news 15m, Reddit 5m) with no overlap; schedulers are registered before the first pass. Fresh DB = silent backfill of the 48h window. Digest scheduler checks every minute against `meta.last_digest_date`. `manualAdd` powers `/add` and pasted links.
- `fetcher.js` — `fetchSource` (rss-parser, BOM strip, per-host 429 backoff honoring `Retry-After`, `health` map for `/status`). Builds Google News search URLs (`when:2d`, en-IN) and folds all subreddits into one `r/a+b+c/new.rss` request and all Reddit searches into one OR query. `parseDate` applies a feed `tz` when dates lack an offset (RBI = IST). `fetchPage` does best-effort title/description extraction for manual links, with an SSRF guard (http/https only, DNS-resolved private/loopback/metadata IPs rejected, redirects followed manually and re-checked, bodies size-capped). Feed fetches use one `AbortSignal.timeout` covering headers + body.
- `filter.js` — `isRelevant` (negative keywords always apply; `trusted` sources skip the positive match), `titleKey` + Jaccard `findDuplicate`.
- `analyzer.js` — `classifyItem` via `client.messages.parse` + zod structured output (`claude-haiku-4-5`). `answerQuestion` via `claude-opus-5-5`, effort low, server-side refusal fallback (`fallbacks: "default"`). `AUDIENCE` string defines relevance — edit it to retune.
- `db.js` — SQLite (`DB_PATH`, default `./news.db`). `items` stores everything seen (status: filtered | duplicate | pending | irrelevant | relevant | error); `pending` rows (interrupted mid-classification) are deleted on boot so they retry. Digests select on `analyzed_at` (not `fetched_at`) so items classified across the digest boundary aren't lost. `upsertManual` resets manual adds to fresh, non-duplicate rows. `subscribers` (categories `'all'` or CSV, instant, digest flags). `meta` (initialized, last_digest_date, last_digest_at).
- `telegram.js` — node-telegram-bot-api **0.67** (v2 is an incompatible ESM rewrite — don't upgrade blindly) with polling. Commands, `/topics` inline-keyboard toggles, `broadcastAlert` / `broadcastDigest` to `TELEGRAM_CHAT_ID` + subscribers. `chunk` splits on line boundaries to stay < 4096 chars with valid HTML. `send` retries once on 429 (`retry_after`), falls back to plain text on HTML parse errors, removes subscribers on 403. `/ask` and `/add` are rate-limited to 20/hour per user; set `TELEGRAM_ALLOWED_USERS` to make the bot private.
- `sources.json` / `keywords.json` — all feeds, Google News queries, subreddits, keyword patterns and the category taxonomy. Retarget without code changes.
- `scripts/check-sources.js` — `npm run check`: fetch every source, show how many items would reach the AI. No API calls.

## Commands
- `npm install`
- `npm start` — run the bot
- `npm run check [-- --verbose]` — dry-run all sources

## Notes
- Node ≥ 22.5 (`node:sqlite`).
- Only run one instance per bot token (Telegram polling).
- Business Standard, IMTJ and MEA block or lack feeds; Google News queries cover them. PIB's RSS only served Hindi in testing, so it's omitted.
- Secrets live in `.env` (gitignored).
