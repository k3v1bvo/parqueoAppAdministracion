// Servidor estático para /public (sin backend)
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// evita 404 por favicon
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// healthcheck
app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`✅ Frontend sirviendo /public en http://localhost:${PORT}/login.html`);
});
