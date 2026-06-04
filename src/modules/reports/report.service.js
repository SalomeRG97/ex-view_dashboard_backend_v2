const storageService       = require('../../storage/storageFactory');
const reportRepository     = require('./report.repository');
const processingService    = require('./services/ReportProcessingService');
const htmlBuilderService   = require('./services/HTMLBuilderService');
const pdfGeneratorService  = require('./services/PDFGeneratorService');
const pdfMergerService     = require('./services/PDFMergerService');

const fs                   = require('fs');
const path                 = require('path');
const os                   = require('os');
const pdfParser            = require('./services/PDFParserService');
const pageRender           = require('./services/PageRenderService');
const tocService           = require('./services/TOCService');
const imageCrop            = require('./services/ImageCropService');
const url                  = require('url');

class ReportService {
  /**
   * Subir un PDF, guardarlo en storage y lanzar procesamiento async.
   * @param {string} dashboardId
   * @param {Express.Multer.File} file - Archivo recibido por multer
   * @returns {Promise<Report>}
   */
  async uploadReport(dashboardId, file) {
    // Corregir codificación del nombre original si viene corrupto por Multer/Latin1
    const fixedName = this.fixUtf8Encoding(file.originalname);

    // 1. Guardar PDF original en storage
    const destPath = `reports/${dashboardId}/${Date.now()}-${fixedName}`;
    await storageService.save(file.buffer, destPath);

    // 2. Crear registro en DB con status UPLOADED
    const report = await reportRepository.create({
      dashboardId,
      originalName: fixedName,
      storagePath:  destPath,
      fileSize:     file.size,
      status:       'UPLOADED',
    });

    // 3. Disparar procesamiento async (no await → no bloquea la respuesta)
    // Si falla (ej: Ghostscript no instalado), el PDF queda como UPLOADED
    // y se podrá reprocesar después.
    processingService.process(report.id, file.buffer).catch(err => {
      console.error('[ReportService] ⚠️ Procesamiento async falló (el PDF sí fue guardado):', err.message);
      console.error('[ReportService] 💡 Verifica que Ghostscript esté instalado para el procesamiento de páginas.');
    });

    return report;
  }

  /**
   * Corrige Mojibake de UTF-8 codificado como ISO-8859-1 (Latin1) en cadenas de caracteres.
   */
  fixUtf8Encoding(str) {
    if (!str) return str;
    // Patrón regex extremadamente preciso para capturar secuencias multibyte de UTF-8 leídas en Latin1
    if (/[\u00C0-\u00DF][\u0080-\u00BF]/.test(str)) {
      try {
        return Buffer.from(str, 'latin1').toString('utf8');
      } catch (e) {
        return str;
      }
    }
    return str;
  }

  /**
   * Obtener todos los reportes de un dashboard.
   */
  async getReportsByDashboard(dashboardId) {
    const reports = await reportRepository.findByDashboardId(dashboardId);
    return reports.map(r => {
      if (r.originalName) {
        r.originalName = this.fixUtf8Encoding(r.originalName);
      }
      return r;
    });
  }

  /**
   * Obtener un reporte por ID.
   */
  async getReportById(id) {
    const report = await reportRepository.findById(id);
    if (!report) throw new Error('Reporte no encontrado');
    if (report.originalName) {
      report.originalName = this.fixUtf8Encoding(report.originalName);
    }
    try {
      const urlOrPath = storageService.getPublicUrl(report.storagePath);
      if (urlOrPath && urlOrPath.startsWith('http')) {
        report.publicUrl = urlOrPath;
      } else {
        report.publicUrl = null;
      }
    } catch (e) {
      report.publicUrl = null;
    }
    return report;
  }

  /**
   * Obtiene la ruta absoluta del archivo PDF original si existe.
   */
  async getOriginalPdfPath(report) {
    const exists = await storageService.exists(report.storagePath);
    if (exists) {
      return storageService.getPublicUrl(report.storagePath);
    }
    return null;
  }

  async generateFilteredReport(reportId, options = {}) {
    const { selectedSectionIds = [], selectedTypes = [], dashboardName = 'Informe Solar', clientName = 'Cliente' } = options;
    const report = await this.getReportById(reportId);

    if (report.status !== 'READY') {
      throw new Error('El reporte aún no está listo para generar. Estado: ' + report.status);
    }

    // 1. Descargar PDF original directamente a un archivo temporal en disco (Streaming)
    const exists = await storageService.exists(report.storagePath);
    if (!exists) {
      throw new Error('No se encontró el archivo PDF original en el servidor.');
    }
    
    const tempDir = os.tmpdir();
    const tempOriginalPdfPath = path.join(tempDir, `temp-original-${reportId}-${Date.now()}-${Math.random().toString(36).substring(7)}.pdf`);
    const tempFilesToDelete = [tempOriginalPdfPath];

    const readableStream = await storageService.getReadableStream(report.storagePath);
    const writeStream = fs.createWriteStream(tempOriginalPdfPath);

    await new Promise((resolve, reject) => {
      readableStream.pipe(writeStream);
      writeStream.on('finish', resolve);
      readableStream.on('error', reject);
      writeStream.on('error', reject);
    });

    // 2. Parsear el PDF para obtener texto y estructura de páginas de forma temporal
    let pdfBufferForParsing = await fs.promises.readFile(tempOriginalPdfPath);
    const { text, numPages, pages: pdfPages } = await pdfParser.parse(pdfBufferForParsing);
    const tocEntries = pdfParser.parseTOCEntries(pdfPages, numPages);

    // Liberar memoria del parseador inmediatamente
    pdfBufferForParsing = null;
    if (global.gc) {
      global.gc();
    }

    // 3. Determinar qué páginas originales se mantendrán
    // Página 1: Sí (portada)
    // Página 2: No (reemplazada por la nueva TOC)
    const originalPagesToKeep = [1];
    for (let p = 3; p <= numPages; p++) {
      const section = report.sections.find(s => p >= s.pageStart && p <= s.pageEnd);
      if (section) {
        const isSelected = selectedSectionIds.includes(section.id) || selectedTypes.includes(section.type);
        if (isSelected) {
          originalPagesToKeep.push(p);
        }
      } else {
        originalPagesToKeep.push(p);
      }
    }

    if (originalPagesToKeep.length <= 1) {
      throw new Error('No hay páginas disponibles para incluir en el reporte final.');
    }

    // 4. Crear mapa de correspondencia: p_original -> p_nueva
    const originalToNewPageMap = new Map();
    originalToNewPageMap.set(1, 1);
    for (let i = 1; i < originalPagesToKeep.length; i++) {
      originalToNewPageMap.set(originalPagesToKeep[i], i + 2);
    }

    // 5. Filtrar y recalcular las entradas de la Tabla de Contenidos
    const newTOCEntries = [];
    for (let idx = 0; idx < tocEntries.length; idx++) {
      const entry = tocEntries[idx];
      if (entry.isSub) {
        if (originalToNewPageMap.has(entry.originalPageNum)) {
          newTOCEntries.push({
            label: entry.title,
            page: originalToNewPageMap.get(entry.originalPageNum),
            isSub: true,
          });
        }
      } else {
        const nextMain = tocEntries.slice(idx + 1).find(e => !e.isSub);
        const startPage = entry.originalPageNum;
        const endPage = nextMain ? nextMain.originalPageNum - 1 : numPages;

        let firstKeptPage = null;
        for (let p = startPage; p <= endPage; p++) {
          if (originalToNewPageMap.has(p)) {
            firstKeptPage = p;
            break;
          }
        }

        if (firstKeptPage !== null) {
          newTOCEntries.push({
            label: entry.title,
            page: originalToNewPageMap.get(firstKeptPage),
            isSub: false,
          });
        }
      }
    }

    const tocHtml = tocService.renderTOCHtml(newTOCEntries);

    // 6. Preparar chunks secuenciales por anomalía (sin descargas ni renderizado)
    const anomalySections = [...(report.sections || [])];
    anomalySections.sort((a, b) => a.pageStart - b.pageStart);

    const firstSectionStart = anomalySections.length > 0 ? Math.min(...anomalySections.map(s => s.pageStart)) : 999999;
    const lastSectionEnd = anomalySections.length > 0 ? Math.max(...anomalySections.map(s => s.pageEnd)) : -1;

    const PDF_CHUNK_SIZE            = parseInt(process.env.PDF_CHUNK_SIZE            || '25', 10);
    const PDF_CHUNK_RESTART_INTERVAL = parseInt(process.env.PDF_CHUNK_RESTART_INTERVAL || '4',  10);
    const chunksToProcess = [];

    // A. Bloque Intro (Portada + TOC)
    chunksToProcess.push({
      type: 'intro',
      pages: [1]
    });

    // B. Bloques de Contenido Previos a Resultados (Pre-Resultados: Glosario, Introducción, etc.)
    const preResultPages = originalPagesToKeep.filter(p => p > 1 && p < firstSectionStart);
    for (let j = 0; j < preResultPages.length; j += PDF_CHUNK_SIZE) {
      chunksToProcess.push({
        type: 'pre-results',
        pages: preResultPages.slice(j, j + PDF_CHUNK_SIZE)
      });
    }

    // C. Bloques de Resultados (Anomalías)
    for (const section of anomalySections) {
      const sectionPages = originalPagesToKeep.filter(p => p >= section.pageStart && p <= section.pageEnd);
      if (sectionPages.length === 0) continue;

      for (let j = 0; j < sectionPages.length; j += PDF_CHUNK_SIZE) {
        chunksToProcess.push({
          type: 'anomaly',
          label: section.label,
          sectionType: section.type,
          pages: sectionPages.slice(j, j + PDF_CHUNK_SIZE)
        });
      }
    }

    // D. Bloques Huérfanos (por seguridad si hay páginas en rango de resultados no asignadas a secciones)
    const orphanPages = [];
    for (const p of originalPagesToKeep) {
      if (p > 1 && p >= firstSectionStart && p <= lastSectionEnd) {
        const inSection = anomalySections.some(s => p >= s.pageStart && p <= s.pageEnd);
        if (!inSection) {
          orphanPages.push(p);
        }
      }
    }
    for (let j = 0; j < orphanPages.length; j += PDF_CHUNK_SIZE) {
      chunksToProcess.push({
        type: 'orphan',
        pages: orphanPages.slice(j, j + PDF_CHUNK_SIZE)
      });
    }

    // E. Bloque Final (Post-Resultados: Conclusiones, Certificados, Anexos)
    const postResultPages = originalPagesToKeep.filter(p => p > 1 && p > lastSectionEnd);
    for (let j = 0; j < postResultPages.length; j += PDF_CHUNK_SIZE) {
      chunksToProcess.push({
        type: 'post-results',
        pages: postResultPages.slice(j, j + PDF_CHUNK_SIZE)
      });
    }

    const generatedAt = new Date().toLocaleDateString('es-MX', {
      year: 'numeric', month: 'long', day: 'numeric',
    });

    // Resolver la ruta del logo del frontend
    let logoUrl = process.env.LOGO_URL;
    if (!logoUrl) {
      const logoPath = path.join(__dirname, '..', '..', '..', '..', 'frontend', 'media', 'logo-nav.png');
      logoUrl = url.pathToFileURL(logoPath).href;
    }

    const chunkPdfPaths = [];
    const puppeteer = require('puppeteer');

    const launchOptions = {
      headless: 'new',
      protocolTimeout: 300000,
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

    // Helper: lanzar (o relanzar) el browser de Puppeteer
    const launchBrowser = async (currentBrowser) => {
      if (currentBrowser) {
        try { await currentBrowser.close(); } catch (_) {}
        currentBrowser = null;
        if (global.gc) global.gc();
        // Pequeña pausa para que el SO libere memoria del proceso Chromium anterior
        await new Promise(resolve => setTimeout(resolve, 400));
      }
      const mem = process.memoryUsage();
      console.log(`[Pipeline] Lanzando Chromium. RSS actual: ${Math.round(mem.rss / 1024 / 1024)}MB`);
      return puppeteer.launch(launchOptions);
    };

    console.log(`[Pipeline] Iniciando generación de PDF. Chunks totales: ${chunksToProcess.length}, CHUNK_SIZE=${PDF_CHUNK_SIZE}, RESTART_INTERVAL=${PDF_CHUNK_RESTART_INTERVAL}`);
    let browser = await launchBrowser(null);
    let chunksSinceRestart = 0;

    try {
      for (let chunkIdx = 0; chunkIdx < chunksToProcess.length; chunkIdx++) {
        const chunk = chunksToProcess[chunkIdx];

        // ── Reiniciar Chromium cada PDF_CHUNK_RESTART_INTERVAL chunks ──────────
        if (chunksSinceRestart >= PDF_CHUNK_RESTART_INTERVAL) {
          console.log(`[Pipeline] Reiniciando Chromium tras ${chunksSinceRestart} chunks (intervalo=${PDF_CHUNK_RESTART_INTERVAL})...`);
          browser = await launchBrowser(browser);
          chunksSinceRestart = 0;
        }
        console.log(`[Pipeline] Chunk ${chunkIdx + 1}/${chunksToProcess.length} (${chunk.type}, páginas original: ${chunk.pages.join(', ')})`);

        const tempImagesToDelete = [];
        const pageImageSources = new Map(); // p_original -> local file URL

        // 1. Descargar o renderizar imágenes de forma SECUENCIAL (uno por uno)
        for (const p of chunk.pages) {
          const tempFileName = `temp-img-${reportId}-${p}-${Date.now()}-${Math.random().toString(36).substring(7)}.jpg`;
          const tempFilePath = path.join(os.tmpdir(), tempFileName);

          let imgDownloaded = false;
          if (p > 1) {
            // Buscar si es anomalía y si su recorte ya existe pre-procesado
            const section = report.sections.find(s => p >= s.pageStart && p <= s.pageEnd);
            if (section) {
              const imgRelPath = `processed/${reportId}/${section.type}/page-${p}.jpg`;
              const exists = await storageService.exists(imgRelPath);
              if (exists) {
                // Descargar secuencialmente del storage
                let imgBuffer = await storageService.download(imgRelPath);
                await fs.promises.writeFile(tempFilePath, imgBuffer);
                imgBuffer = null; // Liberar buffer inmediatamente
                imgDownloaded = true;
              }
            }
          }

          // Si no se descargó (o es la portada), renderizar al vuelo
          if (!imgDownloaded) {
            const rendered = await pageRender.renderPages(tempOriginalPdfPath, [p]);
            if (rendered && rendered.length > 0) {
              let buffer = rendered[0].buffer;
              if (p > 1) {
                buffer = await imageCrop.cropFooter(buffer);
              }
              await fs.promises.writeFile(tempFilePath, buffer);
              buffer = null; // Liberar buffer inmediatamente
            } else {
              throw new Error(`No se pudo generar la imagen para la página original ${p}`);
            }
          }

          tempImagesToDelete.push(tempFilePath);
          pageImageSources.set(p, url.pathToFileURL(tempFilePath).href);
        }

        // 2. Construir HTML de este chunk
        let htmlContent = '';
        if (chunk.type === 'intro') {
          const coverPageSrc = pageImageSources.get(1);
          htmlContent = htmlBuilderService.buildIntroChunk({
            coverPageSrc,
            tocHtml,
            dashboardName,
            logoUrl,
          });
        } else {
          const chunkPagesForBuilder = [];
          
          const getPageLabel = (p) => {
            let bestEntry = null;
            for (const entry of tocEntries) {
              if (entry.originalPageNum <= p) {
                bestEntry = entry;
              } else {
                break;
              }
            }
            return bestEntry ? bestEntry.title : '';
          };

          for (const p of chunk.pages) {
            const newPageNum = originalToNewPageMap.get(p);
            const src = pageImageSources.get(p);
            const section = report.sections.find(s => p >= s.pageStart && p <= s.pageEnd);
            const label = section ? section.label : (getPageLabel(p) || 'Informe Solar');

            chunkPagesForBuilder.push({
              src,
              pageNum: newPageNum,
              label,
            });
          }

          htmlContent = htmlBuilderService.buildContentChunk({ pages: chunkPagesForBuilder });
        }

        // 3. Renderizar PDF temporal para este chunk
        const tempHtmlPath = path.join(os.tmpdir(), `temp-chunk-${chunkIdx}-${Date.now()}.html`);
        const tempPdfPath  = path.join(os.tmpdir(), `temp-chunk-${chunkIdx}-${Date.now()}.pdf`);

        await fs.promises.writeFile(tempHtmlPath, htmlContent, 'utf8');
        htmlContent = null; // Liberar string html inmediatamente

        let page = await browser.newPage();
        page.setDefaultTimeout(180000);
        page.setDefaultNavigationTimeout(180000);

        await page.goto(url.pathToFileURL(tempHtmlPath).href, {
          waitUntil: 'load',
          timeout: 90000,
        });

        // Esperar imágenes y fuentes
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

        // Limpiar HTML temporal de inmediato
        try { await fs.promises.unlink(tempHtmlPath); } catch (_) {}

        chunkPdfPaths.push(tempPdfPath);

        // 4. Limpiar imágenes temporales de este chunk de inmediato
        for (const imgPath of tempImagesToDelete) {
          try {
            if (fs.existsSync(imgPath)) {
              await fs.promises.unlink(imgPath);
            }
          } catch (err) {
            console.warn(`Warning: No se pudo eliminar imagen temporal ${imgPath}:`, err.message);
          }
        }

        // 5. Liberar memoria
        if (global.gc) {
          global.gc();
        }
        chunksSinceRestart++;

        const mem = process.memoryUsage();
        console.log(`[Pipeline] Chunk ${chunkIdx + 1}/${chunksToProcess.length} completado. RAM RSS: ${Math.round(mem.rss / 1024 / 1024)}MB | Chromium chunks: ${chunksSinceRestart}/${PDF_CHUNK_RESTART_INTERVAL}`);
      }

      await browser.close();

      // 6. Unir los chunks PDF generados secuencialmente
      console.log(`[ReportService] Uniendo chunks con pdf-lib...`);
      const mergedPdfPath = await pdfMergerService.merge(chunkPdfPaths);
      return mergedPdfPath;

    } catch (err) {
      if (browser) {
        try { await browser.close(); } catch (_) {}
      }
      // Limpiar PDFs chunk en caso de error
      for (const pdfPath of chunkPdfPaths) {
        if (fs.existsSync(pdfPath)) {
          try { fs.unlinkSync(pdfPath); } catch (_) {}
        }
      }
      throw err;
    } finally {
      // 11. Eliminar archivos temporales de forma segura
      for (const tempPath of tempFilesToDelete) {
        try {
          if (fs.existsSync(tempPath)) {
            await fs.promises.unlink(tempPath);
          }
        } catch (err) {
          console.warn(`Warning: No se pudo eliminar archivo temporal ${tempPath}:`, err.message);
        }
      }
    }
  }

  /**
   * Eliminar reporte y sus archivos del storage.
   */
  async deleteReport(id) {
    const report = await this.getReportById(id);

    // Eliminar PDF original
    await storageService.delete(report.storagePath);

    // Eliminar imágenes procesadas (directorio)
    await storageService.deleteDirectory(`processed/${id}`);

    return await reportRepository.delete(id);
  }

  /**
   * Obtiene la cantidad total de páginas del reporte (desde metadata.json o analizando el PDF).
   */
  async getReportPageCount(report) {
    const metadataPath = `processed/${report.id}/metadata.json`;
    const exists = await storageService.exists(metadataPath);
    if (exists) {
      try {
        const buffer = await storageService.download(metadataPath);
        const meta = JSON.parse(buffer.toString('utf8'));
        if (meta && typeof meta.numPages === 'number') {
          return meta.numPages;
        }
      } catch (err) {
        console.error(`[ReportService] Error leyendo metadata.json para reporte ${report.id}:`, err.message);
      }
    }

    // Fallback: descargar PDF original y parsear el número de páginas
    try {
      const pdfExists = await storageService.exists(report.storagePath);
      if (!pdfExists) return 0;
      const pdfBuffer = await storageService.download(report.storagePath);
      const { numPages } = await pdfParser.parse(pdfBuffer);
      
      // Guardar metadata.json para futuras peticiones
      try {
        await storageService.save(Buffer.from(JSON.stringify({ numPages })), metadataPath);
      } catch (saveErr) {
        console.error(`[ReportService] Error guardando metadata.json de respaldo para reporte ${report.id}:`, saveErr.message);
      }
      return numPages;
    } catch (err) {
      console.error(`[ReportService] Fallback de conteo de páginas falló para reporte ${report.id}:`, err.message);
      return 0;
    }
  }

  /**
   * Obtiene o genera la imagen original de una página específica.
   * Estrategia de búsqueda:
   *   1. Verificar si existe en original-pages/ (pre-renderizada o cacheada)
   *   2. Buscar en las secciones procesadas del reporte (hotspot_mild/, soiling/, etc.)
   *   3. Solo como último recurso, descargar el PDF y renderizar al vuelo
   *      (con límite de tamaño para evitar timeouts en Render)
   */
  async getOrCreatePageImage(reportId, pageNum) {
    // 1. Fast path: ya existe la imagen original pre-renderizada
    const imgRelPath = `processed/${reportId}/original-pages/page-${pageNum}.jpg`;
    const exists = await storageService.exists(imgRelPath);
    if (exists) {
      return imgRelPath;
    }

    // 2. Buscar en las imágenes de secciones ya procesadas
    const report = await this.getReportById(reportId);
    if (report.sections && report.sections.length > 0) {
      for (const section of report.sections) {
        if (pageNum >= section.pageStart && pageNum <= section.pageEnd) {
          const sectionImgPath = `processed/${reportId}/${section.type}/page-${pageNum}.jpg`;
          const sectionExists = await storageService.exists(sectionImgPath);
          if (sectionExists) {
            console.log(`[ReportService] Página ${pageNum} encontrada en sección ${section.type}`);
            return sectionImgPath;
          }
        }
      }
    }

    // 3. Fallback: renderizar al vuelo (solo para PDFs de tamaño manejable)
    const MAX_ON_THE_FLY_SIZE = 50 * 1024 * 1024; // 50 MB
    if (report.fileSize > MAX_ON_THE_FLY_SIZE) {
      throw new Error(
        `La página ${pageNum} no está disponible para visualización inmediata. ` +
        `El PDF es demasiado grande (${Math.round(report.fileSize / 1024 / 1024)} MB) para renderizar al vuelo.`
      );
    }

    const pdfExists = await storageService.exists(report.storagePath);
    if (!pdfExists) {
      throw new Error('No se encontró el archivo PDF original en el almacenamiento.');
    }
    const pdfBuffer = await storageService.download(report.storagePath);

    console.log(`[ReportService] Renderizando al vuelo página ${pageNum} para reporte ${reportId}`);
    const rendered = await pageRender.renderPages(pdfBuffer, [pageNum]);
    if (!rendered || rendered.length === 0) {
      throw new Error(`No se pudo renderizar la página ${pageNum}`);
    }

    const { buffer } = rendered[0];
    await storageService.save(buffer, imgRelPath);
    return imgRelPath;
  }
}

module.exports = new ReportService();
