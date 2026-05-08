require('dotenv').config();

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const { testConnection } = require('./db/connection');
const dashboardRoutes = require('./routes/dashboard');

const app = express();
const PORT = process.env.PORT || process.env.SERVER_PORT || 5000;

// ── Seguridad e iframes ──────────────────────────────────────
// Configuramos Content-Security-Policy para permitir iframe embebido
// y evitamos que Express o middlewares bloqueen con X-Frame-Options.
app.use((req, res, next) => {
  res.removeHeader('X-Frame-Options');
  
  // Especifica aquí los dominios permitidos para embeber tu iframe
  const iframeDomains = "'self' https://ex-view.com";
  res.setHeader('Content-Security-Policy', `frame-ancestors ${iframeDomains};`);
  next();
});

// ── Rate Limiting ────────────────────────────────────────────
// MVP: Limitar a 100 peticiones cada 15 min por IP
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Demasiadas peticiones desde esta IP. Intenta más tarde.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── CORS — Configuración de orígenes permitidos ──────────────
const allowedOrigins = ['https://ex-view.com', 'http://localhost:5500', 'https://salomerg97.github.io', 'http://127.0.0.1:5500'];
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
// Aplicamos el rate limiter a estas rutas críticas
app.use('/assets', apiLimiter);
app.use('/dashboard-data', apiLimiter);
app.use('/', dashboardRoutes);

// ── 404 ─────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

// ── Boot ─────────────────────────────────────────────────────
(async () => {
  try {
    await testConnection();
  } catch (error) {
    console.error("⚠️ Error inicial al conectar a la BD. Revisa las variables en Render:", error);
  }

  // Render necesita que el servidor escuche en 0.0.0.0 para poder direccionar el tráfico
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 EX-VIEW Solar API corriendo en el puerto ${PORT}`);
    console.log(`   GET /assets?q=texto`);
    console.log(`   GET /dashboard-data?asset_name=...&total_paneles=...&puntos_calientes=...&capacidad_instalada_mw=...&unidad=MW`);
  });
})();
