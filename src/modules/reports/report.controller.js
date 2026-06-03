const reportService = require('./report.service');

class ReportController {
  // POST /api/admin/dashboards/:dashboardId/reports
  async upload(req, res, next) {
    try {
      if (!req.file) return res.status(400).json({ error: 'No se recibió archivo PDF' });

      const report = await reportService.uploadReport(req.params.dashboardId, req.file);
      res.status(201).json({
        message: 'PDF subido. Procesamiento iniciado en segundo plano.',
        report,
      });
    } catch (err) { next(err); }
  }

  // GET /api/admin/dashboards/:dashboardId/reports
  async getByDashboard(req, res, next) {
    try {
      const reports = await reportService.getReportsByDashboard(req.params.dashboardId);
      res.status(200).json(reports);
    } catch (err) { next(err); }
  }

  // GET /api/reports/:id  (acceso cliente también)
  async getById(req, res, next) {
    try {
      const report = await reportService.getReportById(req.params.id);
      const numPages = await reportService.getReportPageCount(report);
      res.status(200).json({ ...report, numPages });
    } catch (err) { next(err); }
  }

  // GET /api/reports/:id/pages/:pageNum (acceso cliente también)
  async getPageImage(req, res, next) {
    try {
      const { id, pageNum } = req.params;
      const pageNumber = parseInt(pageNum, 10);
      if (isNaN(pageNumber) || pageNumber < 1) {
        return res.status(400).json({ error: 'Número de página inválido' });
      }

      const imgPath = await reportService.getOrCreatePageImage(id, pageNumber);
      
      // Añadir cabeceras HTTP de caché
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

      const storageService = require('../../storage/storageFactory');
      if (process.env.STORAGE_PROVIDER === 'hostinger') {
        const publicUrl = storageService.getPublicUrl(imgPath);
        return res.redirect(publicUrl);
      } else {
        const localPath = storageService.getPublicUrl(imgPath);
        return res.sendFile(localPath);
      }
    } catch (err) { next(err); }
  }

  // GET /api/reports/:id/original (descargar PDF original sin auth)
  async downloadOriginal(req, res, next) {
    const { pipeline } = require('stream');
    
    const formatMemory = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    const logMemory = (stage) => {
      const mem = process.memoryUsage();
      console.log(`[Memory Diagnostics] [${stage}] RSS: ${formatMemory(mem.rss)} | Heap: ${formatMemory(mem.heapUsed)}/${formatMemory(mem.heapTotal)} | External: ${formatMemory(mem.external)}`);
    };

    try {
      const report = await reportService.getReportById(req.params.id);
      const storageService = require('../../storage/storageFactory');
      const exists = await storageService.exists(report.storagePath);

      if (!exists) {
        return res.status(404).json({ error: 'No se encontró el archivo PDF original en el almacenamiento.' });
      }

      const publicUrlOrPath = storageService.getPublicUrl(report.storagePath);
      const isRemote = publicUrlOrPath.startsWith('http://') || publicUrlOrPath.startsWith('https://');

      // Si es visualización inline (ej: para el iframe de visualización)
      if (req.query.inline === 'true') {
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${report.originalName}"`);
        if (isRemote) {
          // Redirigir directamente al CDN/servidor de Hostinger para visualización rápida y soporte nativo de rangos
          return res.redirect(publicUrlOrPath);
        } else {
          // Local: usar res.sendFile para soporte de rangos nativo en desarrollo
          return res.sendFile(publicUrlOrPath);
        }
      }

      // --- CONFIGURACIÓN DE DESCARGA DIRECTA POR STREAMS ---
      logMemory('Before Download');
      console.log(`[Download] Iniciando descarga en streaming para el reporte: ${report.originalName} (${report.id})`);

      // Configurar cabeceras de descarga
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${report.originalName}"`);
      if (report.fileSize) {
        res.setHeader('Content-Length', report.fileSize);
      }

      // Obtener el Readable Stream desde el storage (local o FTP)
      const stream = await storageService.getReadableStream(report.storagePath);

      // Manejar abortos del cliente (ej: si el usuario cancela la descarga o cierra la pestaña)
      req.on('close', () => {
        if (!stream.destroyed) {
          console.log('[Download] La conexión HTTP se cerró prematuramente. Destruyendo el stream de lectura.');
          stream.destroy();
        }
      });

      // Medir transmisión
      let totalBytesSent = 0;
      let lastLogTime = Date.now();
      
      stream.on('data', (chunk) => {
        totalBytesSent += chunk.length;
        const now = Date.now();
        if (now - lastLogTime > 3000) { // Loggear cada 3 segundos durante la descarga
          logMemory(`Transmitted ${formatMemory(totalBytesSent)}`);
          lastLogTime = now;
        }
      });

      // Enlazar los streams y manejar finalización/errores de forma segura
      pipeline(stream, res, (err) => {
        logMemory('Finished');
        if (err) {
          console.error('[Download] Error en el pipeline de descarga:', err.message);
          if (!res.headersSent) {
            res.status(500).json({ error: 'Error al transmitir el archivo PDF.' });
          }
        } else {
          console.log(`[Download] Descarga completada exitosamente. Total enviado: ${formatMemory(totalBytesSent)}`);
        }
      });

    } catch (err) { next(err); }
  }

  // POST /api/reports/:id/generate  (cliente puede generar)
  async generate(req, res, next) {
    try {
      const { selectedTypes = [], selectedSectionIds = [], dashboardName, clientName } = req.body;

      if (
        (!selectedTypes || !Array.isArray(selectedTypes) || selectedTypes.length === 0) &&
        (!selectedSectionIds || !Array.isArray(selectedSectionIds) || selectedSectionIds.length === 0)
      ) {
        return res.status(400).json({ error: 'Debes seleccionar al menos una sección o tipo de anomalía.' });
      }

      const pdfBuffer = await reportService.generateFilteredReport(req.params.id, {
        selectedSectionIds,
        selectedTypes,
        dashboardName: dashboardName || 'Informe Solar',
        clientName:    clientName    || 'Cliente'
      });

      // Usar el nombre original del informe como nombre del archivo descargado
      const report = await reportService.getReportById(req.params.id);
      const originalName = report.originalName || `informe-filtrado-${req.params.id}.pdf`;

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${originalName}"`);
      res.send(pdfBuffer);
    } catch (err) { next(err); }
  }

  // DELETE /api/admin/reports/:id
  async delete(req, res, next) {
    try {
      await reportService.deleteReport(req.params.id);
      res.status(204).send();
    } catch (err) { next(err); }
  }
}

module.exports = new ReportController();
