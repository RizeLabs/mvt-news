const config = require('./config');

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Compile once. Patterns that start/end with a non-word char can't use \b on that side.
function compile(patterns) {
  return patterns.map((p) => {
    const left = /^\w/.test(p) ? '\\b' : '';
    const right = /\w$/.test(p) ? '\\b' : '';
    return new RegExp(`${left}${escapeRegex(p)}${right}`, 'i');
  });
}

const MATCH = compile(config.keywords.match_patterns);
const NEGATIVE = compile(config.keywords.negative_keywords);

// Keyword pre-filter: keeps the AI bill down. Trusted sources (RBI, targeted Google News
// queries) skip the positive match but still respect negative keywords.
function isRelevant(item) {
  const text = `${item.title} ${item.body || ''}`;
  if (NEGATIVE.some((re) => re.test(text))) return false;
  if (item.trusted) return true;
  return MATCH.some((re) => re.test(text));
}

// ---------- dedupe ----------

const STOP = new Set('a an the of to in on for and or is are was be by with at as from its it this that after over new says said will has have india indian'.split(' '));

function titleKey(title) {
  return [...new Set(
    String(title)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
  )].sort().join(' ');
}

function jaccard(a, b) {
  const A = new Set(a.split(' ').filter(Boolean));
  const B = new Set(b.split(' ').filter(Boolean));
  if (A.size < 3 || B.size < 3) return 0; // too short to judge
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

// Returns the id of an earlier story this title duplicates, or null.
function findDuplicate(key, candidates) {
  let best = null;
  let bestScore = 0;
  for (const c of candidates) {
    const s = jaccard(key, c.title_key || '');
    if (s > bestScore) {
      bestScore = s;
      best = c.id;
    }
  }
  return bestScore >= config.dedupeSimilarity ? best : null;
}

module.exports = { isRelevant, titleKey, findDuplicate, jaccard };
