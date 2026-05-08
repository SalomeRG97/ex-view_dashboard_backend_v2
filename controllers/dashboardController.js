const { pool } = require('../db/connection');
const { calculateMetrics } = require('../lib/metrics');

// ============================================================
// GET /dashboard-data
// Query params: installation, total_paneles,
//               capacidad_instalada_mw, unidad
// Note: inefficiency is read from each record's JSON payload;
//       puntos_calientes is no longer used for metric calculation.
// ============================================================
async function getDashboardData(req, res) {
  try {
    const {
      installation,
      total_paneles,
      modulos_desconectados,
      capacidad_instalada_mw,
      unidad,
      files_url,
    } = req.query;

    // --- Validation ---
    const errors = [];
    if (!installation || typeof installation !== 'string' || !installation.trim())
      errors.push('installation es requerido');
    if (!Number.isFinite(Number(total_paneles)) || Number(total_paneles) <= 0)
      errors.push('total_paneles debe ser un número positivo');
    if (!Number.isFinite(Number(capacidad_instalada_mw)) || Number(capacidad_instalada_mw) <= 0)
      errors.push('capacidad_instalada_mw debe ser un número positivo');
    if (!['MW', 'kW'].includes(unidad))
      errors.push('unidad debe ser "MW" o "kW"');

    if (errors.length) {
      return res.status(400).json({ error: 'Parámetros inválidos', details: errors });
    }

    // --- Query anomalies (READ ONLY) ---
    // MAX(JSON_EXTRACT) returns the inefficiency for the type
    // (same value for all records of that type; NULL if field absent).
    const [anomalyRows] = await pool.execute(
      `SELECT
         type,
         COUNT(*)                                    AS anomalias,
         MAX(JSON_EXTRACT(observation_metadata, '$.inefficiency'))   AS inefficiency
       FROM ObservationSummary
       WHERE asset_name = ?
       GROUP BY type
       ORDER BY anomalias DESC`,
      [installation.trim()]
    );

    const config = {
      total_paneles: Number(total_paneles),
      capacidad_instalada_mw: Number(capacidad_instalada_mw),
      unidad,
    };

    if (!anomalyRows.length) {
      return res.status(200).json({
        data: [],
        files_url: files_url || null,
        unidad,
        installation: installation.trim(),
      });
    }

    // Inject modulos_desconectados into the string_failure row (if present)
    // so calculateMetrics can use it as recuento for that special type.
    const enrichedRows = anomalyRows.map(row =>
      row.type === 'string_failure'
        ? { ...row, modulos_desconectados: Number(modulos_desconectados) || 0 }
        : row
    );

    // --- Calculate metrics ---
    const metrics = calculateMetrics(enrichedRows, config);

    return res.status(200).json({
      data: metrics,
      files_url: files_url || null,
      unidad,
      installation: installation.trim(),
    });
  } catch (err) {
    console.error('[getDashboardData]', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// ============================================================
// GET /assets?q=texto
// Autocomplete para asset_name
// ============================================================
async function getAssets(req, res) {
  try {
    const q = (req.query.q || '').trim();
    const pattern = `%${q}%`;

    const [rows] = await pool.execute(
      `SELECT DISTINCT asset_name
       FROM ObservationSummary
       WHERE asset_name LIKE ?
       ORDER BY asset_name
       LIMIT 20`,
      [pattern]
    );

    return res.status(200).json(rows.map(r => r.asset_name));
  } catch (err) {
    console.error('[getAssets]', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// ============================================================
// POST /login
// Auth simple MVP
// ============================================================
async function loginAdmin(req, res) {
  try {
    const { username, password } = req.body;

    // Credenciales (puedes cambiarlas en las variables de entorno de Render)
    const validUser = process.env.ADMIN_USER || 'aDminEXvIEW';
    const validPass = process.env.ADMIN_PASS || 'solarSuperaDmin2026';

    if (username === validUser && password === validPass) {
      return res.status(200).json({ success: true });
    }

    return res.status(401).json({ success: false, error: 'Credenciales incorrectas' });
  } catch (err) {
    console.error('[loginAdmin]', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

module.exports = { getDashboardData, getAssets, loginAdmin };
