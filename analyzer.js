require('dotenv').config({ quiet: true });
const Anthropic = require('@anthropic-ai/sdk');
const { z } = require('zod');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
const config = require('./config');

const client = new Anthropic.default();

const CATEGORY_KEYS = Object.keys(config.categories);
const CATEGORY_GUIDE = Object.entries(config.categories)
  .map(([k, c]) => `- ${k}: ${c.about}`)
  .join('\n');

// Who the feed is for. Edit this to retune what counts as "relevant".
const AUDIENCE = `
The reader works in India's medical value travel (medical tourism) business: international patients
come to India for treatment (and Indians sometimes go abroad), and the business deals with hospital
partnerships, patient visas, cross-border payments, forex and remittance rules, and the regulations of
the patients' home countries. They need to catch regulatory and market changes early — especially RBI /
FEMA notifications, remittance and TCS rules, medical visa changes, and other countries' currency,
payment or medical-travel rules.
`.trim();

const Classification = z.object({
  relevant: z.boolean(),
  score: z.number().int().describe('1-10 importance to the reader. 9-10 = rule change they must act on; 7-8 = notable; 5-6 = useful context; <5 = noise'),
  category: z.enum(CATEGORY_KEYS),
  urgency: z.enum(['high', 'medium', 'low']).describe('high = new/changed rule, deadline, or limit that takes effect soon'),
  countries: z.array(z.string()).describe('Countries the item concerns, e.g. ["India", "UAE"]'),
  headline: z.string().describe('Clean, factual headline, max ~15 words'),
  summary: z.string().describe('1-2 sentence plain-English summary of what happened'),
  why_it_matters: z.string().describe('One sentence on the impact for a medical-tourism / cross-border-payments business, or empty if irrelevant'),
});

const SYSTEM = `You triage news for a monitoring bot.

${AUDIENCE}

Categories:
${CATEGORY_GUIDE}

Medical-tourism news about competing destinations (Thailand, Malaysia, Turkey, UAE, Singapore…) and
source markets (Africa, Middle East, Bangladesh, CIS…) is relevant market context — score it 5-6, higher
if it signals a policy change. Generic leisure tourism is not relevant.

Mark relevant=false for generic market/stock news, routine bank-operations circulars with no bearing on
foreign exchange, remittances, payments, health, travel or visas, opinion fluff, and anything unrelated
to the reader. Be strict: a busy reader gets every relevant item. Never invent facts beyond the text.`;

const FAILED = { relevant: false, score: 0, category: 'other', urgency: 'low', countries: [], headline: '', summary: '', why_it_matters: '', failed: true };

async function classifyItem(item) {
  const published = item.publishedAt ? new Date(item.publishedAt).toISOString().slice(0, 10) : 'unknown';
  const content = `Source: ${item.sourceName}
Published: ${published}
URL: ${item.url}
Title: ${item.title}
Text: ${item.body || '(title only)'}`;

  try {
    const response = await client.messages.parse({
      model: config.classifierModel,
      max_tokens: 1024,
      system: SYSTEM,
      messages: [{ role: 'user', content }],
      output_config: { format: zodOutputFormat(Classification) },
    });
    if (response.stop_reason === 'refusal' || !response.parsed_output) {
      console.warn(`[Analyzer] No classification for "${item.title}" (stop_reason=${response.stop_reason})`);
      return FAILED;
    }
    return response.parsed_output;
  } catch (err) {
    logApiError('classify', err);
    // Rate limits, overload, outages and bad keys won't fix themselves item-by-item:
    // tell the pipeline to back off instead of burning through every pending item.
    const transient = err instanceof Anthropic.RateLimitError || err instanceof Anthropic.AuthenticationError ||
      err instanceof Anthropic.APIConnectionError || (err instanceof Anthropic.APIError && (err.status ?? 0) >= 500);
    return { ...FAILED, backoffMs: transient ? (err instanceof Anthropic.AuthenticationError ? 30 : 3) * 60 * 1000 : 0 };
  }
}

// /ask — answer a question from stored articles only, citing them.
async function answerQuestion(question, articles) {
  if (!articles.length) return 'I have no stored articles that match that yet. Try /latest or wait for more news to come in.';

  const context = articles
    .map((a, i) => {
      const date = new Date(a.published_at || a.fetched_at).toISOString().slice(0, 10);
      return `[${i + 1}] ${date} · ${a.source_name} · ${a.headline || a.title}\n${a.summary || a.body?.slice(0, 400) || ''}\nURL: ${a.url}`;
    })
    .join('\n\n');

  try {
    const response = await client.beta.messages.create({
      model: config.askModel,
      max_tokens: 16000,
      output_config: { effort: 'low' },
      // On a safety decline, the API re-runs the request on a fallback model in the same call.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: `${AUDIENCE}

Answer the reader's question using ONLY the numbered articles provided. Cite them inline like [2].
If the articles don't answer it, say so plainly and say what to check (e.g. the RBI master direction).
Keep it under 200 words. Plain text only — no markdown headings, tables or bold.`,
      messages: [{ role: 'user', content: `Articles:\n\n${context}\n\nQuestion: ${question}` }],
    });

    if (response.stop_reason === 'refusal') return 'Sorry, I can’t answer that one.';
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    return text || 'No answer was generated — try rephrasing.';
  } catch (err) {
    logApiError('ask', err);
    return 'The AI service failed to answer just now — please try again in a minute.';
  }
}

function logApiError(op, err) {
  if (err instanceof Anthropic.RateLimitError) console.error(`[Analyzer:${op}] Rate limited by Anthropic`);
  else if (err instanceof Anthropic.AuthenticationError) console.error(`[Analyzer:${op}] Invalid ANTHROPIC_API_KEY`);
  else if (err instanceof Anthropic.APIError) console.error(`[Analyzer:${op}] API error ${err.status}: ${err.message}`);
  else console.error(`[Analyzer:${op}] ${err.message}`);
}

module.exports = { classifyItem, answerQuestion };
