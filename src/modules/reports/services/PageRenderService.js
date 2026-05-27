'use strict';

const puppeteer  = require('puppeteer');
const fs         = require('fs');
const path       = require('path');
const os         = require('os');
const url        = require('url');
const { exec }   = require('child_process');
const util       = require('util');

const execPromise = util.promisify(exec);

class PageRenderService {

  /**
   * Verifica si pdftoppm (Poppler) está disponible en el PATH del sistema.
   * @returns {Promise<boolean>}
   */
  async isPdftoppmAvailable() {
    try {
      await execPromise('pdftoppm -v', { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Convierte páginas del PDF a imágenes JPEG optimizadas.
   * Utiliza pdftoppm (Poppler) si está disponible para máximo rendimiento.
   * Si no, hace fallback a Puppeteer + PDF.js optimizado.
   *
   * @param {Buffer}   pdfBuffer   - Buffer del PDF original
   * @param {number[]} pageNumbers - Páginas a renderizar (1-indexed)
   * @param {object}   options     - Opciones de renderizado
   * @returns {Promise<Array<{page: number, buffer: Buffer}>>}
   */
  async renderPages(pdfBuffer, pageNumbers, options = {}) {
    const results = [];
    if (!pageNumbers || pageNumbers.length === 0) return results;

    const totalStartTime = Date.now();
    const uniqueSuffix   = `${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const tempPdfPath    = path.join(os.tmpdir(), `temp-pdf-source-${uniqueSuffix}.pdf`);

    try {
      await fs.promises.writeFile(tempPdfPath, pdfBuffer);

      const popplerAvailable = await this.isPdftoppmAvailable();

      if (popplerAvailable) {
        console.log('[PageRenderService] 🚀 Poppler (pdftoppm) detectado. Usando motor nativo ultra-rápido...');
        const popplerResults = await this.renderPagesWithPdftoppm(tempPdfPath, pageNumbers, options);

        const totalDuration = Date.now() - totalStartTime;
        const mem = process.memoryUsage();
        console.log(`[PageRenderService] ✅ Procesamiento completado con Poppler en ${totalDuration}ms. Memoria: ${Math.round(mem.heapUsed / 1024 / 1024)}MB heap.`);
        return popplerResults;
      }

      console.log('[PageRenderService] ⚠️ Poppler no disponible en el sistema. Usando fallback optimizado de Puppeteer...');
      const puppeteerResults = await this.renderPagesWithPuppeteer(pdfBuffer, pageNumbers, options);

      const totalDuration = Date.now() - totalStartTime;
      const mem = process.memoryUsage();
      console.log(`[PageRenderService] ✅ Procesamiento completado con Puppeteer en ${totalDuration}ms. Memoria: ${Math.round(mem.heapUsed / 1024 / 1024)}MB heap.`);
      return puppeteerResults;

    } catch (err) {
      console.error('[PageRenderService] Error crítico durante el renderizado de páginas:', err.message);
    } finally {
      if (fs.existsSync(tempPdfPath)) {
        try { await fs.promises.unlink(tempPdfPath); } catch { /* ignorar */ }
      }
    }

    return results;
  }

  // ───────────────────────────────────────────
  //  Motor primario: Poppler / pdftoppm
  // ───────────────────────────────────────────

  /**
   * Renderizado usando pdftoppm (Poppler) en paralelo con concurrencia controlada.
   */
  async renderPagesWithPdftoppm(tempPdfPath, pageNumbers, options) {
    const results      = [];
    const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const outputPrefix = path.join(os.tmpdir(), `pdftoppm-out-${uniqueSuffix}`);
    const limit        = 4; // Páginas paralelas máximas

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
            console.log(`[PageRenderService - Poppler] Página ${pageNum} renderizada en ${pageDuration}ms. Memoria: ${Math.round(mem.heapUsed / 1024 / 1024)}MB heap.`);
            results.push({ page: pageNum, buffer });
          } else {
            console.warn(`[PageRenderService - Poppler] No se encontró archivo de salida para la página ${pageNum}`);
          }
        } catch (err) {
          console.error(`[PageRenderService - Poppler] Error renderizando página ${pageNum}:`, err.message);
        }
      }));
    }

    return results;
  }

  // ───────────────────────────────────────────
  //  Motor fallback: Puppeteer + PDF.js
  // ───────────────────────────────────────────

  /**
   * Renderizado usando Puppeteer con PDF.js embebido.
   * Procesa páginas de forma paralela con pool de tabs para máximo rendimiento en Windows.
   *
   * @param {Buffer}   pdfBuffer   - Buffer del PDF original (se escribe a /tmp internamente)
   * @param {number[]} pageNumbers - Páginas a renderizar (1-indexed)
   * @param {object}   options
   * @returns {Promise<Array<{page: number, buffer: Buffer}>>}
   */
  async renderPagesWithPuppeteer(pdfBuffer, pageNumbers, options) {
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
      const pdfJsPath        = path.resolve(__dirname, '../../../../node_modules/pdfjs-dist/build/pdf.min.mjs');
      const pdfWorkerPath    = path.resolve(__dirname, '../../../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs');
      const cMapDir          = path.resolve(__dirname, '../../../../node_modules/pdfjs-dist/cmaps');
      const standardFontDir  = path.resolve(__dirname, '../../../../node_modules/pdfjs-dist/standard_fonts');

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

      // Lanzar Puppeteer
      browser = await puppeteer.launch({
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
      });

      // Pool de tabs (concurrencia 2 para no saturar RAM en entornos con poca memoria)
      const concurrency = Math.min(2, pageNumbers.length);
      const pagesPool   = [];

      for (let i = 0; i < concurrency; i++) {
        const p = await browser.newPage();
        p.setDefaultTimeout(180_000);

        p.on('console', msg => {
          if (msg.type() !== 'log') {
            console.log(`[Browser Tab ${i}]`, msg.text());
          }
        });
        p.on('pageerror', err => console.error(`[Browser Tab ${i} Error]`, err.message));

        await p.goto(url.pathToFileURL(tempHtmlPath).href, { waitUntil: 'load', timeout: 60_000 });
        await p.waitForFunction(() => window.isPdfjsLoaded === true, { timeout: 60_000 });

        // Cargar el documento PDF dentro de cada tab
        await p.evaluate(async (pdfUrl, cMapUrl, standardFontUrl) => {
          const loadingTask = window.pdfjsLib.getDocument({
            url:                 pdfUrl,
            cMapUrl:             cMapUrl,
            cMapPacked:          true,
            standardFontDataUrl: standardFontUrl,
          });
          window.pdfDocumentInstance = await loadingTask.promise;
        }, fileUrlPdfSource, fileUrlCMap, fileUrlStandardFont);

        pagesPool.push(p);
      }

      const scale = options.scale || 1.0;

      let tabIndex = 0;
      const renderTasks = pageNumbers.map(async (pageNum) => {
        const workerTab   = pagesPool[tabIndex++ % concurrency];
        const startPageTime = Date.now();

        try {
          const dataUrl = await workerTab.evaluate(async (pageNum, scale) => {
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
          console.log(`[PageRenderService - Puppeteer] Página ${pageNum} renderizada en ${pageDuration}ms. Memoria: ${Math.round(mem.heapUsed / 1024 / 1024)}MB heap.`);

          results.push({ page: pageNum, buffer: imgBuffer });

        } catch (pageErr) {
          console.error(`[PageRenderService - Puppeteer] Error renderizando página ${pageNum}:`, pageErr.message);
        }
      });

      await Promise.all(renderTasks);

    } catch (err) {
      console.error('[PageRenderService - Puppeteer] Error fatal:', err.message);
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
