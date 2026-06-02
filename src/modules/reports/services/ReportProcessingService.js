'use strict';

const path           = require('path');
const storageService = require('../../../storage/storageFactory');
const pdfParser      = require('./PDFParserService');
const pageRender     = require('./PageRenderService');
const imageCrop      = require('./ImageCropService');
const reportRepository = require('../report.repository');

class ReportProcessingService {

  /**
   * Procesa el PDF de forma asíncrona: renderiza páginas, recorta y guarda en storage.
   * @param {string} reportId  - ID del reporte en DB
   * @param {Buffer} pdfBuffer - Buffer del PDF original
   */
  async process(reportId, pdfBuffer) {
    const startTime = Date.now();

    try {
      await reportRepository.updateStatus(reportId, 'PROCESSING');

      // 1. Parsear PDF para obtener texto y estructura de secciones
      const { text, numPages, pages } = await pdfParser.parse(pdfBuffer);
      const detectedAnomalies = pdfParser.detectAnomalies(text);
      const sections          = pdfParser.detectPageRanges(text, numPages, detectedAnomalies, pages);

      if (!sections || sections.length === 0) {
        console.warn(`[ReportProcessingService] ⚠️ No se detectaron secciones en reporte ${reportId}`);
        await reportRepository.updateStatus(reportId, 'READY');
        return;
      }

      const processedSections = [];

      // 2. Procesar cada sección de anomalía
      for (const section of sections) {
        let pageNumbers = pageRender.pageRange(section.pageStart, section.pageEnd);

        // Límite de seguridad: máximo 150 páginas por sección
        if (pageNumbers.length > 150) {
          console.warn(`[ReportProcessingService] ⚠️ Sección ${section.type}: truncada a 150 páginas (tenía ${pageNumbers.length})`);
          pageNumbers = pageNumbers.slice(0, 150);
        }

        console.log(`[ReportProcessingService] 📄 Sección "${section.type}": páginas ${pageNumbers[0]}–${pageNumbers[pageNumbers.length - 1]}`);

        // 3. Renderizar páginas (Poppler o Puppeteer)
        const renderedPages = await pageRender.renderPages(pdfBuffer, pageNumbers);

        if (renderedPages.length === 0) {
          console.warn(`[ReportProcessingService] ⚠️ Sección ${section.type}: 0 páginas renderizadas.`);
        }

        const imagePaths = [];

        for (const { page, buffer } of renderedPages) {
          // 4. Recortar footer con Sharp
          const cropped = await imageCrop.cropFooter(buffer);

          // 5. Guardar en storage (local o FTP)
          const destPath = `processed/${reportId}/${section.type}/page-${page}.jpg`;
          await storageService.save(cropped, destPath);

          imagePaths.push(storageService.getPublicUrl(destPath));
        }

        processedSections.push({
          type:       section.type,
          label:      section.label,
          pageStart:  section.pageStart,
          pageEnd:    section.pageEnd,
          imagePaths: JSON.stringify(imagePaths),
        });
      }

      // 6. Guardar secciones en DB y marcar como READY
      await reportRepository.updateWithSections(reportId, processedSections);

      // 7. Pre-renderizar portada del PDF original (página 1) y guardar metadatos
      try {
        console.log(`[ReportProcessingService] Pre-renderizando portada (página 1) para reporte ${reportId}`);
        const renderedCover = await pageRender.renderPages(pdfBuffer, [1]);
        if (renderedCover.length > 0) {
          await storageService.save(renderedCover[0].buffer, `processed/${reportId}/original-pages/page-1.jpg`);
        }
      } catch (coverErr) {
        console.error(`[ReportProcessingService] ⚠️ Error pre-renderizando portada:`, coverErr.message);
      }

      try {
        const metadata = { numPages };
        await storageService.save(Buffer.from(JSON.stringify(metadata)), `processed/${reportId}/metadata.json`);
      } catch (metaErr) {
        console.error(`[ReportProcessingService] ⚠️ Error guardando metadata:`, metaErr.message);
      }

      const totalDuration = Date.now() - startTime;
      console.log(`[ReportProcessingService] ✅ Reporte ${reportId} procesado en ${totalDuration}ms`);

    } catch (err) {
      const msg = err.message || '';

      const isSystemDep = msg.includes('GraphicsMagick') || msg.includes('gm') ||
                          msg.includes('gs') || msg.includes('ghostscript') ||
                          msg.includes('ENOENT') || msg.includes('spawn') ||
                          msg.includes('convert');

      if (isSystemDep) {
        console.error(`[ReportProcessingService] ⚠️ Reporte ${reportId}: dependencia del sistema faltante.`);
        await reportRepository.updateStatus(reportId, 'UPLOADED');
      } else {
        console.error(`[ReportProcessingService] ❌ Error procesando reporte ${reportId}:`, msg);
        await reportRepository.updateStatus(reportId, 'FAILED');
      }
    }
  }
}

module.exports = new ReportProcessingService();
