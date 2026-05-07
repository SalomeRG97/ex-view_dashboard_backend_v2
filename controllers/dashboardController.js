const { pool }             = require('../db/connection');
const { calculateMetrics } = require('../lib/metrics');

// ============================================================
// GET /dashboard-data
// Query params: asset_name, total_paneles,
//               capacidad_instalada_mw, unidad
// Note: inefficiency is read from each record's JSON payload;
//       puntos_calientes is no longer used for metric calculation.
// ============================================================
async function getDashboardData(req, res) {
  try {
    const {
      asset_name,
      total_paneles,
      capacidad_instalada_mw,
      unidad,
      files_url,
    } = req.query;

    // --- Validation ---
    const errors = [];
    if (!asset_name || typeof asset_name !== 'string' || !asset_name.trim())
      errors.push('asset_name es requerido');
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
      [asset_name.trim()]
    );

    const config = {
      total_paneles:          Number(total_paneles),
      capacidad_instalada_mw: Number(capacidad_instalada_mw),
      unidad,
    };

    if (!anomalyRows.length) {
      return res.status(200).json({
        data:       [],
        files_url:  files_url || null,
        unidad,
        asset_name: asset_name.trim(),
      });
    }

    // --- Calculate metrics ---
    const metrics = calculateMetrics(anomalyRows, config);

    return res.status(200).json({
      data:       metrics,
      files_url:  files_url || null,
      unidad,
      asset_name: asset_name.trim(),
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

module.exports = { getDashboardData, getAssets };
