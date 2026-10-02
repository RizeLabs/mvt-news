require('dotenv').config({ quiet: true });
const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');
const db = require('./db');
const { health, newsSources, redditSources } = require('./fetcher');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
// Optional broadcast target (a channel like @mychannel or -100…, or your own chat id). Gets everything.
const BROADCAST_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
// Optional allowlist of Telegram user ids. Empty = anyone who finds the bot can subscribe.
const ALLOWED = new Set((process.env.TELEGRAM_ALLOWED_USERS || '').split(',').map((s) => s.trim()).filter(Boolean));

const enabled = Boolean(TOKEN);
let bot = null;

const CATS = config.categories;
const MAX_LEN = 4000; // Telegram hard limit is 4096

// Escape characters that would otherwise break Telegram's HTML parse mode.
function esc(text) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
const escAttr = (s) => esc(s).replace(/"/g, '&quot;');

const clip = (t, n) => (String(t ?? '').length > n ? `${String(t).slice(0, n - 1)}…` : String(t ?? ''));

const URGENCY = { high: '🔴 High', medium: '🟠 Medium', low: '⚪ Low' };

// ---------- formatting ----------

function formatAlert(item) {
  const cat = CATS[item.category] || CATS.other;
  const countries = item.countries?.length ? `\n🌍 ${esc(item.countries.join(', '))}` : '';
  const also = item.also_in?.length ? ` <i>(+${item.also_in.length} more)</i>` : '';
  const why = item.why ? `\n\n<b>Why it matters:</b> ${esc(clip(item.why, 600))}` : '';
  return `${cat.emoji} <b>${esc(cat.label)}</b> · ${URGENCY[item.urgency] || ''} · ${item.score}/10

<b>${esc(clip(item.headline || item.title, 300))}</b>

${esc(clip(item.summary, 1200))}${why}${countries}
🔗 <a href="${escAttr(item.url)}">${esc(item.source_name)}</a>${also}`;
}

// withSummary: digests only expand the important items, to stay readable.
function formatLine(item, withSummary = true) {
  const flag = item.urgency === 'high' ? '🔴 ' : '';
  const summary = withSummary && item.summary ? `\n  ${esc(item.summary)}` : '';
  return `• ${flag}<a href="${escAttr(item.url)}">${esc(item.headline || item.title)}</a> <i>— ${esc(item.source_name)}</i>${summary}`;
}

// Groups items by category; returns message chunks that each fit Telegram's limit.
function formatDigest(items, title) {
  if (!items.length) return [`${title}\n\nNothing relevant in this window. 🎉`];
  const byCat = {};
  for (const it of items) (byCat[it.category] ||= []).push(it);

  const blocks = [];
  for (const key of Object.keys(CATS)) {
    const list = byCat[key];
    if (!list?.length) continue;
    const shown = list.slice(0, 8);
    const more = list.length > shown.length ? `\n  <i>…and ${list.length - shown.length} more (/latest ${key})</i>` : '';
    const lines = shown.map((it) => formatLine(it, it.score >= 7));
    blocks.push(`${CATS[key].emoji} <b>${esc(CATS[key].label)}</b> (${list.length})\n${lines.join('\n')}${more}`);
  }
  return chunk([title, ...blocks]);
}

// Packs blocks into messages under Telegram's limit. Oversized blocks are split on line
// boundaries (never mid-tag — broken HTML makes Telegram reject the whole message).
function chunk(blocks) {
  const pieces = [];
  for (const b of blocks) {
    if (b.length <= MAX_LEN) pieces.push(b);
    else pieces.push(...splitLines(b));
  }
  const out = [];
  let cur = '';
  for (const p of pieces) {
    if (cur && cur.length + p.length + 2 > MAX_LEN) {
      out.push(cur);
      cur = p;
    } else {
      cur = cur ? `${cur}\n\n${p}` : p;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function splitLines(block) {
  const out = [];
  let cur = '';
  for (const line of block.split(/\n(?=• )/)) {
    if (cur && cur.length + line.length + 1 > MAX_LEN) {
      out.push(cur);
      cur = line;
    } else {
      cur = cur ? `${cur}\n${line}` : line;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// ---------- sending ----------

async function send(chatId, html, extra = {}, attempt = 0) {
  if (!bot) return false;
  try {
    await bot.sendMessage(chatId, html, { parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
    return true;
  } catch (err) {
    const body = err.response?.body || {};
    const code = body.error_code;
    // Flood control — wait as told, then retry once.
    if (code === 429 && attempt === 0) {
      await sleep(((body.parameters?.retry_after || 5) + 1) * 1000);
      return send(chatId, html, extra, attempt + 1);
    }
    // Bad HTML (e.g. odd characters in a headline) — resend as plain text rather than lose the message.
    if (code === 400 && /parse entities/i.test(body.description || '') && attempt === 0) {
      const plain = html.replace(/<a href="([^"]*)">([\s\S]*?)<\/a>/g, '$2 ($1)').replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      try {
        await bot.sendMessage(chatId, plain.slice(0, 4096), { disable_web_page_preview: true });
        return true;
      } catch {
        /* fall through to logging */
      }
    }
    console.error(`[Telegram] Send to ${chatId} failed: ${err.message}`);
    // User blocked the bot — stop sending to it.
    if (code === 403 && db.removeSubscriber(chatId)) console.log(`[Telegram] Removed unreachable subscriber ${chatId}`);
    return false;
  }
}

async function sendChunks(chatId, chunks) {
  for (const c of chunks) {
    await send(chatId, c); // keep going: one failed chunk shouldn't drop the rest of a digest
    await sleep(400);
  }
}

const wantsCategory = (sub, cat) => sub.categories === 'all' || sub.categories.split(',').includes(cat);

// Instant alert → broadcast chat + every subscriber who wants this category. Returns # delivered.
async function broadcastAlert(item) {
  if (!enabled) return 0;
  const html = formatAlert(item);
  const targets = new Set();
  if (BROADCAST_CHAT_ID) targets.add(String(BROADCAST_CHAT_ID));
  for (const s of db.allSubscribers()) if (s.instant && wantsCategory(s, item.category)) targets.add(s.chat_id);
  let delivered = 0;
  for (const chatId of targets) {
    if (await send(chatId, html)) delivered++;
    await sleep(100);
  }
  console.log(`[Telegram] Alert delivered to ${delivered}/${targets.size} chat(s): "${item.headline || item.title}"`);
  return delivered;
}

async function broadcastDigest(items, title) {
  if (!enabled) return;
  if (BROADCAST_CHAT_ID) await sendChunks(BROADCAST_CHAT_ID, formatDigest(items, title));
  for (const s of db.allSubscribers()) {
    if (!s.digest || String(s.chat_id) === String(BROADCAST_CHAT_ID)) continue;
    await sendChunks(s.chat_id, formatDigest(items.filter((i) => wantsCategory(s, i.category)), title));
  }
}

// ---------- commands ----------

const HELP = `<b>MVT News Bot</b> — tracks RBI/FEMA, medical tourism, medical visas, forex &amp; remittance, and foreign-country money rules.

/latest [category] — last 10 relevant items
/digest — summary of the last 24h
/search &lt;words&gt; — search stored news
/ask &lt;question&gt; — AI answer from stored news
/topics — choose categories
/alerts on|off — instant alerts
/daily on|off — 9am IST digest
/add &lt;url&gt; — track a link (e.g. a LinkedIn post)
/status — source health
/stop — unsubscribe

Category keys: ${Object.keys(CATS).map((k) => `<code>${k}</code>`).join(', ')}

Tip: just paste or forward any link and I'll analyse it.`;

// Per-user limit on the commands that cost money (/ask → Opus, /add → fetch + Haiku).
const usage = new Map();
const LIMIT_PER_HOUR = 20;
function overLimit(userId) {
  const now = Date.now();
  const recent = (usage.get(userId) || []).filter((t) => now - t < 3600 * 1000);
  if (recent.length >= LIMIT_PER_HOUR) return true;
  recent.push(now);
  usage.set(userId, recent);
  return false;
}

function topicsKeyboard(sub) {
  const rows = Object.entries(CATS).map(([key, c]) => {
    const on = wantsCategory(sub, key);
    return [{ text: `${on ? '✅' : '▫️'} ${c.emoji} ${c.label}`, callback_data: `t:${key}` }];
  });
  rows.push([{ text: 'Select all', callback_data: 't:__all' }]);
  return { inline_keyboard: rows };
}

function startBot({ onManualAdd, onDigestNow }) {
  if (!enabled) {
    console.warn('[Telegram] TELEGRAM_BOT_TOKEN not set — running without Telegram (items are still stored).');
    return;
  }
  if (!ALLOWED.size) {
    console.warn('[Telegram] TELEGRAM_ALLOWED_USERS is empty — anyone who finds the bot can use it (/ask and /add are rate-limited per user).');
  }
  bot = new TelegramBot(TOKEN, { polling: true });
  bot.on('polling_error', (err) => console.error('[Telegram] Polling error:', err.code || err.message));

  bot.setMyCommands([
    { command: 'latest', description: 'Last relevant items' },
    { command: 'digest', description: 'Summary of the last 24h' },
    { command: 'search', description: 'Search stored news' },
    { command: 'ask', description: 'Ask a question about recent news' },
    { command: 'topics', description: 'Choose categories' },
    { command: 'alerts', description: 'Instant alerts on/off' },
    { command: 'daily', description: 'Daily digest on/off' },
    { command: 'add', description: 'Track a link' },
    { command: 'status', description: 'Source health' },
    { command: 'help', description: 'How to use this bot' },
  ]).catch(() => {});

  const allowed = (msg) => !ALLOWED.size || ALLOWED.has(String(msg.from?.id));
  const on = (re, handler) =>
    bot.onText(re, async (msg, match) => {
      if (!allowed(msg)) return send(msg.chat.id, 'This bot is private.');
      try {
        await handler(msg, match);
      } catch (err) {
        console.error('[Telegram] Command error:', err);
        send(msg.chat.id, 'Something went wrong handling that command.');
      }
    });

  on(/^\/start(?:@\w+)?(?:\s|$)/, async (msg) => {
    db.addSubscriber(msg.chat.id, msg.from?.username || msg.from?.first_name);
    await send(msg.chat.id, `✅ Subscribed. You'll get instant alerts for important changes and a daily digest at ${config.digestHourIST}:00 IST.\n\n${HELP}`);
  });

  on(/^\/help(?:@\w+)?(?:\s|$)/, (msg) => send(msg.chat.id, HELP));

  on(/^\/stop(?:@\w+)?(?:\s|$)/, async (msg) => {
    db.removeSubscriber(msg.chat.id);
    await send(msg.chat.id, 'Unsubscribed. Send /start any time to come back.');
  });

  on(/^\/topics(?:@\w+)?(?:\s|$)/, async (msg) => {
    db.addSubscriber(msg.chat.id, msg.from?.username || msg.from?.first_name);
    const sub = db.getSubscriber(msg.chat.id);
    await send(msg.chat.id, 'Tap to toggle the categories you want:', { reply_markup: topicsKeyboard(sub) });
  });

  bot.on('callback_query', async (q) => {
    const chatId = q.message?.chat.id;
    if (!chatId || !q.data?.startsWith('t:')) return;
    if (ALLOWED.size && !ALLOWED.has(String(q.from.id))) return bot.answerCallbackQuery(q.id, { text: 'Private bot' });
    db.addSubscriber(chatId, q.from?.username);
    const sub = db.getSubscriber(chatId);
    const key = q.data.slice(2);
    let next;
    if (key === '__all') next = 'all';
    else {
      const current = sub.categories === 'all' ? Object.keys(CATS) : sub.categories.split(',').filter(Boolean);
      const set = new Set(current);
      set.has(key) ? set.delete(key) : set.add(key);
      next = set.size === Object.keys(CATS).length ? 'all' : [...set].join(',');
    }
    db.setSubscriberField(chatId, 'categories', next);
    await bot.answerCallbackQuery(q.id).catch(() => {});
    await bot.editMessageReplyMarkup(topicsKeyboard(db.getSubscriber(chatId)), { chat_id: chatId, message_id: q.message.message_id }).catch(() => {});
  });

  on(/^\/alerts(?:@\w+)?(?:\s+(on|off))?\s*$/i, async (msg, m) => {
    db.addSubscriber(msg.chat.id, msg.from?.username);
    if (m[1]) db.setSubscriberField(msg.chat.id, 'instant', m[1].toLowerCase() === 'on' ? 1 : 0);
    const s = db.getSubscriber(msg.chat.id);
    await send(msg.chat.id, `Instant alerts are <b>${s.instant ? 'ON' : 'OFF'}</b>. Use /alerts on or /alerts off.`);
  });

  on(/^\/daily(?:@\w+)?(?:\s+(on|off))?\s*$/i, async (msg, m) => {
    db.addSubscriber(msg.chat.id, msg.from?.username);
    if (m[1]) db.setSubscriberField(msg.chat.id, 'digest', m[1].toLowerCase() === 'on' ? 1 : 0);
    const s = db.getSubscriber(msg.chat.id);
    await send(msg.chat.id, `Daily digest is <b>${s.digest ? 'ON' : 'OFF'}</b> (${config.digestHourIST}:00 IST). Use /daily on or /daily off.`);
  });

  on(/^\/latest(?:@\w+)?(?:\s+(\w+))?\s*$/i, async (msg, m) => {
    const cat = m[1] && CATS[m[1]] ? m[1] : null;
    const items = db.latest(cat, 10);
    if (!items.length) return send(msg.chat.id, 'Nothing stored yet — the first poll may still be running.');
    const title = `🗞 <b>Latest${cat ? ` · ${esc(CATS[cat].label)}` : ''}</b>`;
    await sendChunks(msg.chat.id, chunk([title, ...items.map((it) => formatLine(it))]));
  });

  on(/^\/digest(?:@\w+)?(?:\s|$)/, async (msg) => {
    const items = onDigestNow();
    const sub = db.getSubscriber(msg.chat.id);
    const mine = sub ? items.filter((i) => wantsCategory(sub, i.category)) : items;
    await sendChunks(msg.chat.id, formatDigest(mine, '📋 <b>Last 24 hours</b>'));
  });

  on(/^\/search(?:@\w+)?(?:\s+(.*))?$/i, async (msg, m) => {
    const q = m[1]?.trim();
    if (!q) return send(msg.chat.id, 'Usage: /search LRS limit');
    const items = db.search(q, 10);
    if (!items.length) return send(msg.chat.id, `No stored items match “${esc(q)}”.`);
    await sendChunks(msg.chat.id, chunk([`🔎 <b>${esc(q)}</b>`, ...items.map((it) => formatLine(it))]));
  });

  on(/^\/ask(?:@\w+)?(?:\s+([\s\S]*))?$/i, async (msg, m) => {
    const q = m[1]?.trim();
    if (!q) return send(msg.chat.id, 'Usage: /ask what changed in TCS on foreign remittance?');
    if (overLimit(msg.from?.id)) return send(msg.chat.id, 'Hourly limit reached — try again later.');
    bot.sendChatAction(msg.chat.id, 'typing').catch(() => {});
    const { answerQuestion } = require('./analyzer');
    // Matching articles first, topped up with the most recent ones for context.
    const matches = db.searchAny(q, 25);
    const seen = new Set(matches.map((a) => a.id));
    const recent = db.latest(null, 40).filter((a) => !seen.has(a.id)).slice(0, Math.max(0, 35 - matches.length));
    const articles = [...matches, ...recent];
    const answer = await answerQuestion(q, articles);
    // Turn [n] citations into links.
    const linked = esc(answer).replace(/\[(\d+)\]/g, (s, n) => {
      const a = articles[Number(n) - 1];
      return a ? `<a href="${escAttr(a.url)}">[${n}]</a>` : s;
    });
    await sendChunks(msg.chat.id, chunk([`💡 ${linked}`]));
  });

  on(/^\/add(?:@\w+)?(?:\s+(\S+))?\s*$/i, async (msg, m) => {
    const url = m[1];
    if (!/^https?:\/\//i.test(url || '')) return send(msg.chat.id, 'Usage: /add https://…');
    await handleManual(msg, url);
  });

  // Any non-command message containing a link (pasted or forwarded) → analyse it.
  bot.on('message', async (msg) => {
    const text = msg.text || msg.caption;
    if (!text || text.startsWith('/') || !allowed(msg)) return;
    const url = text.match(/https?:\/\/[^\s<>"]+/)?.[0]?.replace(/[.,;:!?)\]]+$/, '') ||
      (msg.entities || msg.caption_entities)?.find((e) => e.type === 'text_link')?.url;
    if (!url) return;
    try {
      await handleManual(msg, url, text);
    } catch (err) {
      console.error('[Telegram] Link handling failed:', err.message);
      send(msg.chat.id, 'Could not analyse that link.');
    }
  });

  async function handleManual(msg, url, note) {
    if (overLimit(msg.from?.id)) return send(msg.chat.id, 'Hourly limit reached — try again later.');
    bot.sendChatAction(msg.chat.id, 'typing').catch(() => {});
    let item;
    try {
      item = await onManualAdd(url, note);
    } catch (err) {
      return send(msg.chat.id, `Can't fetch that link: ${esc(err.message)}`);
    }
    if (!item) return send(msg.chat.id, 'Could not analyse that link.');
    const verdict = item.status === 'relevant' ? '✅ Saved as relevant' : '📁 Saved (classified as not relevant)';
    await send(msg.chat.id, `${verdict}\n\n${formatAlert(item)}`);
  }

  on(/^\/status(?:@\w+)?(?:\s|$)/, async (msg) => {
    const s = db.stats(Date.now() - 24 * 3600 * 1000);
    const lines = [...newsSources(), ...redditSources()].map((src) => {
      const h = health.get(src.id);
      if (!h) return `⏳ ${esc(src.name)} — not fetched yet`;
      const ago = Math.round((Date.now() - h.at) / 60000);
      return h.ok ? `✅ ${esc(src.name)} — ${h.count} items, ${ago}m ago` : `❌ ${esc(src.name)} — ${esc(h.error)} (${ago}m ago)`;
    });
    const summary = `<b>Last 24h:</b> ${s.relevant || 0} relevant · ${s.irrelevant || 0} irrelevant · ${s.duplicate || 0} duplicates · ${s.filtered || 0} keyword-filtered\n<b>Subscribers:</b> ${db.allSubscribers().length}`;
    await sendChunks(msg.chat.id, chunk([summary, ...lines]));
  });

  console.log('[Telegram] Bot listening for commands.');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { startBot, broadcastAlert, broadcastDigest, formatAlert, formatDigest };
