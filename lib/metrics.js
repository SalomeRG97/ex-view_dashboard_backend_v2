/**
 * calculateMetrics
 * ----------------
 * Pure business-logic function (no DB calls).
 * Receives raw anomaly counts per type and installation config,
 * returns enriched metrics array ready for the API response.
 *
 * @param {Array<{type: string, anomalias: number}>} rows  - DB result rows
 * @param {Object} config                                  - dashboard config
 * @param {number} config.total_paneles
 * @param {number} config.puntos_calientes
 * @param {number} config.capacidad_instalada_mw
 * @param {string} config.unidad   - "MW" | "kW"
 * @returns {Array<Object>}
 */
function calculateMetrics(rows, config) {
  const {
    total_paneles,
    puntos_calientes,
    capacidad_instalada_mw,
    unidad,
  } = config;

  return rows.map((row) => {
    const recuento = Number(row.anomalias);

    // --- 4.2 Ineficiencia ---
    const paneles_afectados = Math.min(
      recuento * puntos_calientes,
      total_paneles
    );
    const ineficiencia     = paneles_afectados / total_paneles;          // 0–1
    const ineficiencia_pct = parseFloat((ineficiencia * 100).toFixed(2));

    // --- 4.3 Pérdida energética mensual ---
    const perdida_mw = 5 * 30 * capacidad_instalada_mw * ineficiencia;
    const perdida    = unidad === 'kW'
      ? parseFloat((perdida_mw * 1000).toFixed(4))
      : parseFloat(perdida_mw.toFixed(4));

    return {
      type:            row.type,
      recuento,
      ineficiencia_pct,
      perdida,
    };
  });
}

module.exports = { calculateMetrics };
