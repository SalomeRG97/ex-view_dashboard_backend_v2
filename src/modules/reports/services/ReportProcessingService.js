'use strict';

const path           = require('path');
const storageService = require('../../../storage/storageFactory');
const pdfParser      = require('./PDFParserService');
const reportRepository = require('../report.repository');

class ReportProcessingService {

  /**
   * Procesa el PDF de forma asíncrona: parsea secciones sin renderizar imágenes.
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
        console.log(`[ReportProcessingService] 📄 Sección "${section.type}": páginas ${section.pageStart}–${section.pageEnd}`);

        processedSections.push({
          type:       section.type,
          label:      section.label,
          pageStart:  section.pageStart,
          pageEnd:    section.pageEnd,
          imagePaths: "[]", // Ya no extraemos imágenes
        });
      }

      // 3. Guardar secciones en DB y marcar como READY
      await reportRepository.updateWithSections(reportId, processedSections);

      try {
        const metadata = { numPages };
        await storageService.save(Buffer.from(JSON.stringify(metadata)), `processed/${reportId}/metadata.json`);
      } catch (metaErr) {
        console.error(`[ReportProcessingService] ⚠️ Error guardando metadata:`, metaErr.message);
      }

      const elapsed = Date.now() - startTime;
      console.log(`[ReportProcessingService] ✅ Reporte ${reportId} procesado en ${elapsed}ms.`);

      await reportRepository.updateStatus(reportId, 'READY');

    } catch (err) {
      console.error(`[ReportProcessingService] ❌ Error procesando reporte ${reportId}:`, err.message || err);
      await reportRepository.updateStatus(reportId, 'FAILED');
    }
  }
}

module.exports = new ReportProcessingService();
