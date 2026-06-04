'use strict';

const path = require('path');
const url = require('url');

class PDFJSRenderer {
  /**
   * Renderiza páginas del PDF a imágenes JPEG usando pdfjs-dist y @napi-rs/canvas.
   *
   * @param {Buffer}   pdfBuffer   - Buffer del PDF original
   * @param {number[]} pageNumbers - Páginas a renderizar (1-indexed)
   * @param {object}   options     - Opciones
   * @returns {Promise<Array<{page: number, buffer: Buffer}>>}
   */
  async render(pdfSource, pageNumbers, options = {}) {
    const results = [];
    if (!pageNumbers || pageNumbers.length === 0) return results;

    let pdfDocument = null;
    try {
      // 1. Cargar pdfjs-dist dinámicamente usando legacy build para compatibilidad con Node.js CJS
      const pdfJsPath = path.resolve(__dirname, '../../../../../node_modules/pdfjs-dist/legacy/build/pdf.mjs');
      const workerPath = path.resolve(__dirname, '../../../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs');

      const pdfjsLib = await import('file://' + pdfJsPath);
      pdfjsLib.GlobalWorkerOptions.workerSrc = url.pathToFileURL(workerPath).href;

      // 2. Requerir @napi-rs/canvas
      const { createCanvas } = require('@napi-rs/canvas');

      // 3. Configurar urls de fuentes y mapas de caracteres
      const standardFontsPath = path.resolve(__dirname, '../../../../../node_modules/pdfjs-dist/standard_fonts');
      const standardFontDataUrl = standardFontsPath + (standardFontsPath.endsWith(path.sep) ? '' : path.sep);

      const cmapsPath = path.resolve(__dirname, '../../../../../node_modules/pdfjs-dist/cmaps');
      const cMapUrl = cmapsPath + (cmapsPath.endsWith(path.sep) ? '' : path.sep);

      // 4. Cargar el PDF desde el buffer o de disco
      const uint8Array = typeof pdfSource === 'string'
        ? new Uint8Array(await fs.promises.readFile(pdfSource))
        : new Uint8Array(pdfSource);

      const loadingTask = pdfjsLib.getDocument({
        data: uint8Array,
        verbosity: 0,
        standardFontDataUrl,
        cMapUrl,
        cMapPacked: true
      });

      pdfDocument = await loadingTask.promise;

      const scale = options.scale || 1.5;

      // 4. Renderizado secuencial para minimizar consumo de memoria
      for (const pageNum of pageNumbers) {
        const startPageTime = Date.now();
        if (pageNum < 1 || pageNum > pdfDocument.numPages) {
          throw new Error(`Página fuera de rango: ${pageNum}`);
        }

        const page = await pdfDocument.getPage(pageNum);

        let viewport = page.getViewport({ scale });
        const maxWidth = 1200;
        if (viewport.width > maxWidth) {
          const adaptedScale = scale * (maxWidth / viewport.width);
          viewport = page.getViewport({ scale: adaptedScale });
        }

        // Crear canvas usando @napi-rs/canvas
        const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
        const ctx = canvas.getContext('2d');

        const renderContext = {
          canvasContext: ctx,
          viewport: viewport
        };

        await page.render(renderContext).promise;

        // Exportar a buffer JPEG de alta calidad
        const jpegBuffer = await canvas.encode('jpeg', 80);

        const pageDuration = Date.now() - startPageTime;
        const mem = process.memoryUsage();
        console.log(`[PDFJSRenderer] Página ${pageNum} renderizada en ${pageDuration}ms. Memoria: ${Math.round(mem.heapUsed / 1024 / 1024)}MB heap.`);

        results.push({ page: pageNum, buffer: jpegBuffer });
      }

    } catch (err) {
      console.error('[PDFJSRenderer] Error durante el renderizado con PDF.js:', err.message);
      throw err;
    } finally {
      if (pdfDocument) {
        try {
          await pdfDocument.destroy();
        } catch { /* ignorar */ }
      }
    }

    return results;
  }
}

module.exports = new PDFJSRenderer();
