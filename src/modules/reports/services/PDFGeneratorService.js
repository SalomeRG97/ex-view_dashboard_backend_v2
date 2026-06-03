const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const url = require('url');

class PDFGeneratorService {
  /**
   * Genera un PDF a partir de un HTML string usando Puppeteer directamente en disco.
   * Incluye diagnóstico detallado de memoria en cada fase del proceso.
   * @param {string} html - HTML completo del informe
   * @param {object} [meta={}] - Metadatos opcionales para diagnóstico (imageCount, totalImageSizeBytes, pageCount)
   * @returns {Promise<string>} Ruta absoluta al PDF generado
   */
  async generate(html, meta = {}) {
    let browser;
    let tempHtmlPath;
    let tempPdfPath;

    // ── Utilidades de diagnóstico ─────────────────────────────────────────
    const fmt  = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    const snap = () => {
      const m = process.memoryUsage();
      return { rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external };
    };
    const logSnap = (label, before, after) => {
      const delta = (key) => {
        const diff = (after[key] - before[key]) / 1024 / 1024;
        return `${diff >= 0 ? '+' : ''}${diff.toFixed(2)} MB`;
      };
      console.log(
        `\n[PDF Diagnostics] ━━━ ${label} ━━━\n` +
        `  RSS:      ${fmt(after.rss)}  (Δ ${delta('rss')})\n` +
        `  HeapUsed: ${fmt(after.heapUsed)}  (Δ ${delta('heapUsed')})\n` +
        `  HeapTotal:${fmt(after.heapTotal)}  (Δ ${delta('heapTotal')})\n` +
        `  External: ${fmt(after.external)}  (Δ ${delta('external')})`
      );
    };
    const logPoint = (label) => {
      const m = process.memoryUsage();
      console.log(
        `[PDF Diagnostics] [${label}] ` +
        `RSS: ${fmt(m.rss)} | ` +
        `Heap: ${fmt(m.heapUsed)}/${fmt(m.heapTotal)} | ` +
        `External: ${fmt(m.external)}`
      );
      return snap();
    };

    try {
      const tempDir = os.tmpdir();
      tempHtmlPath = path.join(tempDir, `temp-report-${Date.now()}-${Math.random().toString(36).substring(7)}.html`);
      tempPdfPath  = path.join(tempDir, `temp-report-${Date.now()}-${Math.random().toString(36).substring(7)}.pdf`);

      fs.writeFileSync(tempHtmlPath, html, 'utf8');

      // ── Datos de diagnóstico de imágenes ─────────────────────────────────
      if (meta.imageCount !== undefined || meta.totalImageSizeBytes !== undefined || meta.pageCount !== undefined) {
        console.log(
          `\n[PDF Diagnostics] ══ Informe Metadata ══\n` +
          `  Imágenes utilizadas:        ${meta.imageCount ?? 'N/A'}\n` +
          `  Peso total de imágenes:     ${meta.totalImageSizeBytes !== undefined ? fmt(meta.totalImageSizeBytes) : 'N/A'}\n` +
          `  Páginas del informe:        ${meta.pageCount ?? 'N/A'}\n` +
          `  Tamaño HTML generado:       ${fmt(Buffer.byteLength(html, 'utf8'))}`
        );
      }

      const launchOptions = {
        headless: 'new',
        protocolTimeout: 300000,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-features=FirstPartySets',
          '--disable-gpu',
          '--allow-file-access-from-files',
          '--disable-web-security',
        ],
      };

      if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
      }

      // ── PUNTO 1: Antes de lanzar Chromium ────────────────────────────────
      const snap1 = logPoint('1/6 - Before Chromium Launch');
      browser = await puppeteer.launch(launchOptions);

      const page = await browser.newPage();
      page.setDefaultTimeout(180000);
      page.setDefaultNavigationTimeout(180000);

      // ── PUNTO 2: Después de abrir la página ──────────────────────────────
      await page.goto(url.pathToFileURL(tempHtmlPath).href, {
        waitUntil: 'load',
        timeout: 90000,
      });
      const snap2 = logPoint('2/6 - After Page Opened');
      logSnap('Chromium Init → Page Opened', snap1, snap2);

      // ── PUNTO 3: Después de cargar todas las imágenes ─────────────────────
      const imgDiag = await page.evaluate(async () => {
        await Promise.all(
          Array.from(document.images)
            .filter(img => !img.complete)
            .map(img => new Promise(resolve => {
              img.onload = resolve;
              img.onerror = resolve;
            }))
        );
        await document.fonts.ready;
        await new Promise(resolve => setTimeout(resolve, 100));

        // Recopilar diagnóstico desde el contexto del navegador
        const imgs = Array.from(document.images);
        return {
          totalImages:      imgs.length,
          loadedImages:     imgs.filter(i => i.complete && i.naturalWidth > 0).length,
          failedImages:     imgs.filter(i => i.complete && i.naturalWidth === 0 && i.src).length,
          totalPageDivs:    document.querySelectorAll('.content-page').length,
        };
      });

      const snap3 = logPoint('3/6 - After Images Loaded');
      logSnap('Page Opened → Images Loaded', snap2, snap3);
      console.log(
        `[PDF Diagnostics] ══ Browser Image Summary ══\n` +
        `  Total <img> tags en DOM:   ${imgDiag.totalImages}\n` +
        `  Imágenes cargadas (ok):    ${imgDiag.loadedImages}\n` +
        `  Imágenes fallidas:         ${imgDiag.failedImages}\n` +
        `  Divs de página (.content-page): ${imgDiag.totalPageDivs}`
      );

      // ── PUNTO 4: Antes de ejecutar page.pdf() ────────────────────────────
      const snap4 = logPoint('4/6 - Before page.pdf()');
      logSnap('Images Loaded → Before PDF', snap3, snap4);

      await page.pdf({
        path: tempPdfPath,
        format: 'A4',
        printBackground: true,
        margin: { top: 0, right: 0, bottom: 0, left: 0 },
        preferCSSPageSize: true,
      });

      // ── PUNTO 5: Después de ejecutar page.pdf() ──────────────────────────
      const snap5 = logPoint('5/6 - After page.pdf()');
      logSnap('Before PDF → After page.pdf()', snap4, snap5);

      // Registrar tamaño del PDF generado en disco
      if (fs.existsSync(tempPdfPath)) {
        const pdfStats = fs.statSync(tempPdfPath);
        console.log(`[PDF Diagnostics] PDF generado en disco: ${fmt(pdfStats.size)} (${(pdfStats.size / 1024).toFixed(0)} KB)`);
      }

      return tempPdfPath;

    } catch (err) {
      if (tempPdfPath && fs.existsSync(tempPdfPath)) {
        try { fs.unlinkSync(tempPdfPath); } catch (_) {}
      }
      throw err;
    } finally {
      if (tempHtmlPath && fs.existsSync(tempHtmlPath)) {
        try {
          fs.unlinkSync(tempHtmlPath);
        } catch (err) {
          console.warn('Warning: Error deleting temporary HTML file:', err.message);
        }
      }
      if (browser) {
        try {
          await browser.close();
        } catch (closeError) {
          console.warn('Warning: Error closing puppeteer browser:', closeError.message);
        }
      }
      // ── PUNTO 6: Después de cerrar Chromium ──────────────────────────────
      logPoint('6/6 - After Chromium Closed');
    }
  }

  /**
   * Genera múltiples archivos PDF a partir de una lista de HTML strings, reutilizando el navegador.
   * @param {string[]} htmlChunks - Lista de HTML de cada bloque
   * @returns {Promise<string[]>} Lista de rutas absolutas de los PDFs chunks
   */
  async generateChunked(htmlChunks) {
    let browser;
    const chunkPdfPaths = [];
    const tempHtmlPaths = [];

    const fmt  = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    const logMemory = (label) => {
      const m = process.memoryUsage();
      console.log(
        `[PDF Diagnostics] [${label}] ` +
        `RSS: ${fmt(m.rss)} | ` +
        `Heap: ${fmt(m.heapUsed)}/${fmt(m.heapTotal)} | ` +
        `External: ${fmt(m.external)}`
      );
    };

    try {
      const launchOptions = {
        headless: 'new',
        protocolTimeout: 300000,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-features=FirstPartySets',
          '--disable-gpu',
          '--allow-file-access-from-files',
          '--disable-web-security',
        ],
      };

      if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
      }

      console.log(`[PDFGeneratorService] Lanzando Chromium para generación por chunks...`);
      logMemory('Launch Start');
      browser = await puppeteer.launch(launchOptions);

      for (let i = 0; i < htmlChunks.length; i++) {
        const html = htmlChunks[i];
        const tempDir = os.tmpdir();
        const tempHtmlPath = path.join(tempDir, `temp-chunk-${i}-${Date.now()}-${Math.random().toString(36).substring(7)}.html`);
        const tempPdfPath  = path.join(tempDir, `temp-chunk-${i}-${Date.now()}-${Math.random().toString(36).substring(7)}.pdf`);

        fs.writeFileSync(tempHtmlPath, html, 'utf8');
        tempHtmlPaths.push(tempHtmlPath);
        chunkPdfPaths.push(tempPdfPath);

        console.log(`[PDFGeneratorService] Procesando chunk ${i + 1}/${htmlChunks.length}...`);

        let page = await browser.newPage();
        page.setDefaultTimeout(180000);
        page.setDefaultNavigationTimeout(180000);

        await page.goto(url.pathToFileURL(tempHtmlPath).href, {
          waitUntil: 'load',
          timeout: 90000,
        });

        // Esperar a que se carguen las imágenes y fuentes
        await page.evaluate(async () => {
          await Promise.all(
            Array.from(document.images)
              .filter(img => !img.complete)
              .map(img => new Promise(resolve => {
                img.onload = resolve;
                img.onerror = resolve;
              }))
          );
          await document.fonts.ready;
          await new Promise(resolve => setTimeout(resolve, 100));
        });

        await page.pdf({
          path: tempPdfPath,
          format: 'A4',
          printBackground: true,
          margin: { top: 0, right: 0, bottom: 0, left: 0 },
          preferCSSPageSize: true,
        });

        await page.close();
        page = null;

        if (global.gc) {
          global.gc();
        }

        logMemory(`Chunk ${i + 1}/${htmlChunks.length} Finished`);

        // Eliminar HTML temporal del chunk de inmediato
        try {
          fs.unlinkSync(tempHtmlPath);
          // Quitar de la lista de pendientes para que no se intente borrar en finally
          const idx = tempHtmlPaths.indexOf(tempHtmlPath);
          if (idx !== -1) tempHtmlPaths.splice(idx, 1);
        } catch (unlinkErr) {
          console.warn(`Warning: No se pudo eliminar HTML temporal de chunk ${i + 1}:`, unlinkErr.message);
        }
      }

      return chunkPdfPaths;

    } catch (err) {
      console.error('[PDFGeneratorService] Error durante la generación chunked:', err.message);
      // Limpiar PDFs generados en caso de fallo
      for (const pdfPath of chunkPdfPaths) {
        if (fs.existsSync(pdfPath)) {
          try { fs.unlinkSync(pdfPath); } catch (_) {}
        }
      }
      throw err;
    } finally {
      // Limpiar cualquier HTML temporal restante
      for (const htmlPath of tempHtmlPaths) {
        if (fs.existsSync(htmlPath)) {
          try { fs.unlinkSync(htmlPath); } catch (_) {}
        }
      }
      if (browser) {
        try {
          await browser.close();
        } catch (closeError) {
          console.warn('Warning: Error closing puppeteer browser:', closeError.message);
        }
      }
      logMemory('After Browser Closed');
    }
  }
}

module.exports = new PDFGeneratorService();
