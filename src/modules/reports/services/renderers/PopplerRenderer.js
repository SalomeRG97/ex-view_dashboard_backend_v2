'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const util = require('util');

const execPromise = util.promisify(exec);

class PopplerRenderer {
  /**
   * Verifica si pdftoppm (Poppler) está disponible.
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    try {
      await execPromise('pdftoppm -v', { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Renderiza páginas del PDF a imágenes JPEG usando pdftoppm.
   *
   * @param {string}   tempPdfPath - Ruta al archivo PDF temporal
   * @param {number[]} pageNumbers - Páginas a renderizar (1-indexed)
   * @param {object}   options     - Opciones
   * @returns {Promise<Array<{page: number, buffer: Buffer}>>}
   */
  async render(tempPdfPath, pageNumbers, options = {}) {
    const results      = [];
    const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const outputPrefix = path.join(os.tmpdir(), `pdftoppm-out-${uniqueSuffix}`);
    const limit        = 4; // Concurrencia controlada

    const chunks = [];
    for (let i = 0; i < pageNumbers.length; i += limit) {
      chunks.push(pageNumbers.slice(i, i + limit));
    }

    for (const chunk of chunks) {
      await Promise.all(chunk.map(async (pageNum) => {
        const pagePrefix    = `${outputPrefix}-p${pageNum}`;
        const startPageTime = Date.now();
        // -jpeg → salida JPEG | -r 110 → ~1200px de ancho para A4
        const cmd = `pdftoppm -jpeg -r 110 -f ${pageNum} -l ${pageNum} "${tempPdfPath}" "${pagePrefix}"`;

        try {
          await execPromise(cmd, { timeout: 60_000 });

          const files = await fs.promises.readdir(os.tmpdir());
          const match = files.find(f => f.startsWith(path.basename(pagePrefix)) && f.endsWith('.jpg'));

          if (match) {
            const outPath = path.join(os.tmpdir(), match);
            const buffer  = await fs.promises.readFile(outPath);
            await fs.promises.unlink(outPath);

            const pageDuration = Date.now() - startPageTime;
            const mem          = process.memoryUsage();
            console.log(`[PopplerRenderer] Página ${pageNum} renderizada en ${pageDuration}ms. Memoria: ${Math.round(mem.heapUsed / 1024 / 1024)}MB heap.`);
            results.push({ page: pageNum, buffer });
          } else {
            throw new Error(`No se encontró archivo de salida para la página ${pageNum}`);
          }
        } catch (err) {
          console.error(`[PopplerRenderer] Error renderizando página ${pageNum}:`, err.message);
          throw err;
        }
      }));
    }

    return results;
  }
}

module.exports = new PopplerRenderer();
