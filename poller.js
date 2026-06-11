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
  // Write to a temp file first, then rename — prevents corruption if interrupted mid-write
  const tmp = RESULTS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(results, null, 2));
  fs.renameSync(tmp, RESULTS_FILE);
}

/**
 * Detect brand mentions, position, and cited URLs in a response.
 */
function analyzeResponse(text, brandName, brandDomain, competitors = []) {
  const lower = text.toLowerCase();
  // Normalize brand name: strip trailing punctuation
  const brandClean   = brandName.toLowerCase().replace(/[.\-_,]+$/, '').trim();
  const brandNoSpace = brandClean.replace(/\s+/g, '');
  const domainClean  = brandDomain.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');

  // Also generate camelCase-split variants:
  // "greenbananaseo" → ["green", "banana", "seo"] → "green banana seo", "greenbanana seo"
  const splitVariants = [];
  // Split on uppercase boundaries (handles "GreenBananaSEO" → "green banana seo")
  const camelSplit = brandName.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase().trim();
  if (camelSplit !== brandClean) splitVariants.push(camelSplit);
  // Try "greenbanana seo" (split only last word off)
  if (brandNoSpace.length > 4) {
    ['seo','agency','marketing','digital'].forEach(suffix => {
      if (brandNoSpace.endsWith(suffix)) {
        splitVariants.push(brandNoSpace.slice(0, -suffix.length) + ' ' + suffix);
      }
    });
  }

  // Brand mentioned?
  const mentioned = lower.includes(brandClean)
    || lower.includes(brandNoSpace)
    || lower.includes(domainClean)
    || splitVariants.some(v => lower.includes(v));

  // Rough position: which sentence/paragraph first mentions the brand
  let position = null;
  if (mentioned) {
    const sentences = text.split(/(?<=[.!?])\s+/);
    for (let i = 0; i < sentences.length; i++) {
      const s = sentences[i].toLowerCase();
      if (s.includes(brandClean) || s.includes(brandNoSpace) || s.includes(domainClean) || splitVariants.some(v=>s.includes(v))) {
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
    const idx = [brandClean, brandNoSpace, domainClean, ...splitVariants].reduce((found, v) => found >= 0 ? found : lower.indexOf(v), -1);
    const window = lower.slice(Math.max(0, idx - 200), idx + 200);
    positiveWords.forEach(w => { if (window.includes(w)) sentimentScore++; });
    negativeWords.forEach(w => { if (window.includes(w)) sentimentScore--; });
  }
  const sentiment = sentimentScore > 0 ? 'positive' : sentimentScore < 0 ? 'negative' : 'neutral';

  return { mentioned, position, urls, citedBrandURLs, competitorMentions, sentiment };
}

// ── Timeout wrapper ───────────────────────────────────────────────────────────
const PLATFORM_TIMEOUT_MS = 45000; // 45s per platform call

function withTimeout(promise, ms = PLATFORM_TIMEOUT_MS, label = '') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms/1000}s${label ? ' — ' + label : ''}`)), ms)
    ),
  ]);
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
  // Use claude-sonnet-4-6 with web_search tool — matches exactly what Claude.ai
  // does when it shows "Searched the web" (the same model/behavior in the screenshot)
  const searchPrompt = rewriteAsRankedQuery(prompt);

  const res = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,  // Shorter to complete faster; web search still fires
    tools: [{
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: 5,
    }],
    messages: [{ role: 'user', content: searchPrompt }],
  });

  // Concatenate all text blocks — Claude web search returns 'server_tool_use',
  // 'web_search_tool_result', and 'text' blocks interleaved. We want all text.
  const text = res.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n');

  // Also pull text from web_search_tool_result content blocks (search snippets)
  // so brand detection works even if answer was truncated
  const snippetText = res.content
    .filter(b => b.type === 'web_search_tool_result')
    .flatMap(b => b.content || [])
    .filter(c => c.type === 'document')
    .map(c => c.document?.text || c.text || '')
    .join('\n');

  const fullText = [text, snippetText].filter(Boolean).join('\n');

  // Extract cited URLs from search result documents
  const citedURLs = res.content
    .filter(b => b.type === 'web_search_tool_result')
    .flatMap(b => b.content || [])
    .filter(c => c.type === 'document' && c.source?.url)
    .map(c => c.source.url);

  return { text: fullText, citedURLs };
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

  // ChatGPT, Perplexity, Google AIO run in parallel (fast)
  // Claude runs separately after — its web search takes 40-50s and slows batches
  const fastPlatforms = [
    { key: 'chatgpt',    label: 'ChatGPT',    timeout: 30000,
      fn: async () => { const r = await runChatGPT(prompt); return { text: r.text, extra: { citedURLs: r.citedURLs||[] } }; } },
    { key: 'perplexity', label: 'Perplexity', timeout: 30000,
      fn: async () => { const t = await runPerplexity(prompt); return { text: t, extra: {} }; } },
    { key: 'google_aio', label: 'Google AIO', timeout: 25000,
      fn: async () => { const r = await runSerpApiAIOverview(prompt); return { text: r.text, extra: { organicURLs: r.organicURLs, citedSources: r.citedSources, hasAIO: r.hasAIO } }; } },
  ];
  const claudePlatform = { key: 'claude', label: 'Claude', timeout: 55000,
    fn: async () => { const r = await runClaude(prompt); return { text: r.text, extra: { citedURLs: r.citedURLs||[] } }; }
  };
  const platforms = [...fastPlatforms, claudePlatform];

  process.stdout.write(`  [3 fast + Claude]...`);

  // Run fast platforms in parallel, Claude sequentially after
  const [fastSettled, claudeSettled] = await Promise.all([
    Promise.allSettled(fastPlatforms.map(p => withTimeout(p.fn(), p.timeout, p.label))),
    withTimeout(claudePlatform.fn(), claudePlatform.timeout, 'Claude')
      .then(r => ({ status: 'fulfilled', value: r }))
      .catch(e => ({ status: 'rejected', reason: e })),
  ]);
  const settled = [...fastSettled, claudeSettled];

  platforms.forEach((p, i) => {
    const result = settled[i];
    if (result.status === 'rejected') {
      platformResults[p.key] = { error: result.reason?.message || 'failed', mentioned: false, mentionRate: '0/1', position: null, citedBrandURLs: [], competitorMentions: [], sentiment: 'neutral', runs: 1, successRuns: 0 };
      process.stdout.write(` ✗${p.label}`);
    } else {
      const { text, extra } = result.value;
      const analysis = analyzeResponse(text || '', brand.name, brand.domain, competitors);
      platformResults[p.key] = {
        response: (text || '').slice(0, 2000),
        ...analysis,
        ...extra,
        mentioned: analysis.mentioned,
        mentionRate: analysis.mentioned ? '1/1' : '0/1',
        runs: 1,
        successRuns: 1,
      };
      process.stdout.write(` ✓${p.label}(${analysis.mentioned ? 'YES' : 'no'})`);
    }
  });
  console.log();

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

  // Run prompts in batches of 3 in parallel — 14 prompts = ~5 batches × 30s = ~2.5 min
  const BATCH_SIZE = 3;
  for (let i = 0; i < config.prompts.length; i += BATCH_SIZE) {
    const batch = config.prompts.slice(i, i + BATCH_SIZE);
    console.log(`\nBatch ${Math.floor(i/BATCH_SIZE)+1}: prompts ${i+1}–${Math.min(i+BATCH_SIZE, config.prompts.length)} of ${config.prompts.length}`);
    const batchResults = await Promise.all(batch.map(p => runPrompt(p, config)));
    results.push(...batchResults);
    // Save after each batch so partial results are kept if interrupted
    saveResults(results);
    console.log(`  ✓ Batch saved (${results.length} total)`);
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
