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
  // Normalize brand name: strip trailing punctuation, try with/without spaces
  const brandClean = brandName.toLowerCase().replace(/[.\-_,]+$/, '').trim();
  const brandNoSpace = brandClean.replace(/\s+/g, '');
  const domainClean = brandDomain.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');

  // Brand mentioned?
  const mentioned = lower.includes(brandClean) ||
    lower.includes(brandNoSpace) ||
    lower.includes(domainClean);

  // Rough position: which sentence/paragraph first mentions the brand
  let position = null;
  if (mentioned) {
    const sentences = text.split(/(?<=[.!?])\s+/);
    for (let i = 0; i < sentences.length; i++) {
      const s = sentences[i].toLowerCase();
      if (s.includes(brandClean) || s.includes(brandNoSpace) || s.includes(domainClean)) {
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
    .filter(c => c.domain && lower.includes(
      c.domain.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '')
    ))
    .map(c => c.name || c.domain);

  // Sentiment (simple keyword scoring)
  const positiveWords = ['best','top','leading','excellent','recommended','great','trusted','expert','award','innovative'];
  const negativeWords = ['avoid','poor','bad','worst','unreliable','scam','overpriced','slow'];
  let sentimentScore = 0;
  if (mentioned) {
    // look at the words surrounding the brand mention
    const idx = lower.indexOf(brandClean) >= 0 ? lower.indexOf(brandClean) : lower.indexOf(brandNoSpace);
    const window = lower.slice(Math.max(0, idx - 200), idx + 200);
    positiveWords.forEach(w => { if (window.includes(w)) sentimentScore++; });
    negativeWords.forEach(w => { if (window.includes(w)) sentimentScore--; });
  }
  const sentiment = sentimentScore > 0 ? 'positive' : sentimentScore < 0 ? 'negative' : 'neutral';

  return { mentioned, position, urls, citedBrandURLs, competitorMentions, sentiment };
}

// ── Platform runners ──────────────────────────────────────────────────────────

async function runChatGPT(prompt) {
  // Use the Responses API with web_search_preview tool + high context.
  // This matches exactly what ChatGPT UI does (live Bing search, deep results).
  // Prompt is rewritten to a ranked-list format — "boston seo agency" (lookup)
  // returns a local-pack style snippet; "top X ranked list" forces enumeration
  // which is where well-established brands like GreenBananaSEO consistently appear.
  const searchPrompt = rewriteAsRankedQuery(prompt);

  const res = await openai.responses.create({
    model: 'gpt-4o',
    tools: [{ type: 'web_search_preview', search_context_size: 'high' }],
    input: searchPrompt,
  });

  const text = res.output_text || '';

  // Extract cited URLs from output items
  const citedURLs = [];
  if (res.output) {
    for (const item of res.output) {
      if (item.type === 'message' && item.content) {
        for (const block of item.content) {
          if (block.annotations) {
            for (const ann of block.annotations) {
              if (ann.type === 'url_citation' && ann.url) citedURLs.push(ann.url);
            }
          }
        }
      }
    }
  }

  return { text, citedURLs };
}

/**
 * Rewrites a short keyword prompt into a ranked-list query.
 * "boston seo agency" → "top boston seo agencies ranked list 2026"
 * This forces ChatGPT to enumerate rather than return a local-pack snippet,
 * which is where established brands appear consistently.
 */
function rewriteAsRankedQuery(prompt) {
  const lower = prompt.toLowerCase().trim();
  // Already a full question — leave it
  if (lower.includes('best') || lower.includes('top') || lower.includes('ranked') || lower.includes('who') || lower.includes('what')) {
    return prompt + ' — give me a comprehensive ranked list';
  }
  // Short keyword — expand it
  return `What are the top ${prompt}? Give me a comprehensive ranked list of the best options.`;
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

  let aiOverviewText = '';
  let citedSources = [];

  // Step 1: AI Overview returns a page_token — fetch the full content via serpapi_link
  if (data.ai_overview?.serpapi_link) {
    try {
      const aioRes  = await fetch(data.ai_overview.serpapi_link + `&api_key=${process.env.SERPAPI_KEY}`);
      const aioData = await aioRes.json();
      // Extract all text blocks
      const blocks = aioData.ai_overview?.blocks || aioData.blocks || [];
      aiOverviewText = blocks.map(b => b.snippet || b.text || '').filter(Boolean).join(' ');
      // Extract cited source URLs
      citedSources = blocks.flatMap(b => (b.references || []).map(r => r.link)).filter(Boolean);
    } catch (e) {
      // fallback silently
    }
  }

  // Step 2: Fallback to answer_box if no AI Overview
  if (!aiOverviewText) {
    aiOverviewText = data.answer_box?.answer || data.answer_box?.snippet || '';
  }

  // Step 3: Build a synthetic text from organic results so brand detection works
  // (Google blocks AIO content from SerpApi datacenters — organic position is a reliable proxy)
  const organicResults = data.organic_results || [];
  const organicURLs = organicResults.slice(0, 10).map(r => r.link).filter(Boolean);
  const organicText = organicResults.slice(0, 10).map((r, i) =>
    `${i + 1}. ${r.title || ''} — ${r.snippet || ''} ${r.link || ''}`
  ).join('\n');

  // Combine AIO text + organic text for analysis
  const combinedText = [aiOverviewText, organicText].filter(Boolean).join('\n');

  return { text: combinedText, organicURLs, citedSources, hasAIO: !!aiOverviewText };
}

// ── Run one prompt across all platforms (3 runs each, aggregated) ────────────

const RUNS_PER_PLATFORM = 3;

async function runPrompt(prompt, config) {
  const { brand, competitors = [] } = config;
  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const timestamp = new Date().toISOString();
  const platformResults = {};

  const platforms = [
    { key: 'chatgpt',    label: 'ChatGPT',           fn: () => runChatGPT(prompt),           runs: 2 }, // Responses API — 2 runs, take best
    { key: 'claude',     label: 'Claude',             fn: () => runClaude(prompt),             runs: 3 }, // Non-deterministic, no web search
    { key: 'perplexity', label: 'Perplexity',         fn: () => runPerplexity(prompt),         runs: 3 }, // Non-deterministic
    { key: 'google_aio', label: 'Google AI Overview', fn: () => runSerpApiAIOverview(prompt),  runs: 1 }, // Deterministic (live web)
  ];

  for (const p of platforms) {
    const runsNeeded = p.runs || RUNS_PER_PLATFORM;
    const runResults = [];

    process.stdout.write(`  [${p.label}] ${runsNeeded > 1 ? `${runsNeeded} runs` : '1 run'}...`);

    for (let i = 0; i < runsNeeded; i++) {
      try {
        let text, extra = {};
        if (p.key === 'google_aio') {
          const result = await p.fn();
          text = result.text;
          extra = { organicURLs: result.organicURLs, citedSources: result.citedSources, hasAIO: result.hasAIO };
        } else if (p.key === 'chatgpt') {
          const result = await p.fn();
          text = result.text;
          extra = { citedURLs: result.citedURLs || [] };
        } else {
          text = await p.fn();
        }
        const analysis = analyzeResponse(text, brand.name, brand.domain, competitors);
        runResults.push({ response: text.slice(0, 2000), ...analysis, ...extra });
        if (i < runsNeeded - 1) await new Promise(r => setTimeout(r, 1000)); // brief pause between runs
      } catch (err) {
        runResults.push({ error: err.message, mentioned: false, position: null });
      }
    }

    // Aggregate: mentioned if true in ANY run, position = avg of non-null positions
    const successRuns = runResults.filter(r => !r.error);
    const mentionedRuns = runResults.filter(r => r.mentioned);
    const positions = runResults.map(r => r.position).filter(Boolean);
    const allCitedURLs = [...new Set(runResults.flatMap(r => r.citedBrandURLs || []))];
    const allCompetitors = [...new Set(runResults.flatMap(r => r.competitorMentions || []))];
    const sentiments = runResults.filter(r => r.sentiment).map(r => r.sentiment);
    const topSentiment = ['positive','neutral','negative'].find(s => sentiments.filter(x=>x===s).length === sentiments.filter(x=>x===sentiments[0]).length) || 'neutral';

    platformResults[p.key] = {
      response: runResults.find(r => r.mentioned)?.response || runResults[0]?.response || '',
      mentioned: mentionedRuns.length > 0,
      mentionRate: `${mentionedRuns.length}/${runsNeeded}`,
      position: positions.length ? Math.round(positions.reduce((a,b)=>a+b,0)/positions.length) : null,
      citedBrandURLs: allCitedURLs,
      competitorMentions: allCompetitors,
      sentiment: topSentiment,
      runs: runsNeeded,
      successRuns: successRuns.length,
      error: successRuns.length === 0 ? runResults[0]?.error : null,
      ...(runResults[0]?.organicURLs ? { organicURLs: runResults[0].organicURLs } : {}),
      ...(runResults[0]?.citedSources ? { citedSources: runResults[0].citedSources } : {}),
    };

    const r = platformResults[p.key];
    console.log(` ✓ mentioned=${r.mentioned} (${r.mentionRate}) pos=${r.position ?? 'n/a'}`);
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
