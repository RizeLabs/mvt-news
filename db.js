const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// Single SQLite file, configurable for hosts with a mounted volume (e.g. DB_PATH=/data/news.db).
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'news.db');

const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;

  -- Every item we've ever seen, including ones filtered out, so restarts never re-process/re-alert.
  CREATE TABLE IF NOT EXISTS items (
    id             TEXT PRIMARY KEY,            -- sha1 of normalized url
    source_id      TEXT NOT NULL,
    source_name    TEXT,
    url            TEXT NOT NULL,
    title          TEXT NOT NULL,
    title_key      TEXT,                        -- normalized title tokens for dedupe
    body           TEXT,
    published_at   INTEGER,                     -- ms
    fetched_at     INTEGER NOT NULL,            -- ms
    status         TEXT NOT NULL,               -- filtered | duplicate | irrelevant | relevant | error
    duplicate_of   TEXT,
    also_in        TEXT NOT NULL DEFAULT '[]',  -- JSON [{name,url}] other outlets covering the same story
    score          INTEGER,
    category       TEXT,
    urgency        TEXT,
    countries      TEXT NOT NULL DEFAULT '[]',  -- JSON array
    headline       TEXT,
    summary        TEXT,
    why            TEXT,
    analyzed_at    INTEGER,                     -- ms; digests key off this (not fetched_at)
    alerted        INTEGER NOT NULL DEFAULT 0,
    manual         INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_items_status ON items(status, fetched_at DESC);
  CREATE INDEX IF NOT EXISTS idx_items_fetched ON items(fetched_at DESC);

  CREATE TABLE IF NOT EXISTS subscribers (
    chat_id     TEXT PRIMARY KEY,
    name        TEXT,
    categories  TEXT NOT NULL DEFAULT 'all',    -- 'all' or comma list of category keys
    instant     INTEGER NOT NULL DEFAULT 1,
    digest      INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Migration: analyzed_at was added after the first schema.
if (!db.prepare('PRAGMA table_info(items)').all().some((c) => c.name === 'analyzed_at')) {
  db.exec('ALTER TABLE items ADD COLUMN analyzed_at INTEGER');
}

// Items interrupted mid-classification (crash/redeploy) or that hit an API error: forget them so they retry.
db.exec("DELETE FROM items WHERE status IN ('pending', 'error')");

// ---------- meta ----------
const getMetaStmt = db.prepare('SELECT value FROM meta WHERE key = ?');
const setMetaStmt = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
const getMeta = (key) => getMetaStmt.get(key)?.value ?? null;
const setMeta = (key, value) => setMetaStmt.run(key, String(value));

// ---------- items ----------
const hasItemStmt = db.prepare('SELECT 1 FROM items WHERE id = ?');
const hasItem = (id) => Boolean(hasItemStmt.get(id));

const insertItemStmt = db.prepare(`
  INSERT OR IGNORE INTO items
    (id, source_id, source_name, url, title, title_key, body, published_at, fetched_at, status, duplicate_of, manual)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function insertItem(item, status, duplicateOf = null) {
  const info = insertItemStmt.run(
    item.id, item.sourceId, item.sourceName, item.url, item.title, item.titleKey || '',
    (item.body || '').slice(0, 2000), item.publishedAt || null, Date.now(), status, duplicateOf, item.manual ? 1 : 0
  );
  return info.changes > 0;
}

const saveAnalysisStmt = db.prepare(`
  UPDATE items SET status = ?, score = ?, category = ?, urgency = ?, countries = ?, headline = ?, summary = ?, why = ?, analyzed_at = ?
  WHERE id = ?
`);

function saveAnalysis(id, a) {
  saveAnalysisStmt.run(
    a.relevant ? 'relevant' : 'irrelevant',
    Math.min(10, Math.max(1, Math.round(a.score) || 1)), // schema can't enforce the range
    a.category || 'other',
    a.urgency || 'low',
    JSON.stringify(a.countries || []),
    a.headline || null,
    a.summary || null,
    a.why_it_matters || null,
    Date.now(),
    id
  );
}

const deleteItemStmt = db.prepare('DELETE FROM items WHERE id = ?');
const deleteItem = (id) => deleteItemStmt.run(id);

// Manual adds (/add, pasted links) always (re)enter as fresh, non-duplicate items.
const upsertManualStmt = db.prepare(`
  INSERT INTO items (id, source_id, source_name, url, title, title_key, body, published_at, fetched_at, status, manual)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1)
  ON CONFLICT(id) DO UPDATE SET
    status = 'pending', manual = 1, duplicate_of = NULL, fetched_at = excluded.fetched_at,
    title = excluded.title, title_key = excluded.title_key, body = excluded.body
`);
function upsertManual(item) {
  upsertManualStmt.run(
    item.id, item.sourceId, item.sourceName, item.url, item.title, item.titleKey || '',
    (item.body || '').slice(0, 2000), item.publishedAt || null, Date.now()
  );
}

const setStatusStmt = db.prepare('UPDATE items SET status = ? WHERE id = ?');
const setStatus = (id, status) => setStatusStmt.run(status, id);

const markAlertedStmt = db.prepare('UPDATE items SET alerted = 1 WHERE id = ?');
const markAlerted = (id) => markAlertedStmt.run(id);

const getItemStmt = db.prepare('SELECT * FROM items WHERE id = ?');
const getItem = (id) => hydrate(getItemStmt.get(id));

// Candidate originals for title-similarity dedupe (only stories that made it past the keyword gate).
const recentTitlesStmt = db.prepare(`
  SELECT id, source_id, title_key FROM items
  WHERE fetched_at > ? AND status IN ('relevant', 'irrelevant', 'pending') AND duplicate_of IS NULL
`);
const recentTitles = (sinceMs) => recentTitlesStmt.all(sinceMs);

const alsoInStmt = db.prepare('SELECT also_in, url FROM items WHERE id = ?');
const updateAlsoInStmt = db.prepare('UPDATE items SET also_in = ? WHERE id = ?');
function addAlsoIn(originalId, name, url) {
  const row = alsoInStmt.get(originalId);
  if (!row || row.url === url) return;
  const list = JSON.parse(row.also_in || '[]');
  if (list.some((x) => x.url === url) || list.length >= 5) return;
  list.push({ name, url });
  updateAlsoInStmt.run(JSON.stringify(list), originalId);
}

function hydrate(row) {
  if (!row) return null;
  return { ...row, countries: JSON.parse(row.countries || '[]'), also_in: JSON.parse(row.also_in || '[]') };
}

const relevantSinceStmt = db.prepare(`
  SELECT * FROM items WHERE status = 'relevant' AND coalesce(analyzed_at, fetched_at) > ? AND score >= ?
  ORDER BY score DESC, fetched_at DESC
`);
const relevantSince = (sinceMs, minScore) => relevantSinceStmt.all(sinceMs, minScore).map(hydrate);

const latestStmt = db.prepare(`
  SELECT * FROM items WHERE status = 'relevant' AND (? IS NULL OR category = ?)
  ORDER BY fetched_at DESC LIMIT ?
`);
const latest = (category, limit = 10) => latestStmt.all(category, category, limit).map(hydrate);

// Simple keyword search: every term must appear in title/headline/summary.
function search(query, limit = 10) {
  const terms = String(query).toLowerCase().split(/\s+/).filter((t) => t.length > 1).slice(0, 6);
  if (!terms.length) return [];
  const where = terms.map(() => "(lower(title) LIKE ? OR lower(coalesce(headline,'')) LIKE ? OR lower(coalesce(summary,'')) LIKE ?)").join(' AND ');
  const params = terms.flatMap((t) => [`%${t}%`, `%${t}%`, `%${t}%`]);
  return db
    .prepare(`SELECT * FROM items WHERE status = 'relevant' AND ${where} ORDER BY fetched_at DESC LIMIT ?`)
    .all(...params, limit)
    .map(hydrate);
}

// Looser search for /ask: any term matches, ranked by number of hits.
function searchAny(query, limit = 25) {
  const stop = new Set(['the', 'and', 'for', 'what', 'which', 'with', 'from', 'that', 'this', 'are', 'was', 'has', 'have', 'how', 'any', 'new', 'about', 'there', 'been', 'does', 'did', 'into', 'rules', 'latest']);
  const terms = String(query).toLowerCase().match(/[a-z0-9.-]{3,}/g)?.filter((t) => !stop.has(t)).slice(0, 8) || [];
  if (!terms.length) return [];
  const hit = "(CASE WHEN lower(title || ' ' || coalesce(summary,'')) LIKE ? THEN 1 ELSE 0 END)";
  const rank = terms.map(() => hit).join(' + ');
  return db
    .prepare(`SELECT *, (${rank}) AS hits FROM items WHERE status = 'relevant' AND (${rank}) > 0 ORDER BY hits DESC, fetched_at DESC LIMIT ?`)
    .all(...terms.map((t) => `%${t}%`), ...terms.map((t) => `%${t}%`), limit)
    .map(hydrate);
}

const statsStmt = db.prepare(`SELECT status, COUNT(*) AS n FROM items WHERE fetched_at > ? GROUP BY status`);
function stats(sinceMs) {
  const out = {};
  for (const r of statsStmt.all(sinceMs)) out[r.status] = r.n;
  return out;
}

const pruneStmt = db.prepare("DELETE FROM items WHERE fetched_at < ? AND status != 'relevant'");
const pruneOld = (beforeMs) => pruneStmt.run(beforeMs).changes;

// ---------- subscribers ----------
const upsertSubStmt = db.prepare(`
  INSERT INTO subscribers (chat_id, name, created_at) VALUES (?, ?, ?)
  ON CONFLICT(chat_id) DO UPDATE SET name = coalesce(nullif(excluded.name, ''), subscribers.name)
`);
const addSubscriber = (chatId, name) => upsertSubStmt.run(String(chatId), name || '', Date.now());

const delSubStmt = db.prepare('DELETE FROM subscribers WHERE chat_id = ?');
const removeSubscriber = (chatId) => delSubStmt.run(String(chatId)).changes > 0;

const getSubStmt = db.prepare('SELECT * FROM subscribers WHERE chat_id = ?');
const getSubscriber = (chatId) => getSubStmt.get(String(chatId)) || null;

const allSubsStmt = db.prepare('SELECT * FROM subscribers');
const allSubscribers = () => allSubsStmt.all();

const setSubFieldStmts = {
  categories: db.prepare('UPDATE subscribers SET categories = ? WHERE chat_id = ?'),
  instant: db.prepare('UPDATE subscribers SET instant = ? WHERE chat_id = ?'),
  digest: db.prepare('UPDATE subscribers SET digest = ? WHERE chat_id = ?'),
};
const setSubscriberField = (chatId, field, value) => setSubFieldStmts[field].run(value, String(chatId));

module.exports = {
  db, getMeta, setMeta,
  hasItem, insertItem, saveAnalysis, setStatus, deleteItem, upsertManual, markAlerted, getItem, recentTitles, addAlsoIn,
  relevantSince, latest, search, searchAny, stats, pruneOld,
  addSubscriber, removeSubscriber, getSubscriber, allSubscribers, setSubscriberField,
};
