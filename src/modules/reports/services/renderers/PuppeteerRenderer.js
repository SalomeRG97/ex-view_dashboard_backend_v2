'use strict';

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const url = require('url');

class PuppeteerRenderer {
  /**
   * Renderiza páginas del PDF a imágenes JPEG usando Puppeteer + PDF.js embebido secuencialmente.
   *
   * @param {Buffer}   pdfBuffer   - Buffer del PDF original
   * @param {number[]} pageNumbers - Páginas a renderizar (1-indexed)
   * @param {object}   options     - Opciones
   * @returns {Promise<Array<{page: number, buffer: Buffer}>>}
   */
  async render(pdfBuffer, pageNumbers, options = {}) {
    const results      = [];
    let   browser      = null;
    let   tempHtmlPath = null;
    let   tempPdfPath  = null;

    try {
      const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).substring(7)}`;

      // Escribir PDF a disco para que Puppeteer lo lea vía file:///
      tempPdfPath = path.join(os.tmpdir(), `temp-pdf-puppeteer-${uniqueSuffix}.pdf`);
      await fs.promises.writeFile(tempPdfPath, pdfBuffer);

      // Resolver rutas de pdfjs-dist instalado en node_modules
      const pdfJsPath        = path.resolve(__dirname, '../../../../../node_modules/pdfjs-dist/build/pdf.min.mjs');
      const pdfWorkerPath    = path.resolve(__dirname, '../../../../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs');
      const cMapDir          = path.resolve(__dirname, '../../../../../node_modules/pdfjs-dist/cmaps');
      const standardFontDir  = path.resolve(__dirname, '../../../../../node_modules/pdfjs-dist/standard_fonts');

      const fileUrlPdfJs        = url.pathToFileURL(pdfJsPath).href;
      const fileUrlWorker       = url.pathToFileURL(pdfWorkerPath).href;
      const fileUrlPdfSource    = url.pathToFileURL(tempPdfPath).href;
      let   fileUrlCMap         = url.pathToFileURL(cMapDir).href;
      if (!fileUrlCMap.endsWith('/'))        fileUrlCMap        += '/';
      let   fileUrlStandardFont = url.pathToFileURL(standardFontDir).href;
      if (!fileUrlStandardFont.endsWith('/')) fileUrlStandardFont += '/';

      // HTML mínimo para alojar PDF.js (módulo ES)
      const tempHtmlContent = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { margin: 0; padding: 0; }
    body { background: white; overflow: hidden; }
    #canvas-container canvas { display: block; }
  </style>
</head>
<body>
  <div id="canvas-container"></div>
  <script type="module">
    import * as pdfjsLib from '${fileUrlPdfJs}';
    pdfjsLib.GlobalWorkerOptions.workerSrc = '${fileUrlWorker}';
    window.pdfjsLib = pdfjsLib;
    window.isPdfjsLoaded = true;
  </script>
</body>
</html>`;

      tempHtmlPath = path.join(os.tmpdir(), `temp-pdf-render-${uniqueSuffix}.html`);
      await fs.promises.writeFile(tempHtmlPath, tempHtmlContent, 'utf8');

      // Lanzar Puppeteer con executablePath condicional
      const launchOptions = {
        headless: 'new',
        protocolTimeout: 300_000, // 5 minutos para comunicación CDP
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-features=FirstPartySets',
          '--allow-file-access-from-files',
          '--disable-web-security',
        ],
      };
      if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
      }

      browser = await puppeteer.launch(launchOptions);

      const p = await browser.newPage();
      p.setDefaultTimeout(180_000);

      p.on('console', msg => console.log('[Browser Console]', msg.text()));
      p.on('pageerror', err => console.error('[Browser PageError]', err.message));

      await p.goto(url.pathToFileURL(tempHtmlPath).href, { waitUntil: 'load', timeout: 60_000 });
      await p.waitForFunction(() => window.isPdfjsLoaded === true, { timeout: 60_000 });

      // Cargar el documento PDF dentro de la tab
      await p.evaluate(async (pdfUrl, cMapUrl, standardFontUrl) => {
        const loadingTask = window.pdfjsLib.getDocument({
          url:                 pdfUrl,
          cMapUrl:             cMapUrl,
          cMapPacked:          true,
          standardFontDataUrl: standardFontUrl,
        });
        window.pdfDocumentInstance = await loadingTask.promise;
      }, fileUrlPdfSource, fileUrlCMap, fileUrlStandardFont);

      const scale = options.scale || 1.0;

      // Renderizar páginas secuencialmente para máxima robustez
      for (const pageNum of pageNumbers) {
        const startPageTime = Date.now();

        try {
          const dataUrl = await p.evaluate(async (pageNum, scale) => {
            const pdf = window.pdfDocumentInstance;
            if (pageNum < 1 || pageNum > pdf.numPages) {
              throw new Error(`Página fuera de rango: ${pageNum}`);
            }

            const pdfPage = await pdf.getPage(pageNum);
            let viewport  = pdfPage.getViewport({ scale });

            // Redimensión automática si el ancho supera 1200px
            const maxWidth = 1200;
            if (viewport.width > maxWidth) {
              const adaptedScale = scale * (maxWidth / viewport.width);
              viewport = pdfPage.getViewport({ scale: adaptedScale });
            }

            const container = document.getElementById('canvas-container');
            container.innerHTML = '';

            const canvas         = document.createElement('canvas');
            canvas.width         = Math.round(viewport.width);
            canvas.height        = Math.round(viewport.height);
            const ctx            = canvas.getContext('2d');

            container.appendChild(canvas);

            const renderContext = { canvasContext: ctx, viewport };
            await pdfPage.render(renderContext).promise;

            pdfPage.cleanup();

            // Exportar JPEG optimizado (calidad 0.75)
            return canvas.toDataURL('image/jpeg', 0.75);
          }, pageNum, scale);

          const base64Data = dataUrl.replace(/^data:image\/jpeg;base64,/, '');
          const imgBuffer  = Buffer.from(base64Data, 'base64');

          const pageDuration = Date.now() - startPageTime;
          const mem          = process.memoryUsage();
          console.log(`[PuppeteerRenderer] Página ${pageNum} renderizada en ${pageDuration}ms. Memoria: ${Math.round(mem.heapUsed / 1024 / 1024)}MB heap.`);

          results.push({ page: pageNum, buffer: imgBuffer });

        } catch (pageErr) {
          console.error(`[PuppeteerRenderer] Error renderizando página ${pageNum}:`, pageErr.message);
          throw pageErr;
        }
      }

    } catch (err) {
      console.error('[PuppeteerRenderer] Error fatal:', err.message);
      throw err;
    } finally {
      if (browser) {
        try { await browser.close(); } catch { /* ignorar */ }
      }
      if (tempHtmlPath && fs.existsSync(tempHtmlPath)) {
        try { await fs.promises.unlink(tempHtmlPath); } catch { /* ignorar */ }
      }
      if (tempPdfPath && fs.existsSync(tempPdfPath)) {
        try { await fs.promises.unlink(tempPdfPath); } catch { /* ignorar */ }
      }
    }

    return results;
  }
}

module.exports = new PuppeteerRenderer();
