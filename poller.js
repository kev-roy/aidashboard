/**
 * AI Visibility Poller
 * Runs each prompt against ChatGPT, Claude, Perplexity, and Google AI Overviews.
 * Stores results in data/results.json
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const OpenAI    = require('openai').default;
const Anthropic = require('@anthropic-ai/sdk').default;

const DATA_DIR     = path.join(__dirname, 'data');
const CONFIG_FILE  = path.join(DATA_DIR, 'config.json');
const RESULTS_FILE = path.join(DATA_DIR, 'results.json');

// ── Clients ──────────────────────────────────────────────────────────────────
const openai    = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.AVT_ANTHROPIC_KEY });

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) throw new Error('No config.json found. Complete setup first.');
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

function loadResults() {
  if (!fs.existsSync(RESULTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
}

function saveResults(results) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
}

/**
 * Detect brand mentions, position, and cited URLs in a response.
 */
function analyzeResponse(text, brandName, brandDomain, competitors = []) {
  const lower = text.toLowerCase();
  const brandLower = brandName.toLowerCase();

  // Brand mentioned?
  const mentioned = lower.includes(brandLower) ||
    lower.includes(brandDomain.toLowerCase().replace(/^www\./, ''));

  // Rough position: which sentence/paragraph first mentions the brand
  let position = null;
  if (mentioned) {
    const sentences = text.split(/(?<=[.!?])\s+/);
    for (let i = 0; i < sentences.length; i++) {
      if (sentences[i].toLowerCase().includes(brandLower)) {
        position = i + 1;
        break;
      }
    }
  }

  // Extract URLs
  const urlRegex = /https?:\/\/[^\s\)\]"'>]+/g;
  const urls = [...new Set((text.match(urlRegex) || []).map(u => u.replace(/[.,;]+$/, '')))];

  // Cited brand URLs
  const citedBrandURLs = urls.filter(u => u.toLowerCase().includes(brandDomain.toLowerCase()));

  // Competitor mentions
  const competitorMentions = competitors
    .filter(c => c.domain && lower.includes(c.domain.toLowerCase().replace(/^www\./, '')))
    .map(c => c.name || c.domain);

  // Sentiment (simple keyword scoring)
  const positiveWords = ['best','top','leading','excellent','recommended','great','trusted','expert','award','innovative'];
  const negativeWords = ['avoid','poor','bad','worst','unreliable','scam','overpriced','slow'];
  let sentimentScore = 0;
  if (mentioned) {
    // look at the 50 words surrounding the brand mention
    const idx = lower.indexOf(brandLower);
    const window = lower.slice(Math.max(0, idx - 200), idx + 200);
    positiveWords.forEach(w => { if (window.includes(w)) sentimentScore++; });
    negativeWords.forEach(w => { if (window.includes(w)) sentimentScore--; });
  }
  const sentiment = sentimentScore > 0 ? 'positive' : sentimentScore < 0 ? 'negative' : 'neutral';

  return { mentioned, position, urls, citedBrandURLs, competitorMentions, sentiment };
}

// ── Platform runners ──────────────────────────────────────────────────────────

async function runChatGPT(prompt) {
  const res = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 1000,
    temperature: 0.3,
  });
  return res.choices[0].message.content || '';
}

async function runClaude(prompt) {
  const res = await anthropic.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }],
  });
  return res.content[0].type === 'text' ? res.content[0].text : '';
}

async function runPerplexity(prompt) {
  const res = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'sonar',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1024,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Perplexity error: ${JSON.stringify(data)}`);
  return data.choices[0].message.content || '';
}

async function runSerpApiAIOverview(prompt) {
  const params = new URLSearchParams({
    q: prompt,
    api_key: process.env.SERPAPI_KEY,
    engine: 'google',
    gl: 'us',
    hl: 'en',
  });
  const res  = await fetch(`https://serpapi.com/search.json?${params}`);
  const data = await res.json();
  if (!res.ok) throw new Error(`SerpApi error: ${JSON.stringify(data)}`);

  // Extract AI Overview text if present
  const aiOverview = data.ai_overview?.text_blocks?.map(b => b.snippet || '').join(' ')
    || data.answer_box?.answer
    || data.answer_box?.snippet
    || '';

  // Also grab organic result URLs for citation tracking
  const organicURLs = (data.organic_results || []).slice(0, 5).map(r => r.link).filter(Boolean);

  return { text: aiOverview, organicURLs };
}

// ── Run one prompt across all platforms ──────────────────────────────────────

async function runPrompt(prompt, config) {
  const { brand, competitors = [] } = config;
  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const timestamp = new Date().toISOString();
  const platformResults = {};

  const platforms = [
    { key: 'chatgpt',      label: 'ChatGPT',           fn: () => runChatGPT(prompt) },
    { key: 'claude',       label: 'Claude',             fn: () => runClaude(prompt) },
    { key: 'perplexity',   label: 'Perplexity',         fn: () => runPerplexity(prompt) },
    { key: 'google_aio',   label: 'Google AI Overview', fn: () => runSerpApiAIOverview(prompt) },
  ];

  for (const p of platforms) {
    try {
      process.stdout.write(`  [${p.label}] querying...`);
      let text;
      let extra = {};

      if (p.key === 'google_aio') {
        const result = await p.fn();
        text = result.text;
        extra.organicURLs = result.organicURLs;
      } else {
        text = await p.fn();
      }

      const analysis = analyzeResponse(text, brand.name, brand.domain, competitors);
      platformResults[p.key] = {
        response: text.slice(0, 2000), // store up to 2000 chars
        ...analysis,
        ...extra,
      };
      console.log(` ✓ mentioned=${analysis.mentioned} position=${analysis.position}`);
    } catch (err) {
      console.log(` ✗ error: ${err.message}`);
      platformResults[p.key] = { error: err.message, mentioned: false, position: null };
    }
  }

  return { runId, timestamp, prompt, platformResults };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function runPoll() {
  console.log(`\n🚀 AI Visibility Poll — ${new Date().toLocaleString()}`);
  console.log('─'.repeat(60));

  const config  = loadConfig();
  const results = loadResults();

  console.log(`Brand: ${config.brand.name} (${config.brand.domain})`);
  console.log(`Prompts: ${config.prompts.length}`);
  console.log(`Competitors: ${config.competitors?.map(c => c.domain).join(', ') || 'none'}\n`);

  for (let i = 0; i < config.prompts.length; i++) {
    const prompt = config.prompts[i];
    console.log(`\nPrompt ${i + 1}/${config.prompts.length}: "${prompt.slice(0, 70)}..."`);
    const result = await runPrompt(prompt, config);
    results.push(result);

    // Small delay between prompts to avoid rate limits
    if (i < config.prompts.length - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  saveResults(results);
  console.log(`\n✅ Poll complete. ${results.length} total runs saved.`);
  return results;
}

module.exports = { runPoll };

// Run directly if called as script
if (require.main === module) {
  runPoll().catch(err => {
    console.error('Poll failed:', err.message);
    process.exit(1);
  });
}
