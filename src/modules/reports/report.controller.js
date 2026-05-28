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
      res.status(200).json(report);
    } catch (err) { next(err); }
  }

  // GET /api/reports/:id/original (descargar PDF original sin auth)
  async downloadOriginal(req, res, next) {
    try {
      const report = await reportService.getReportById(req.params.id);
      const storageService = require('../../storage/storageFactory');
      const exists = await storageService.exists(report.storagePath);

      if (!exists) {
        return res.status(404).json({ error: 'No se encontró el archivo PDF original en el almacenamiento.' });
      }

      const buffer = await storageService.download(report.storagePath);
      res.setHeader('Content-Type', 'application/pdf');
      if (req.query.inline === 'true') {
        res.setHeader('Content-Disposition', `inline; filename="${report.originalName}"`);
      } else {
        res.setHeader('Content-Disposition', `attachment; filename="${report.originalName}"`);
      }
      res.send(buffer);
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
