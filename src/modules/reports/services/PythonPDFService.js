'use strict';

/**
 * PythonPDFService.js
 *
 * Puente entre Node.js y el script Python `pdf_pipeline/pdf_filter.py`.
 * Invoca Python como proceso hijo (child_process.spawn), le pasa la
 * configuración por stdin como JSON y recibe el PDF binario por stdout.
 *
 * Restricciones:
 *  - El proceso Python no escribe archivos temporales.
 *  - La comunicación es: stdin → JSON payload, stdout → PDF bytes, stderr → logs.
 *  - Si Python termina con código != 0 o stdout comienza con '{"error"', se lanza Error.
 */

const { spawn } = require('child_process');
const path       = require('path');

// Ruta al script Python relativa al directorio raíz del backend
const PYTHON_SCRIPT = path.join(__dirname, '..', '..', '..', '..', 'pdf_pipeline', 'pdf_filter.py');

// Comando Python: en producción (Linux/Docker) es 'python3', en Windows puede ser 'python'
const PYTHON_CMD = process.env.PYTHON_CMD || (process.platform === 'win32' ? 'python' : 'python3');

// Tiempo máximo de espera para que Python genere el PDF (ms).
// Para 1.6 GB: ~22 min descarga + ~5 min pikepdf = ~27 min → 40 min de margen.
const PYTHON_TIMEOUT_MS = parseInt(process.env.PYTHON_TIMEOUT_MS || '2400000', 10); // 40 minutos

class PythonPDFService {
  /**
   * Genera el PDF filtrado llamando al script Python.
   *
   * @param {object} options
   * @param {string}       options.pdfUrl           - URL pública del PDF original en Hostinger
   * @param {Array<object>} options.selectedSections - Secciones seleccionadas por el usuario
   *   Cada objeto: { pageStart, pageEnd, label, type, id?, isSub? }
   * @param {string}       [options.dashboardName]  - Nombre del dashboard
   * @returns {Promise<Buffer>} - Buffer con el PDF filtrado listo para streaming
   */
  async generate({ pdfUrl, selectedSections, allSections = [], dashboardName = 'Informe Solar' }) {
    const payload = JSON.stringify({
      pdfUrl,
      selectedSections,
      allSections,
      dashboardName,
    });

    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const mem0 = process.memoryUsage();
      console.log(
        `[PythonPDFService] Invocando ${PYTHON_CMD} con ${selectedSections.length} secciones. ` +
        `RSS antes: ${Math.round(mem0.rss / 1024 / 1024)}MB`
      );

      const py = spawn(PYTHON_CMD, [PYTHON_SCRIPT], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: PYTHON_TIMEOUT_MS,
      });

      const stdoutChunks = [];
      const stderrLines  = [];

      // Recolectar stdout (el PDF binario)
      py.stdout.on('data', (chunk) => {
        stdoutChunks.push(chunk);
      });

      // Loggear stderr (diagnóstico de Python)
      py.stderr.on('data', (data) => {
        const lines = data.toString().split('\n').filter(Boolean);
        lines.forEach(line => {
          stderrLines.push(line);
          console.log(`[PythonPDF] ${line}`);
        });
      });

      py.on('error', (err) => {
        reject(new Error(
          `[PythonPDFService] No se pudo lanzar el proceso Python: ${err.message}. ` +
          `Verifica que '${PYTHON_CMD}' esté instalado y en el PATH.`
        ));
      });

      py.on('close', (code) => {
        const elapsed = Date.now() - startTime;
        const mem1 = process.memoryUsage();
        console.log(
          `[PythonPDFService] Proceso terminado en ${elapsed}ms con código ${code}. ` +
          `RSS después: ${Math.round(mem1.rss / 1024 / 1024)}MB`
        );

        const stdoutString = Buffer.concat(stdoutChunks).toString('utf-8');

        try {
          const json = JSON.parse(stdoutString);
          if (json.error) {
            return reject(new Error(`[PythonPDF] Error en pipeline Python: ${json.error}`));
          }
          if (json.tmpFile) {
            console.log(`[PythonPDFService] PDF generado correctamente en: ${json.tmpFile} (${(json.size / 1024).toFixed(1)} KB)`);
            return resolve({ tmpFile: json.tmpFile, size: json.size });
          }
          return reject(new Error(`[PythonPDF] Respuesta inesperada del script: ${stdoutString.substring(0, 100)}`));
        } catch (e) {
          const lastLogs = stderrLines.slice(-5).join('\n');
          return reject(new Error(
            `[PythonPDF] El proceso falló con código ${code}.\n` +
            `Salida no es JSON válido: ${stdoutString.substring(0, 200)}\n` +
            `Últimos logs:\n${lastLogs}`
          ));
        }
      });

      // Enviar el payload JSON por stdin
      py.stdin.write(payload, 'utf-8');
      py.stdin.end();
    });
  }
}

module.exports = new PythonPDFService();
