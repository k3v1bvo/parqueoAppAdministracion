// server.js - servidor estático para ParqueoApp (listo para Railway)
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;

// Archivos estáticos desde /public (sirve .html por extensión)
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

// Healthcheck para deploy
app.get("/health", (req, res) => res.json({ ok: true }));

// Fallback: si la ruta no existe, lleva a login (puedes cambiar a dashboard si prefieres)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});
