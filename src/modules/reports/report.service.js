'use strict';

const storageService     = require('../../storage/storageFactory');
const reportRepository   = require('./report.repository');
const processingService  = require('./services/ReportProcessingService');
const pythonPDFService   = require('./services/PythonPDFService');
const pdfParser          = require('./services/PDFParserService');

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

    // 1. Guardar PDF original en storage usando el archivo temporal
    const destPath = `reports/${dashboardId}/${Date.now()}-${fixedName}`;
    
    // Si viene desde diskStorage, usa saveFile. Si por alguna razón es buffer, usa save.
    if (file.path) {
      await storageService.saveFile(file.path, destPath);
    } else {
      await storageService.save(file.buffer, destPath);
    }

    // 2. Crear registro en DB con status UPLOADED
    const report = await reportRepository.create({
      dashboardId,
      originalName: fixedName,
      storagePath:  destPath,
      fileSize:     file.size,
      status:       'UPLOADED',
    });

    // 3. Disparar procesamiento async pasando el archivo o buffer
    const processData = file.path || file.buffer;
    processingService.process(report.id, processData).catch(err => {
      console.error('[ReportService] ⚠️ Procesamiento async falló:', err.message);
    });

    return report;
  }

  /**
   * Corrige Mojibake de UTF-8 codificado como ISO-8859-1 (Latin1) en cadenas de caracteres.
   */
  fixUtf8Encoding(str) {
    if (!str) return str;
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

  /**
   * Genera el PDF filtrado usando el pipeline Python nativo (pikepdf + pdfplumber + reportlab).
   *
   * A diferencia del pipeline anterior, este enfoque:
   *  - NO convierte páginas a imágenes (~50KB/página en lugar de ~15MB/página)
   *  - NO usa Puppeteer ni Chromium
   *  - NO escribe archivos temporales en disco
   *  - Trabaja directamente con objetos PDF nativos
   *
   * @param {string} reportId
   * @param {object} options
   * @param {string[]} options.selectedSectionIds - IDs de secciones seleccionadas
   * @param {string[]} options.selectedTypes      - Tipos de anomalías seleccionados
   * @param {string}   options.dashboardName
   * @returns {Promise<Buffer>} Buffer con el PDF filtrado listo para streaming
   */
  async generateFilteredReport(reportId, options = {}) {
    const {
      selectedSectionIds = [],
      selectedTypes      = [],
      dashboardName      = 'Informe Solar',
    } = options;

    const report = await this.getReportById(reportId);

    if (report.status !== 'READY') {
      throw new Error('El reporte aún no está listo para generar. Estado: ' + report.status);
    }

    const exists = await storageService.exists(report.storagePath);
    if (!exists) {
      throw new Error('No se encontró el archivo PDF original en el servidor.');
    }

    // Obtener URL pública del PDF para que Python lo descargue directamente
    const pdfUrl = storageService.getPublicUrl(report.storagePath);
    if (!pdfUrl || !pdfUrl.startsWith('http')) {
      throw new Error(
        'El PDF original no tiene una URL pública accesible. ' +
        'Verifica que STORAGE_PROVIDER=hostinger y STORAGE_PUBLIC_URL estén configurados.'
      );
    }

    // Construir la lista de secciones seleccionadas para pasar a Python
    // Incluye pageStart, pageEnd, label, type e isSub (si aplica)
    const allSections = Array.isArray(report.sections) ? report.sections : [];

    const selectedSections = allSections
      .filter(section => {
        return selectedSectionIds.includes(section.id) ||
               selectedTypes.includes(section.type);
      })
      .map(section => ({
        id:        section.id,
        type:      section.type,
        label:     section.label,
        pageStart: section.pageStart,
        pageEnd:   section.pageEnd,
        isSub:     section.isSub || false,
      }));

    if (selectedSections.length === 0) {
      throw new Error('No se seleccionó ninguna sección válida para incluir en el reporte filtrado.');
    }

    console.log(
      `[ReportService] Generando PDF filtrado para reporte ${reportId}. ` +
      `Secciones: ${selectedSections.length}, URL: ${pdfUrl.substring(0, 60)}...`
    );

    // Delegar toda la generación al servicio Python
    const pdfBuffer = await pythonPDFService.generate({
      pdfUrl,
      selectedSections,
      allSections,
      dashboardName,
    });

    const mem = process.memoryUsage();
    console.log(
      `[ReportService] PDF filtrado generado. Tamaño: ${(pdfBuffer.length / 1024).toFixed(1)} KB. ` +
      `RSS: ${Math.round(mem.rss / 1024 / 1024)}MB`
    );

    return pdfBuffer;
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
