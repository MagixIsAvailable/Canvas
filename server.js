const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const path = require('path');

const PORT = 3456;
const N8N_URL = 'http://localhost:5678';

const app = express();

// ── Proxy n8n webhook + healthz requests to n8n ──
const n8nProxy = createProxyMiddleware({
  target: N8N_URL,
  changeOrigin: true,
  on: {
    error(err, req, res) {
      console.error(`[proxy] n8n unreachable: ${err.message}`);
      res.status(502).json({ error: 'n8n is not running', detail: err.message });
    }
  }
});

app.use('/webhook', n8nProxy);
app.use('/healthz', n8nProxy);

// ── Serve frontend static files ──
const frontendDir = path.join(__dirname, 'CANVAS', 'frontend');
app.use(express.static(frontendDir));

// SPA fallback — serve index.html for any unmatched route
app.use((req, res) => {
  res.sendFile(path.join(frontendDir, 'index.html'));
});

// ── Start ──
app.listen(PORT, () => {
  console.log(`canvas server running at http://localhost:${PORT}`);
  console.log(`  frontend : ${frontendDir}`);
  console.log(`  n8n proxy: ${N8N_URL}/webhook/* → http://localhost:${PORT}/webhook/*`);
});
