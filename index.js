require('dotenv').config();
const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const cron     = require('node-cron');
const { runPoll } = require('./poller');
const {
  getGA4AuthURL, handleGA4Callback, loadGA4Tokens,
  fetchGA4AITraffic, listGA4Properties,
  fetchBingAIPrompts, validateBingKey,
} = require('./integrations');

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

// ── GA4 OAuth ────────────────────────────────────────────────────────────────

const GA4_DATA_FILE  = path.join(DATA_DIR, 'ga4_data.json');
const BING_DATA_FILE = path.join(DATA_DIR, 'bing_data.json');

// Save GA4 OAuth creds to .env and reload
app.post('/api/ga4/set-creds', (req, res) => {
  const { clientId, clientSecret } = req.body;
  if (!clientId || !clientSecret) return res.status(400).json({ ok: false, error: 'Missing credentials' });
  const envPath = require('path').join(__dirname, '.env');
  let env = require('fs').existsSync(envPath) ? require('fs').readFileSync(envPath, 'utf8') : '';
  const set = (key, val) => {
    const re = new RegExp(`^${key}=.*$`, 'm');
    return re.test(env) ? env.replace(re, `${key}="${val}"`) : env + `\n${key}="${val}"`;
  };
  env = set('GA4_CLIENT_ID', clientId);
  env = set('GA4_CLIENT_SECRET', clientSecret);
  require('fs').writeFileSync(envPath, env);
  process.env.GA4_CLIENT_ID     = clientId;
  process.env.GA4_CLIENT_SECRET = clientSecret;
  res.json({ ok: true });
});

app.get('/auth/ga4', (req, res) => {
  if (!process.env.GA4_CLIENT_ID) {
    return res.status(400).send('GA4_CLIENT_ID not set in .env — see Settings for setup instructions.');
  }
  res.redirect(getGA4AuthURL());
});

app.get('/auth/ga4/callback', async (req, res) => {
  try {
    await handleGA4Callback(req.query.code);
    res.send('<script>window.opener.postMessage("ga4_connected","*");window.close();</script>');
  } catch (e) {
    res.status(500).send('OAuth error: ' + e.message);
  }
});

app.get('/api/ga4/status', (req, res) => {
  const tokens = loadGA4Tokens();
  res.json({ connected: !!tokens, hasClientId: !!process.env.GA4_CLIENT_ID });
});

app.get('/api/ga4/properties', async (req, res) => {
  try {
    const props = await listGA4Properties();
    res.json({ ok: true, properties: props });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/ga4/fetch', async (req, res) => {
  const { propertyId, days = 30 } = req.body;
  if (!propertyId) return res.status(400).json({ ok: false, error: 'propertyId required' });
  try {
    const data = await fetchGA4AITraffic(propertyId, days);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(GA4_DATA_FILE, JSON.stringify({ propertyId, ...data }, null, 2));
    res.json({ ok: true, data });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.get('/api/ga4/data', (req, res) => {
  if (!fs.existsSync(GA4_DATA_FILE)) return res.json({ connected: false });
  res.json({ connected: true, ...JSON.parse(fs.readFileSync(GA4_DATA_FILE, 'utf8')) });
});

app.delete('/auth/ga4', (req, res) => {
  const TOKEN = path.join(DATA_DIR, 'ga4_token.json');
  if (fs.existsSync(TOKEN)) fs.unlinkSync(TOKEN);
  if (fs.existsSync(GA4_DATA_FILE)) fs.unlinkSync(GA4_DATA_FILE);
  res.json({ ok: true });
});

// ── Bing Webmaster Tools ──────────────────────────────────────────────────────

app.post('/api/bing/validate', async (req, res) => {
  const { apiKey, siteUrl } = req.body;
  if (!apiKey || !siteUrl) return res.status(400).json({ ok: false, error: 'apiKey and siteUrl required' });
  try {
    const result = await validateBingKey(apiKey, siteUrl);
    // Save key to config
    if (fs.existsSync(CONFIG_FILE)) {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      config.bingApiKey = apiKey;
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    }
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/bing/fetch', async (req, res) => {
  const { days = 30 } = req.body;
  const config = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) : {};
  const apiKey  = config.bingApiKey;
  const siteUrl = config.brand?.domain ? `https://${config.brand.domain}` : null;
  if (!apiKey || !siteUrl) return res.status(400).json({ ok: false, error: 'Bing API key not configured' });
  try {
    const data = await fetchBingAIPrompts(apiKey, siteUrl, days);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(BING_DATA_FILE, JSON.stringify(data, null, 2));
    res.json({ ok: true, data });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.get('/api/bing/data', (req, res) => {
  const config = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) : {};
  if (!fs.existsSync(BING_DATA_FILE)) return res.json({ connected: !!config.bingApiKey, hasData: false });
  res.json({ connected: true, hasData: true, ...JSON.parse(fs.readFileSync(BING_DATA_FILE, 'utf8')) });
});

app.delete('/api/bing', (req, res) => {
  if (fs.existsSync(BING_DATA_FILE)) fs.unlinkSync(BING_DATA_FILE);
  if (fs.existsSync(CONFIG_FILE)) {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    delete config.bingApiKey;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  }
  res.json({ ok: true });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🍌 AI Visibility Tracker running at http://localhost:${PORT}`);
  console.log(`   Dashboard: http://localhost:${PORT}/`);
  console.log(`   Setup:     http://localhost:${PORT}/setup.html`);
  console.log(`   Daily poll scheduled at 6:00 AM\n`);
});
