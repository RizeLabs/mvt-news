// Dry run: fetch every source once and show what would reach the AI classifier.
// No API key, no Telegram, no DB writes.  Usage: npm run check [-- --verbose]
const { fetchSource, newsSources, redditSources } = require('../fetcher');
const { isRelevant } = require('../filter');
const config = require('../config');

const verbose = process.argv.includes('--verbose');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let total = 0;
  let passing = 0;
  for (const source of [...newsSources(), ...redditSources()]) {
    try {
      const items = await fetchSource(source);
      const fresh = items.filter((i) => !i.publishedAt || Date.now() - i.publishedAt < config.maxItemAgeHours * 3600e3);
      const pass = fresh.filter(isRelevant);
      total += fresh.length;
      passing += pass.length;
      console.log(`✅ ${source.name.padEnd(42)} ${String(items.length).padStart(3)} items · ${String(fresh.length).padStart(3)} fresh · ${String(pass.length).padStart(3)} → AI`);
      if (verbose) for (const i of pass.slice(0, 5)) console.log(`     · ${i.title.slice(0, 100)}  [${i.sourceName}]`);
    } catch (err) {
      console.log(`❌ ${source.name.padEnd(42)} ${err.message}`);
    }
    await sleep(source.type === 'reddit' ? 2500 : 800);
  }
  console.log(`\n${total} fresh items, ${passing} would be sent to the classifier per full cycle (before dedupe).`);
})();
