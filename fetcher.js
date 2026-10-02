const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const Parser = require('rss-parser');
const config = require('./config');

const parser = new Parser({ customFields: { item: ['source'] } });

const HEADERS = {
  // Reddit (and some news sites) throttle spoofed browser UAs hard — use a unique, descriptive one.
  'User-Agent': config.userAgent,
  Accept: 'application/rss+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.8',
};

// Per-host backoff after a 429: host -> resume timestamp (ms). Logged once per episode.
const pausedUntil = new Map();
const rateLimitNotified = new Set();

// Last fetch result per source, for /status.
const health = new Map();

const isPaused = (host) => Date.now() < (pausedUntil.get(host) || 0);

// ---------- normalization ----------

const TRACKING_PARAMS = /^(utm_.*|fbclid|gclid|ref|cmpid|ito|from|_gl)$/i;

function normalizeUrl(raw) {
  try {
    const u = new URL(String(raw).trim());
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAMS.test(k)) u.searchParams.delete(k);
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    u.protocol = 'https:';
    return u.toString().replace(/\/$/, '');
  } catch {
    return String(raw).trim();
  }
}

const itemId = (url) => crypto.createHash('sha1').update(normalizeUrl(url)).digest('hex').slice(0, 20);

function stripHtml(html) {
  return String(html || '')
    .replace(/<br\s*\/?>|<\/p>|<\/td>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&#32;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// RBI publishes "Fri, 02 Oct 2026 11:15:00" with no offset — interpret in the feed's tz.
function parseDate(raw, tz) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (tz && !/(GMT|UTC|Z|[+-]\d{2}:?\d{2})\s*$/i.test(s)) s = `${s} ${tz.replace(':', '')}`;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

// Google News titles end with " - Publisher". Split it off so the title is clean and dedupe works.
function splitPublisher(title) {
  const m = String(title).match(/^(.*\S)\s+-\s+([^-]{2,60})$/);
  return m ? { title: m[1], publisher: m[2].trim() } : { title, publisher: null };
}

// ---------- fetching ----------

async function fetchXml(url) {
  const host = new URL(url).hostname;
  if (isPaused(host)) {
    const err = new Error(`paused (rate-limited) for ${host}`);
    err.rateLimited = true;
    throw err;
  }

  // One deadline for headers AND body, so a slow-dripping server can't stall a poller forever.
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20000), redirect: 'follow' });

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get('retry-after'), 10);
    const cooldownMs = (Number.isFinite(retryAfter) ? retryAfter : 180) * 1000;
    pausedUntil.set(host, Date.now() + cooldownMs);
    // Reddit throttles datacenter IPs hard; this is expected, not a crash.
    if (!rateLimitNotified.has(host)) {
      console.warn(`[Fetch] Rate-limited by ${host} — backing off ${cooldownMs / 1000}s. Suppressing repeat 429 logs until it clears.`);
      rateLimitNotified.add(host);
    }
    res.body?.cancel().catch(() => {});
    const err = new Error(`HTTP 429 from ${host}`);
    err.rateLimited = true;
    throw err;
  }
  if (!res.ok) {
    res.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${res.status}`);
  }

  if (rateLimitNotified.delete(host)) console.log(`[Fetch] ${host} rate limit cleared — resuming.`);

  // Some feeds (RBI, PIB) start with a BOM, which trips the XML parser.
  return (await readCapped(res, 5_000_000)).replace(/^﻿/, '');
}

async function fetchSource(source) {
  try {
    const xml = await fetchXml(source.url);
    const feed = await parser.parseString(xml);
    const items = (feed.items || [])
      .map((entry) => toItem(entry, source))
      .filter((it) => it.url && it.title);
    health.set(source.id, { ok: true, at: Date.now(), count: items.length });
    return items;
  } catch (err) {
    health.set(source.id, { ok: false, at: Date.now(), error: err.message });
    throw err;
  }
}

function toItem(entry, source) {
  const url = entry.link || entry.guid || '';
  let title = stripHtml(entry.title);
  let sourceName = source.name;

  if (source.type === 'google_news') {
    const split = splitPublisher(title);
    title = split.title;
    const publisher = typeof entry.source === 'string' ? entry.source : entry.source?._ || split.publisher;
    if (publisher) sourceName = publisher;
  }
  if (source.type === 'reddit') {
    // rss-parser drops Atom <category>, so read the subreddit from the permalink.
    const sub = String(url).match(/\/r\/([^/]+)\/comments\//)?.[1];
    if (sub) sourceName = `r/${sub}`;
  }

  const rawBody = entry['content:encoded'] || entry.content || entry.contentSnippet || entry.summary || entry.description || '';
  let body = stripHtml(rawBody);
  // Google News descriptions just repeat the title + publisher.
  if (source.type === 'google_news') body = '';

  return {
    id: itemId(url),
    url,
    title,
    body: body.slice(0, 1500),
    sourceId: source.id,
    sourceName,
    sourceType: source.type,
    trusted: Boolean(source.trusted),
    publishedAt: parseDate(entry.pubDate || entry.isoDate || entry.updated, source.tz) || null,
  };
}

// ---------- source list ----------

function googleNewsUrl(query) {
  // when:2d keeps results fresh; hl/gl/ceid = English, India edition.
  const q = encodeURIComponent(`${query} when:2d`);
  return `https://news.google.com/rss/search?q=${q}&hl=en-IN&gl=IN&ceid=IN:en`;
}

function newsSources() {
  const { rss = [], google_news: gn = [] } = config.sources;
  return [
    ...rss.map((s) => ({ ...s, type: 'rss' })),
    ...gn.map((s) => ({ ...s, type: 'google_news', url: googleNewsUrl(s.query) })),
  ];
}

// Reddit throttles unauthenticated feeds hard, so everything is folded into two requests per cycle:
// one multi-subreddit feed (r/a+b+c/new) and one OR-combined search.
function redditSources() {
  const { subreddits = [], searches = [] } = config.sources.reddit || {};
  const out = [];
  if (subreddits.length) {
    out.push({
      id: 'reddit-subs',
      name: `Reddit: r/${subreddits.join(', r/')}`,
      type: 'reddit',
      url: `https://www.reddit.com/r/${subreddits.join('+')}/new.rss?limit=100`,
    });
  }
  if (searches.length) {
    const q = searches.map((s) => `(${s})`).join(' OR ');
    out.push({
      id: 'reddit-search',
      name: 'Reddit search',
      type: 'reddit',
      url: `https://www.reddit.com/search.rss?q=${encodeURIComponent(q)}&sort=new&t=week&limit=100`,
    });
  }
  return out;
}

// ---------- manual add (/add <url>) ----------

// Reads at most maxBytes of a response body.
async function readCapped(res, maxBytes) {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  while (size < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  reader.cancel().catch(() => {});
  return Buffer.concat(chunks).toString('utf8');
}

// SSRF guard: users can make the bot fetch any URL, so refuse internal/metadata addresses.
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateIp(v6.slice(7));
  return v6 === '::' || v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

async function assertPublicUrl(u) {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http(s) links are allowed');
  const addrs = await dns.lookup(u.hostname, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('internal addresses are not allowed');
}

// Best-effort fetch of an arbitrary page's title/description. Falls back to URL-only data
// (LinkedIn etc. often block bots) so a manual add never fails outright — unless the URL is unsafe.
async function fetchPage(rawUrl) {
  let current = new URL(String(rawUrl).trim()); // throws on garbage
  await assertPublicUrl(current);
  const url = current.toString();
  const base = { id: itemId(url), url, title: '', body: '', sourceId: 'manual', sourceName: hostOf(url), sourceType: 'manual', manual: true, trusted: true, publishedAt: Date.now() };

  try {
    let res;
    // Follow redirects by hand so every hop is re-checked against the SSRF guard.
    for (let hop = 0; hop < 4; hop++) {
      res = await fetch(current, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; mvt-news-monitor/1.0)', Accept: 'text/html,*/*' },
        signal: AbortSignal.timeout(10000),
        redirect: 'manual',
      });
      const loc = res.headers.get('location');
      if (res.status < 300 || res.status >= 400 || !loc) break;
      res.body?.cancel().catch(() => {});
      current = new URL(loc, current);
      await assertPublicUrl(current);
    }
    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      return base;
    }
    const html = await readCapped(res, 1_000_000);
    const meta = (name) =>
      html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i'))?.[1] ||
      html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${name}["']`, 'i'))?.[1];
    const title = meta('og:title') || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
    const desc = meta('og:description') || meta('description') || '';
    const paragraphs = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => stripHtml(m[1])).filter((p) => p.length > 60).slice(0, 8).join(' ');
    return { ...base, title: stripHtml(title).slice(0, 300), body: `${stripHtml(desc)} ${paragraphs}`.trim().slice(0, 1500) };
  } catch (err) {
    if (/internal addresses|only http/.test(err.message)) throw err;
    return base;
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'link';
  }
}

module.exports = { fetchSource, newsSources, redditSources, fetchPage, health, normalizeUrl, itemId, stripHtml };
