const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();
const PORT = 3000;

const CONFIG_FILE = path.join(__dirname, 'data', 'config.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Save setup config
app.post('/api/setup', (req, res) => {
  const config = req.body;
  if (!config.brand || !config.brand.name) {
    return res.status(400).json({ ok: false, error: 'Missing brand info' });
  }
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  console.log(`✅ Setup complete for: ${config.brand.name}`);
  res.json({ ok: true });
});

// Get current config (for dashboard to load)
app.get('/api/config', (req, res) => {
  if (fs.existsSync(CONFIG_FILE)) {
    res.json(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
  } else {
    res.json({ setupComplete: false });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Setup flow:    http://localhost:${PORT}/setup.html`);
});
