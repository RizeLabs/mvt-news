require('dotenv').config({ quiet: true });
const config = require('./config');
const db = require('./db');
const { fetchSource, newsSources, redditSources, fetchPage } = require('./fetcher');
const { isRelevant, titleKey, findDuplicate } = require('./filter');
const { classifyItem } = require('./analyzer');
const { startBot, broadcastAlert, broadcastDigest } = require('./telegram');

const HOUR = 3600 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Telegram instant alerts are capped; everything relevant still lands in the DB/digest.
let alertsThisHour = 0;
setInterval(() => {
  if (alertsThisHour) console.log(`[Monitor] Hourly reset — sent ${alertsThisHour} instant alerts this hour.`);
  alertsThisHour = 0;
}, HOUR);

// On a fresh DB, ingest the recent past silently so /latest and the first digest aren't empty,
// without blasting a backlog of "instant" alerts.
let backfilling = !db.getMeta('initialized');

// Set when the Anthropic API is rate-limiting / down / rejecting the key. Items are left
// untouched while paused, so the next poll picks them up again.
let classifierPausedUntil = 0;

// ---------- pipeline ----------

async function processItem(item) {
  if (db.hasItem(item.id)) return;

  if (item.publishedAt && Date.now() - item.publishedAt > config.maxItemAgeHours * HOUR) return;

  item.titleKey = titleKey(item.title);

  if (!isRelevant(item)) {
    db.insertItem(item, 'filtered');
    return;
  }

  // Same story from another outlet → attach as "also in" and skip the AI call.
  // Only across sources: one outlet's similar titles (e.g. RBI's per-bank-type circulars) are distinct items.
  const candidates = db.recentTitles(Date.now() - config.dedupeWindowHours * HOUR).filter((c) => c.source_id !== item.sourceId);
  const dupOf = findDuplicate(item.titleKey, candidates);
  if (dupOf) {
    db.insertItem(item, 'duplicate', dupOf);
    db.addAlsoIn(dupOf, item.sourceName, item.url);
    return;
  }

  if (Date.now() < classifierPausedUntil) return; // retry on a later poll
  if (!db.insertItem(item, 'pending')) return;
  const analysis = await classifyItem(item);
  if (analysis.failed) {
    db.deleteItem(item.id); // forget it so the next poll retries
    if (analysis.backoffMs) {
      classifierPausedUntil = Date.now() + analysis.backoffMs;
      console.warn(`[Monitor] Pausing classification for ${analysis.backoffMs / 60000}m.`);
    }
    return;
  }
  db.saveAnalysis(item.id, analysis);

  const tag = analysis.relevant ? `✔ ${analysis.score}/10 ${analysis.category}` : '✘';
  console.log(`[Monitor] ${tag} — ${item.sourceName}: "${item.title.slice(0, 90)}"`);

  if (!analysis.relevant || backfilling) return;
  const urgent = analysis.score >= config.minAlertScore || (analysis.urgency === 'high' && analysis.score >= config.minDigestScore + 1);
  if (!urgent) return;
  // Only push genuinely new news. Undated or older items (e.g. a feed resurfacing old posts) go to the digest.
  if (!item.publishedAt || Date.now() - item.publishedAt > config.alertMaxAgeHours * HOUR) return;
  // Reddit is user-written (and could carry prompt injection) — digest only, never an instant push.
  if (item.sourceType === 'reddit') return;

  if (alertsThisHour >= config.maxAlertsPerHour) {
    console.log('[Monitor] Instant-alert hourly cap reached — item goes to the digest only.');
    return;
  }
  alertsThisHour++;
  const delivered = await broadcastAlert(db.getItem(item.id));
  if (delivered) db.markAlerted(item.id);
}

// ---------- polling ----------

function makePoller(label, getSources, spacingMs) {
  let running = false;
  return async function poll() {
    if (running) return; // previous cycle still going
    running = true;
    let fetched = 0;
    try {
      for (const source of getSources()) {
        try {
          const items = await fetchSource(source);
          fetched += items.length;
          for (const item of items) await processItem(item);
        } catch (err) {
          // 429s are already reported once by the fetcher — don't re-log them.
          if (!err.rateLimited) console.error(`[${label}] ${source.name}: ${err.message}`);
        }
        await sleep(spacingMs);
      }
    } finally {
      running = false;
    }
    return fetched;
  };
}

const pollNews = makePoller('News', newsSources, 1500);
const pollReddit = makePoller('Reddit', redditSources, 2500);

// ---------- digest ----------

function istNow() {
  // IST is UTC+5:30 year-round (no DST).
  const d = new Date(Date.now() + 5.5 * HOUR);
  return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
}

function digestItems(sinceMs) {
  return db.relevantSince(sinceMs, config.minDigestScore);
}

async function maybeSendDigest() {
  const { date, hour, minute } = istNow();
  const { hour: dh, minute: dm } = config.digestTimeIST;
  if (backfilling || hour * 60 + minute < dh * 60 + dm || db.getMeta('last_digest_date') === date) return;
  // Marked before sending: a crash mid-send skips that day rather than double-sending to everyone.
  db.setMeta('last_digest_date', date);

  const now = Date.now();
  const since = Number(db.getMeta('last_digest_at')) || now - 24 * HOUR;
  const items = digestItems(since);
  db.setMeta('last_digest_at', now);
  console.log(`[Digest] Sending daily digest with ${items.length} item(s).`);
  await broadcastDigest(items, `🌙 <b>Daily digest · ${date}</b>`);
}

// ---------- manual add ----------

async function manualAdd(url, note) {
  const item = await fetchPage(url); // throws for unsafe URLs
  if (note && note.trim() !== url) item.body = `${note.trim()}\n${item.body}`.trim().slice(0, 1500);
  if (!item.title) item.title = note?.replace(url, '').trim().slice(0, 140) || url;
  item.titleKey = titleKey(item.title);

  const existing = db.getItem(item.id);
  if (existing && existing.status === 'relevant') return existing;

  db.upsertManual(item);
  const analysis = await classifyItem(item);
  if (analysis.failed) {
    db.deleteItem(item.id);
    return null;
  }
  db.saveAnalysis(item.id, analysis);
  return db.getItem(item.id);
}

// ---------- main ----------

async function main() {
  console.log('📰 MVT News Monitor starting...\n');

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('❌ Missing required environment variable: ANTHROPIC_API_KEY');
    console.error('Please fill in your .env file and try again.');
    process.exit(1);
  }
  if (!process.env.TELEGRAM_CHAT_ID) {
    console.warn('ℹ️  TELEGRAM_CHAT_ID not set — alerts go only to users who /start the bot.');
  }

  startBot({ onManualAdd: manualAdd, onDigestNow: () => digestItems(Date.now() - 24 * HOUR) });

  // Schedule everything before the first pass, so one slow source can't block the schedulers.
  setInterval(pollNews, config.newsPollMinutes * 60 * 1000);
  setInterval(pollReddit, config.redditPollMinutes * 60 * 1000);
  setInterval(() => maybeSendDigest().catch((e) => console.error('[Digest]', e.message)), 60 * 1000);
  setInterval(() => {
    try {
      const n = db.pruneOld(Date.now() - 30 * 24 * HOUR);
      if (n) console.log(`[Monitor] Pruned ${n} old non-relevant rows.`);
    } catch (err) {
      console.error('[Monitor] Prune failed:', err.message);
    }
  }, 24 * HOUR);

  if (backfilling) console.log(`[Monitor] Fresh database — backfilling the last ${config.maxItemAgeHours}h without instant alerts...`);
  const [n, r] = await Promise.all([pollNews(), pollReddit()]);
  console.log(`[Monitor] First pass done: ${n} news + ${r} reddit entries fetched.`);
  if (backfilling) {
    db.setMeta('initialized', '1');
    // Don't let the first scheduled digest re-send the whole backfill window twice.
    if (!db.getMeta('last_digest_at')) db.setMeta('last_digest_at', Date.now() - 24 * HOUR);
    backfilling = false;
    console.log('[Monitor] Backfill complete — live alerts are on.\n');
  }

  console.log(`[Monitor] Polling news every ${config.newsPollMinutes}m, Reddit every ${config.redditPollMinutes}m. Digest at ${config.digestTimeIST.label} IST.`);
}

process.on('unhandledRejection', (err) => console.error('[Monitor] Unhandled rejection:', err));

main();
