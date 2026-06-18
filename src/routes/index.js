const { Router } = require('express');
const dashboardRoutes    = require('../modules/dashboards/dashboard.routes');
const reportRoutes       = require('../modules/reports/report.routes');
const chunkedRoutes      = require('../modules/reports/report.chunked.routes');
const reportController   = require('../modules/reports/report.controller');
const { requireAdminAuth } = require('../middlewares/auth.middleware');
const { generalQueue, reportQueue } = require('../middlewares/queues');

const router = Router();

// ── RUTAS ADMIN ────────────────────────────────────────────────
// CRUD dashboards
router.use('/admin/dashboards', generalQueue, dashboardRoutes);

// Chunked upload (debe montarse ANTES que /reports para que /chunks no sea ambiguo)
router.use('/admin/dashboards/:dashboardId/reports/chunks', reportQueue, chunkedRoutes);

// Reportes anidados bajo dashboard (upload directo legacy, listado)
router.use('/admin/dashboards/:dashboardId/reports', reportQueue, reportRoutes);

// Eliminar reporte (admin)
router.delete('/admin/reports/:id', requireAdminAuth, reportQueue, reportController.delete);

// ── RUTAS CLIENTE (sin auth) ────────────────────────────────────
// Obtener info del reporte (para mostrar anomalías disponibles)
router.get('/reports/:id', reportQueue, reportController.getById);

// Obtener página específica del PDF como imagen
router.get('/reports/:id/pages/:pageNum', reportQueue, reportController.getPageImage);

// Descargar informe original (sin auth)
router.get('/reports/:id/original', reportQueue, reportController.downloadOriginal);

// Generar PDF filtrado (cliente puede generar)
router.post('/reports/:id/generate', reportQueue, reportController.generate);

module.exports = router;
