/**
 * calculateMetrics
 * ----------------
 * Pure business-logic function (no DB calls).
 * Receives anomaly rows (already aggregated per type) and installation config,
 * returns enriched metrics array ready for the API response.
 *
 * Ineficiencia logic:
 *   - Each row may carry an `inefficiency` value (0–1) extracted from the
 *     JSON payload stored in the DB. The value is the same for every record
 *     of the same anomaly type.
 *   - Formula: (inefficiency * recuento) / total_paneles
 *   - If a type has NO inefficiency value, `ineficiencia_pct` and `perdida`
 *     are returned as null so the frontend can exclude them from charts 2 & 3.
 *
 * @param {Array<{type: string, anomalias: number, inefficiency: number|null}>} rows
 * @param {Object} config
 * @param {number} config.total_paneles
 * @param {number} config.capacidad_instalada_mw
 * @param {string} config.unidad   - "MW" | "kW"
 * @returns {Array<Object>}
 */
function calculateMetrics(rows, config) {
  const { total_paneles, capacidad_instalada_mw, unidad } = config;

  return rows.map((row) => {
    const recuento      = Number(row.anomalias);
    const rawInef       = row.inefficiency != null ? Number(row.inefficiency) : null;
    const hasInef       = rawInef !== null && Number.isFinite(rawInef);

    // --- 4.2 Ineficiencia ---
    // (inefficiency * recuento) / total_paneles  →  value in 0–1 range
    const ineficiencia     = hasInef ? (rawInef * recuento) / total_paneles : null;
    const ineficiencia_pct = hasInef
      ? parseFloat((ineficiencia * 100).toFixed(2))
      : null;

    // --- 4.3 Pérdida energética mensual ---
    // Base: 5 h/día × 30 días × capacidad_instalada_mw × ineficiencia
    let perdida = null;
    if (hasInef) {
      const perdida_mw = 5 * 30 * capacidad_instalada_mw * ineficiencia;
      perdida = unidad === 'kW'
        ? parseFloat((perdida_mw * 1000).toFixed(4))
        : parseFloat(perdida_mw.toFixed(4));
    }

    return {
      type:            row.type,
      recuento,
      ineficiencia_pct,   // null if type has no inefficiency
      perdida,            // null if type has no inefficiency
    };
  });
}

module.exports = { calculateMetrics };
