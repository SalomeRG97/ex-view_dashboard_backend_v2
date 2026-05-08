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
 *   - If a type has NO inefficiency value, `ineficiencia_pct` and `perdida_kwh`
 *     are returned as null so the frontend can exclude them from charts 2 & 3.
 *
 * Energy loss:
 *   - Always calculated and returned in kWh.
 *   - Formula: 5 h/dia x 30 dias x capacidad_instalada_mw x 1000 x ineficiencia
 *   - Visual unit conversion (kWh <-> MWh) is handled by the frontend.
 *
 * @param {Array<{type: string, anomalias: number, inefficiency: number|null}>} rows
 * @param {Object} config
 * @param {number} config.total_paneles
 * @param {number} config.capacidad_instalada_mw
 * @returns {Array<Object>}
 */
function calculateMetrics(rows, config) {
  const { total_paneles, capacidad_instalada_mw } = config;

  return rows.map((row) => {
    const recuento  = Number(row.anomalias);
    const rawInef   = row.inefficiency != null ? Number(row.inefficiency) : null;
    const hasInef   = rawInef !== null && Number.isFinite(rawInef);

    // --- 4.2 Ineficiencia ---
    // (inefficiency * recuento) / total_paneles  ->  value in 0-1 range
    const ineficiencia     = hasInef ? (rawInef * recuento) / total_paneles : null;
    const ineficiencia_pct = hasInef
      ? parseFloat((ineficiencia * 100).toFixed(2))
      : null;

    // --- 4.3 Perdida energetica mensual ---
    // Always in kWh: 5 h/dia x 30 dias x capacidad_instalada_mw x 1000 x ineficiencia
    // Visual conversion (kWh -> MWh when >= 1000 kWh) is done on the frontend.
    let perdida_kwh = null;
    if (hasInef) {
      perdida_kwh = parseFloat(
        (5 * 30 * capacidad_instalada_mw * ineficiencia * 1000).toFixed(2)
      );
    }

    return {
      type:            row.type,
      recuento,
      ineficiencia_pct,   // null if type has no inefficiency
      perdida_kwh,        // always kWh; null if type has no inefficiency
    };
  });
}

module.exports = { calculateMetrics };
