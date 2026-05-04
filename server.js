require('dotenv').config();

const express = require('express');
const cors    = require('cors');

const { testConnection } = require('./db/connection');
const dashboardRoutes    = require('./routes/dashboard');

const app  = express();
const PORT = process.env.SERVER_PORT || 3000;

// ── CORS — Configuración de orígenes permitidos ──────────────
const allowedOrigins = ['https://ex-view.com', 'http://localhost:5500'];
app.use(cors({ 
  origin: function (origin, callback) {
    // Permite requests sin origen (ej. curl, postman) o los permitidos
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('No permitido por CORS'));
    }
  }
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── API Routes ──────────────────────────────────────────────
// Montadas en / → GET /assets, GET /dashboard-data
app.use('/', dashboardRoutes);

// ── 404 ─────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

// ── Boot ─────────────────────────────────────────────────────
(async () => {
  await testConnection();
  app.listen(PORT, () => {
    console.log(`🚀 EX-VIEW Solar API corriendo en http://localhost:${PORT}`);
    console.log(`   GET /assets?q=texto`);
    console.log(`   GET /dashboard-data?asset_name=...&total_paneles=...&puntos_calientes=...&capacidad_instalada_mw=...&unidad=MW`);
  });
})();
