const storageService       = require('../../storage/storageFactory');
const reportRepository     = require('./report.repository');
const processingService    = require('./services/ReportProcessingService');
const htmlBuilderService   = require('./services/HTMLBuilderService');
const pdfGeneratorService  = require('./services/PDFGeneratorService');

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

    // 1. Obtener buffer del PDF original
    const exists = await storageService.exists(report.storagePath);
    if (!exists) {
      throw new Error('No se encontró el archivo PDF original en el servidor.');
    }
    const pdfBuffer = await storageService.download(report.storagePath);

    // 2. Parsear el PDF para obtener texto y estructura de páginas
    const { text, numPages, pages: pdfPages } = await pdfParser.parse(pdfBuffer);

    // 3. Obtener entradas de la Tabla de Contenidos original
    const tocEntries = pdfParser.parseTOCEntries(pdfPages, numPages);

    // 4. Determinar qué páginas originales se mantendrán
    // Página 1: Sí (portada)
    // Página 2: No (reemplazada por la nueva TOC)
    // Páginas 3+: Sí, a menos que sean de una anomalía excluida
    const originalPagesToKeep = [1];
    for (let p = 3; p <= numPages; p++) {
      // Buscar si pertenece a alguna sección de anomalía
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

    // 5. Crear mapa de correspondencia: p_original -> p_nueva
    // En el PDF nuevo:
    // Pág 1: Portada (original 1)
    // Pág 2: Nueva TOC
    // Pág 3+: Páginas de originalPagesToKeep en orden (empezando desde el índice 1 del array)
    const originalToNewPageMap = new Map();
    originalToNewPageMap.set(1, 1);
    for (let i = 1; i < originalPagesToKeep.length; i++) {
      originalToNewPageMap.set(originalPagesToKeep[i], i + 2);
    }

    // 6. Filtrar y recalcular las entradas de la Tabla de Contenidos
    const newTOCEntries = [];
    for (let idx = 0; idx < tocEntries.length; idx++) {
      const entry = tocEntries[idx];
      if (entry.isSub) {
        // Subsección: se mantiene si su página original exacta está mapeada
        if (originalToNewPageMap.has(entry.originalPageNum)) {
          newTOCEntries.push({
            label: entry.title,
            page: originalToNewPageMap.get(entry.originalPageNum),
            isSub: true,
          });
        }
      } else {
        // Sección principal: se mantiene si alguna página en su rango está mapeada.
        // El rango va desde su página hasta la página anterior a la siguiente sección principal.
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

    // 7. Determinar qué páginas deben renderizarse al vuelo
    // Son aquellas en originalPagesToKeep que no tienen imágenes pre-procesadas en disco.
    // O si son la página 1 (portada).
    const pagesToRenderOnTheFly = [];
    const pageImageSources = new Map(); // p_original -> ruta de la imagen (file:///)

    for (const p of originalPagesToKeep) {
      if (p === 1) {
        pagesToRenderOnTheFly.push(p);
        continue;
      }

      // Buscar si pertenece a alguna sección de anomalía
      const section = report.sections.find(s => p >= s.pageStart && p <= s.pageEnd);
      if (section) {
        const imgRelPath = `processed/${reportId}/${section.type}/page-${p}.jpg`;
        const exists = await storageService.exists(imgRelPath);

        if (exists) {
          // Usar la imagen recortada pre-procesada
          const publicUrlOrPath = storageService.getPublicUrl(imgRelPath);
          const fileUrl = (publicUrlOrPath.startsWith('http://') || publicUrlOrPath.startsWith('https://'))
            ? publicUrlOrPath
            : url.pathToFileURL(publicUrlOrPath).href;
          pageImageSources.set(p, fileUrl);
        } else {
          // Si no existe el recorte, renderizar al vuelo
          pagesToRenderOnTheFly.push(p);
        }
      } else {
        // Páginas fuera de anomalías: renderizar al vuelo
        pagesToRenderOnTheFly.push(p);
      }
    }

    const tempFilesToDelete = [];

    try {
      // 8. Renderizar al vuelo las páginas necesarias
      if (pagesToRenderOnTheFly.length > 0) {
        const rendered = await pageRender.renderPages(pdfBuffer, pagesToRenderOnTheFly);
        
        for (const { page, buffer } of rendered) {
          let finalBuffer = buffer;
          if (page > 1) {
            finalBuffer = await imageCrop.cropFooter(buffer);
          }

          // Crear un archivo temporal para la página renderizada en el directorio temporal del OS
          const tempFileName = `temp-render-${reportId}-${page}-${Date.now()}-${Math.random().toString(36).substring(7)}.jpg`;
          const tempFilePath = path.join(os.tmpdir(), tempFileName);

          await fs.promises.writeFile(tempFilePath, finalBuffer);
          tempFilesToDelete.push(tempFilePath);

          const fileUrl = url.pathToFileURL(tempFilePath).href;
          pageImageSources.set(page, fileUrl);
        }
      }

      // 9. Construir la estructura final de páginas para el constructor HTML
      // Debe excluir la página 1 (se pasa por separado como coverPageSrc)
      const pagesForBuilder = [];
      const totalPages = originalPagesToKeep.length + 1;

      // Helper para buscar el título de sección de la TOC original que corresponde a una página
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

      for (let i = 1; i < originalPagesToKeep.length; i++) {
        const p = originalPagesToKeep[i];
        const newPageNum = originalToNewPageMap.get(p);
        const src = pageImageSources.get(p);

        if (!src) {
          throw new Error(`No se pudo generar la imagen para la página original ${p}`);
        }

        // Obtener el label dinámico
        const section = report.sections.find(s => p >= s.pageStart && p <= s.pageEnd);
        const label = section ? section.label : (getPageLabel(p) || 'Informe Solar');

        pagesForBuilder.push({
          src,
          pageNum: newPageNum,
          label,
        });
      }

      const coverPageSrc = pageImageSources.get(1);
      if (!coverPageSrc) {
        throw new Error('No se pudo generar la portada del informe.');
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

      // 10. Construir HTML y generar PDF
      const html = htmlBuilderService.build({
        dashboardName,
        clientName,
        coverPageSrc,
        tocHtml,
        pages: pagesForBuilder,
        totalPages,
        generatedAt,
        logoUrl,
      });

      const generatedPdfBuffer = await pdfGeneratorService.generate(html);
      return generatedPdfBuffer;

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
}

module.exports = new ReportService();
