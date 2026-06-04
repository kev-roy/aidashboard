require('dotenv').config();
const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const cron     = require('node-cron');
const { runPoll } = require('./poller');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR     = path.join(__dirname, 'data');
const CONFIG_FILE  = path.join(DATA_DIR, 'config.json');
const RESULTS_FILE = path.join(DATA_DIR, 'results.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Config ───────────────────────────────────────────────────────────────────

app.post('/api/setup', (req, res) => {
  const config = req.body;
  if (!config.brand?.name) return res.status(400).json({ ok: false, error: 'Missing brand info' });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  console.log(`✅ Setup saved for: ${config.brand.name}`);
  res.json({ ok: true });
});

app.get('/api/config', (req, res) => {
  if (fs.existsSync(CONFIG_FILE)) {
    res.json(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
  } else {
    res.json({ setupComplete: false });
  }
});

// ── Results ───────────────────────────────────────────────────────────────────

app.get('/api/results', (req, res) => {
  if (!fs.existsSync(RESULTS_FILE)) return res.json([]);
  res.json(JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8')));
});

// Summary stats for the dashboard
app.get('/api/stats', (req, res) => {
  if (!fs.existsSync(RESULTS_FILE) || !fs.existsSync(CONFIG_FILE)) {
    return res.json({ ready: false });
  }
  const results = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
  const config  = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  res.json(buildStats(results, config));
});

// ── Manual poll trigger ───────────────────────────────────────────────────────

let pollRunning = false;

app.post('/api/poll', async (req, res) => {
  if (pollRunning) return res.status(429).json({ ok: false, error: 'Poll already running' });
  if (!fs.existsSync(CONFIG_FILE)) return res.status(400).json({ ok: false, error: 'Setup not complete' });
  res.json({ ok: true, message: 'Poll started — check console for progress' });
  pollRunning = true;
  try {
    await runPoll();
  } finally {
    pollRunning = false;
  }
});

app.get('/api/poll/status', (req, res) => {
  res.json({ running: pollRunning });
});

// ── Daily cron at 6am ─────────────────────────────────────────────────────────

cron.schedule('0 6 * * *', async () => {
  if (!fs.existsSync(CONFIG_FILE)) return;
  if (pollRunning) return;
  console.log('⏰ Daily poll triggered by cron');
  pollRunning = true;
  try { await runPoll(); } finally { pollRunning = false; }
});

// ── Stats builder ─────────────────────────────────────────────────────────────

function buildStats(results, config) {
  const platforms = ['chatgpt', 'claude', 'perplexity', 'google_aio'];
  const platformLabels = { chatgpt: 'ChatGPT', claude: 'Claude', perplexity: 'Perplexity', google_aio: 'Google AI Overviews' };

  // Group results by date
  const byDate = {};
  results.forEach(r => {
    const date = r.timestamp.slice(0, 10);
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push(r);
  });

  const dates = Object.keys(byDate).sort();
  const last30 = dates.slice(-30);

  // Per-date citation & mention counts
  const citationsOverTime = last30.map(date => ({
    date,
    count: byDate[date].reduce((sum, r) =>
      sum + platforms.filter(p => r.platformResults[p]?.citedBrandURLs?.length > 0).length, 0),
  }));

  const mentionsOverTime = last30.map(date => ({
    date,
    count: byDate[date].reduce((sum, r) =>
      sum + platforms.filter(p => r.platformResults[p]?.mentioned).length, 0),
  }));

  // Totals
  const totalCitations  = results.reduce((s, r) => s + platforms.filter(p => r.platformResults[p]?.citedBrandURLs?.length > 0).length, 0);
  const totalMentions   = results.reduce((s, r) => s + platforms.filter(p => r.platformResults[p]?.mentioned).length, 0);
  const totalRuns       = results.length * platforms.length;

  // Avg position
  const positions = results.flatMap(r => platforms.map(p => r.platformResults[p]?.position).filter(Boolean));
  const avgPosition = positions.length ? (positions.reduce((a, b) => a + b, 0) / positions.length).toFixed(1) : null;

  // Platform coverage (% of runs brand was mentioned)
  const engineCoverage = platforms.map(p => {
    const runs = results.filter(r => r.platformResults[p] && !r.platformResults[p].error);
    const mentions = runs.filter(r => r.platformResults[p].mentioned).length;
    return {
      platform: p,
      label: platformLabels[p],
      pct: runs.length ? Math.round((mentions / runs.length) * 100) : 0,
      runs: runs.length,
    };
  });

  // Top cited URLs
  const urlCounts = {};
  results.forEach(r => {
    platforms.forEach(p => {
      (r.platformResults[p]?.citedBrandURLs || []).forEach(url => {
        urlCounts[url] = (urlCounts[url] || 0) + 1;
      });
    });
  });
  const topURLs = Object.entries(urlCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([url, count]) => ({ url, count }));

  // Sentiment
  const sentiments = { positive: 0, neutral: 0, negative: 0 };
  results.forEach(r => {
    platforms.forEach(p => {
      const s = r.platformResults[p]?.sentiment;
      if (s) sentiments[s]++;
    });
  });
  const sentimentTotal = Object.values(sentiments).reduce((a, b) => a + b, 0);
  const sentimentPcts  = sentimentTotal ? {
    positive: Math.round((sentiments.positive / sentimentTotal) * 100),
    neutral:  Math.round((sentiments.neutral  / sentimentTotal) * 100),
    negative: Math.round((sentiments.negative / sentimentTotal) * 100),
  } : { positive: 0, neutral: 0, negative: 0 };

  // Competitor share from latest results
  const competitorCounts = {};
  const compDomains = config.competitors?.map(c => ({ ...c, key: c.domain.replace(/^www\./, '') })) || [];
  results.forEach(r => {
    platforms.forEach(p => {
      const text = (r.platformResults[p]?.response || '').toLowerCase();
      compDomains.forEach(c => {
        if (text.includes(c.key.toLowerCase())) {
          competitorCounts[c.name || c.domain] = (competitorCounts[c.name || c.domain] || 0) + 1;
        }
      });
    });
  });

  // Top prompts by mention rate
  const promptStats = config.prompts.map(prompt => {
    const promptRuns = results.filter(r => r.prompt === prompt);
    const mentions = promptRuns.reduce((s, r) => s + platforms.filter(p => r.platformResults[p]?.mentioned).length, 0);
    const total = promptRuns.length * platforms.length;
    return { prompt, pct: total ? Math.round((mentions / total) * 100) : 0, runs: promptRuns.length };
  }).sort((a, b) => b.pct - a.pct).slice(0, 10);

  return {
    ready: true,
    lastUpdated: results.at(-1)?.timestamp || null,
    totalCitations,
    totalMentions,
    totalRuns,
    avgPosition,
    citationsOverTime,
    mentionsOverTime,
    engineCoverage,
    topURLs,
    sentimentPcts,
    competitorCounts,
    promptStats,
    config: {
      brandName: config.brand.name,
      brandDomain: config.brand.domain,
      competitors: config.competitors,
      promptCount: config.prompts.length,
    },
  };
}

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🍌 AI Visibility Tracker running at http://localhost:${PORT}`);
  console.log(`   Dashboard: http://localhost:${PORT}/`);
  console.log(`   Setup:     http://localhost:${PORT}/setup.html`);
  console.log(`   Daily poll scheduled at 6:00 AM\n`);
});
