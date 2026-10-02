const sources = require('./sources.json');
const keywords = require('./keywords.json');

const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);

const config = {
  sources,
  keywords,
  categories: keywords.categories,

  newsPollMinutes: num(process.env.NEWS_POLL_MINUTES, 15),
  redditPollMinutes: num(process.env.REDDIT_POLL_MINUTES, 5),
  maxItemAgeHours: num(process.env.MAX_ITEM_AGE_HOURS, 48), // ignore anything older than this
  alertMaxAgeHours: 6, // only instant-alert items published within this window

  minDigestScore: num(process.env.MIN_DIGEST_SCORE, 5), // relevant items at/above this go in the digest
  minAlertScore: num(process.env.MIN_ALERT_SCORE, 8), // instant alert at/above this (or urgency=high)
  maxAlertsPerHour: num(process.env.MAX_ALERTS_PER_HOUR, 15),

  digestHourIST: num(process.env.DIGEST_HOUR_IST, 9), // daily digest at 09:00 IST
  dedupeWindowHours: 72,
  dedupeSimilarity: 0.6, // title token Jaccard at/above this = same story

  classifierModel: process.env.CLASSIFIER_MODEL || 'claude-haiku-4-5',
  askModel: process.env.ASK_MODEL || 'claude-opus-5-5',

  userAgent: 'nodejs:mvt-news-monitor:1.0 (by /u/nlok5923)',
};

module.exports = config;
