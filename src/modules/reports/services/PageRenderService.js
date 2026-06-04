'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const popplerRenderer = require('./renderers/PopplerRenderer');
const pdfjsRenderer = require('./renderers/PDFJSRenderer');
const puppeteerRenderer = require('./renderers/PuppeteerRenderer');

class PageRenderService {

  /**
   * Verifica si pdftoppm (Poppler) está disponible en el PATH del sistema.
   * @returns {Promise<boolean>}
   */
  async isPdftoppmAvailable() {
    return popplerRenderer.isAvailable();
  }

  /**
   * Convierte páginas del PDF a imágenes JPEG optimizadas.
   * Selecciona el motor primario según la plataforma (OS) y aplica fallback si falla.
   *
   * @param {Buffer}   pdfBuffer   - Buffer del PDF original
   * @param {number[]} pageNumbers - Páginas a renderizar (1-indexed)
   * @param {object}   options     - Opciones de renderizado
   * @returns {Promise<Array<{page: number, buffer: Buffer}>>}
   */
  /**
   * Convierte páginas del PDF a imágenes JPEG optimizadas.
   * Selecciona el motor primario según la plataforma (OS) y aplica fallback si falla.
   *
   * @param {Buffer|string} pdfSource   - Buffer del PDF original o ruta al archivo en disco
   * @param {number[]}      pageNumbers - Páginas a renderizar (1-indexed)
   * @param {object}        options     - Opciones de renderizado
   * @returns {Promise<Array<{page: number, buffer: Buffer}>>}
   */
  async renderPages(pdfSource, pageNumbers, options = {}) {
    if (!pageNumbers || pageNumbers.length === 0) return [];

    const totalStartTime = Date.now();
    const platform = process.platform;
    let results = [];

    // Para Poppler se requiere el PDF en un archivo temporal en disco si es un Buffer
    let tempPdfPath = null;

    try {
      if (platform === 'linux') {
        console.log('[PageRenderService] Using Poppler renderer (Linux)');
        const popplerAvailable = await popplerRenderer.isAvailable();
        if (popplerAvailable) {
          let targetPdfPath = null;
          if (typeof pdfSource === 'string') {
            targetPdfPath = pdfSource;
          } else {
            const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).substring(7)}`;
            tempPdfPath = path.join(os.tmpdir(), `temp-pdf-source-${uniqueSuffix}.pdf`);
            await fs.promises.writeFile(tempPdfPath, pdfSource);
            targetPdfPath = tempPdfPath;
          }

          try {
            results = await popplerRenderer.render(targetPdfPath, pageNumbers, options);
          } catch (popplerErr) {
            console.error('[PageRenderService] Poppler renderer failed. Falling back to Puppeteer...', popplerErr.message);
            console.log('[PageRenderService] Using Puppeteer renderer (fallback)');
            results = await puppeteerRenderer.render(pdfSource, pageNumbers, options);
          }
        } else {
          console.warn('[PageRenderService] Poppler not available on Linux. Falling back to Puppeteer...');
          console.log('[PageRenderService] Using Puppeteer renderer (fallback)');
          results = await puppeteerRenderer.render(pdfSource, pageNumbers, options);
        }
      } else if (platform === 'win32') {
        console.log('[PageRenderService] Using PDF.js renderer (Windows)');
        try {
          results = await pdfjsRenderer.render(pdfSource, pageNumbers, options);
        } catch (pdfjsErr) {
          console.error('[PageRenderService] PDF.js renderer failed on Windows. Falling back to Puppeteer...', pdfjsErr.message);
          console.log('[PageRenderService] Using Puppeteer renderer (fallback)');
          results = await puppeteerRenderer.render(pdfSource, pageNumbers, options);
        }
      } else {
        console.log('[PageRenderService] Using Puppeteer renderer (fallback)');
        results = await puppeteerRenderer.render(pdfSource, pageNumbers, options);
      }

      const totalDuration = Date.now() - totalStartTime;
      const mem = process.memoryUsage();
      console.log(`[PageRenderService] ✅ Procesamiento completado en ${totalDuration}ms. Memoria: ${Math.round(mem.heapUsed / 1024 / 1024)}MB heap.`);
      return results;

    } catch (err) {
      console.error('[PageRenderService] Error crítico durante el renderizado de páginas:', err.message);
      return [];
    } finally {
      if (tempPdfPath && fs.existsSync(tempPdfPath)) {
        try { await fs.promises.unlink(tempPdfPath); } catch { /* ignorar */ }
      }
    }
  }

  /**
   * Genera un rango secuencial de páginas [start … end].
   */
  pageRange(start, end) {
    const pages = [];
    for (let i = start; i <= end; i++) pages.push(i);
    return pages;
  }
}

module.exports = new PageRenderService();
