const { Router } = require('express');
const controller = require('./report.controller');
const { requireAdminAuth } = require('../../middlewares/auth.middleware');
const upload = require('../../config/multer');

const router = Router({ mergeParams: true }); // mergeParams para heredar :dashboardId

// ── RUTAS ADMIN (requieren auth) ─────────────────────────────
// POST   /api/admin/dashboards/:dashboardId/reports       → subir PDF
router.post('/', requireAdminAuth, upload.single('pdf'), controller.upload);

// GET    /api/admin/dashboards/:dashboardId/reports       → listar reportes del dashboard
router.get('/', requireAdminAuth, controller.getByDashboard);

// DELETE /api/admin/reports/:id                           → eliminar reporte
// (esta ruta se monta por separado en index.js)

module.exports = router;
