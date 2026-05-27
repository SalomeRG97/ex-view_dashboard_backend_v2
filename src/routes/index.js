const { Router } = require('express');
const dashboardRoutes = require('../modules/dashboards/dashboard.routes');
const reportRoutes    = require('../modules/reports/report.routes');
const reportController = require('../modules/reports/report.controller');
const { requireAdminAuth } = require('../middlewares/auth.middleware');

const router = Router();

// ── RUTAS ADMIN ────────────────────────────────────────────────
// CRUD dashboards
router.use('/admin/dashboards', dashboardRoutes);

// Reportes anidados bajo dashboard (upload, listado)
router.use('/admin/dashboards/:dashboardId/reports', reportRoutes);

// Eliminar reporte (admin)
router.delete('/admin/reports/:id', requireAdminAuth, reportController.delete);

// ── RUTAS CLIENTE (sin auth) ────────────────────────────────────
// Obtener info del reporte (para mostrar anomalías disponibles)
router.get('/reports/:id', reportController.getById);

// Descargar informe original (sin auth)
router.get('/reports/:id/original', reportController.downloadOriginal);

// Generar PDF filtrado (cliente puede generar)
router.post('/reports/:id/generate', reportController.generate);

module.exports = router;
