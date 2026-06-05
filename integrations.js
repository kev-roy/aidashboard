/**
 * GA4 + Bing Webmaster Tools integrations
 */

require('dotenv').config();
const { google } = require('googleapis');
const fs   = require('fs');
const path = require('path');

const DATA_DIR    = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const GA4_TOKEN   = path.join(DATA_DIR, 'ga4_token.json');

// ── AI referral sources to look for in GA4 ────────────────────────────────────
const AI_SOURCES = [
  'chatgpt.com', 'chat.openai.com',
  'perplexity.ai',
  'claude.ai',
  'gemini.google.com', 'bard.google.com',
  'copilot.microsoft.com', 'bing.com',
  'you.com', 'phind.com', 'poe.com',
  'meta.ai', 'grok.x.ai',
];

// ══════════════════════════════════════════════════════════════════
// GA4 OAuth2
// ══════════════════════════════════════════════════════════════════

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GA4_CLIENT_ID,
    process.env.GA4_CLIENT_SECRET,
    process.env.GA4_REDIRECT_URI || 'http://localhost:3000/auth/ga4/callback'
  );
}

function getGA4AuthURL() {
  const oauth2 = getOAuthClient();
  return oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/analytics.readonly'],
  });
}

async function handleGA4Callback(code) {
  const oauth2 = getOAuthClient();
  const { tokens } = await oauth2.getToken(code);
  oauth2.setCredentials(tokens);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(GA4_TOKEN, JSON.stringify(tokens, null, 2));
  return tokens;
}

function loadGA4Tokens() {
  if (!fs.existsSync(GA4_TOKEN)) return null;
  return JSON.parse(fs.readFileSync(GA4_TOKEN, 'utf8'));
}

function getAuthenticatedClient() {
  const tokens = loadGA4Tokens();
  if (!tokens) return null;
  const oauth2 = getOAuthClient();
  oauth2.setCredentials(tokens);
  // Auto-refresh token if expired
  oauth2.on('tokens', (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    fs.writeFileSync(GA4_TOKEN, JSON.stringify(merged, null, 2));
  });
  return oauth2;
}

// ── Fetch AI referral traffic from GA4 ────────────────────────────────────────
async function fetchGA4AITraffic(propertyId, days = 30) {
  const auth = getAuthenticatedClient();
  if (!auth) throw new Error('GA4 not connected');

  const analyticsData = google.analyticsdata({ version: 'v1beta', auth });

  const response = await analyticsData.properties.runReport({
    property: `properties/${propertyId}`,
    requestBody: {
      dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
      dimensions: [
        { name: 'sessionSource' },
        { name: 'sessionMedium' },
        { name: 'landingPage' },
        { name: 'date' },
      ],
      metrics: [
        { name: 'sessions' },
        { name: 'totalUsers' },
        { name: 'bounceRate' },
        { name: 'averageSessionDuration' },
        { name: 'conversions' },
      ],
      dimensionFilter: {
        orGroup: {
          expressions: AI_SOURCES.map(source => ({
            filter: {
              fieldName: 'sessionSource',
              stringFilter: { matchType: 'CONTAINS', value: source, caseSensitive: false },
            },
          })),
        },
      },
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: 1000,
    },
  });

  const rows = response.data.rows || [];
  const results = rows.map(row => ({
    source:      row.dimensionValues[0].value,
    medium:      row.dimensionValues[1].value,
    landingPage: row.dimensionValues[2].value,
    date:        row.dimensionValues[3].value,
    sessions:    parseInt(row.metricValues[0].value) || 0,
    users:       parseInt(row.metricValues[1].value) || 0,
    bounceRate:  parseFloat(row.metricValues[2].value) || 0,
    avgDuration: parseFloat(row.metricValues[3].value) || 0,
    conversions: parseInt(row.metricValues[4].value) || 0,
  }));

  // Aggregate by source
  const bySource = {};
  results.forEach(r => {
    const key = r.source;
    if (!bySource[key]) bySource[key] = { source: key, sessions: 0, users: 0, conversions: 0, landingPages: {} };
    bySource[key].sessions    += r.sessions;
    bySource[key].users       += r.users;
    bySource[key].conversions += r.conversions;
    bySource[key].landingPages[r.landingPage] = (bySource[key].landingPages[r.landingPage] || 0) + r.sessions;
  });

  // Top landing pages per source
  const sources = Object.values(bySource).map(s => ({
    ...s,
    topPages: Object.entries(s.landingPages)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([page, sessions]) => ({ page, sessions })),
  })).sort((a, b) => b.sessions - a.sessions);

  // Daily totals for chart
  const dailyMap = {};
  results.forEach(r => {
    dailyMap[r.date] = (dailyMap[r.date] || 0) + r.sessions;
  });
  const daily = Object.entries(dailyMap)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, sessions]) => ({ date, sessions }));

  // Total stats
  const totalSessions    = results.reduce((s, r) => s + r.sessions, 0);
  const totalUsers       = results.reduce((s, r) => s + r.users, 0);
  const totalConversions = results.reduce((s, r) => s + r.conversions, 0);

  return { sources, daily, totalSessions, totalUsers, totalConversions, fetchedAt: new Date().toISOString() };
}

// ── List GA4 properties for the user to pick from ─────────────────────────────
async function listGA4Properties() {
  const auth = getAuthenticatedClient();
  if (!auth) throw new Error('GA4 not connected');

  const analyticsAdmin = google.analyticsadmin({ version: 'v1beta', auth });
  const res = await analyticsAdmin.properties.list({ filter: 'parent:accounts/-' });
  return (res.data.properties || []).map(p => ({
    id:          p.name.replace('properties/', ''),
    displayName: p.displayName,
    timeZone:    p.timeZone,
    industryCategory: p.industryCategory,
  }));
}

// ══════════════════════════════════════════════════════════════════
// BING WEBMASTER TOOLS
// ══════════════════════════════════════════════════════════════════

// Bing WMT API requires POST with JSON body (not GET)
async function bingPost(endpoint, apiKey, body = {}) {
  const url = `https://ssl.bing.com/webmaster/api.svc/json/${endpoint}`;
  const res  = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Accept': 'application/json' },
    body:    JSON.stringify({ apikey: apiKey, ...body }),
  });
  const text = await res.text();
  if (text.trim().startsWith('<')) throw new Error('Bing API returned HTML — check your API key');
  const data = JSON.parse(text);
  if (data.ErrorCode) throw new Error(data.Message || `Bing error code ${data.ErrorCode}`);
  return data.d || data;
}

async function fetchBingAIPrompts(apiKey, siteUrl, days = 30) {
  const endDate   = new Date();
  const startDate = new Date();
  startDate.setDate(endDate.getDate() - days);
  const fmt = d => d.toISOString().split('T')[0];

  const body = {
    siteUrl,
    startDate: fmt(startDate),
    endDate:   fmt(endDate),
  };

  // Query stats (search queries / AI prompts)
  let aiPrompts = [];
  try {
    const data = await bingPost('GetQueryStats', apiKey, body);
    aiPrompts = (Array.isArray(data) ? data : []).map(q => ({
      query:       q.Query,
      impressions: q.Impressions || 0,
      clicks:      q.Clicks      || 0,
      ctr:         q.Ctr         || 0,
      avgPosition: q.AvgPosition || 0,
    })).sort((a, b) => b.impressions - a.impressions);
  } catch (e) {
    console.log('Bing query stats error (non-fatal):', e.message);
  }

  // Page stats
  let pageStats = [];
  try {
    const data = await bingPost('GetPageStats', apiKey, body);
    pageStats = (Array.isArray(data) ? data : []).map(p => ({
      url:         p.Url,
      impressions: p.Impressions || 0,
      clicks:      p.Clicks      || 0,
      avgPosition: p.AvgPosition || 0,
    })).sort((a, b) => b.impressions - a.impressions).slice(0, 20);
  } catch (e) {
    console.log('Bing page stats error (non-fatal):', e.message);
  }

  return {
    aiPrompts:   aiPrompts.slice(0, 50),
    pageStats,
    fetchedAt:   new Date().toISOString(),
  };
}

// ── Validate Bing API key ──────────────────────────────────────────────────────
async function validateBingKey(apiKey, siteUrl) {
  // Bing WMT API requires POST, not GET
  const sites = await bingPost('GetSites', apiKey);
  const domain = siteUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const match  = (Array.isArray(sites) ? sites : []).find(s => s.Url?.includes(domain));
  return { valid: true, sites: Array.isArray(sites) ? sites : [], siteFound: !!match };
}

module.exports = {
  getGA4AuthURL,
  handleGA4Callback,
  loadGA4Tokens,
  fetchGA4AITraffic,
  listGA4Properties,
  fetchBingAIPrompts,
  validateBingKey,
  AI_SOURCES,
};
