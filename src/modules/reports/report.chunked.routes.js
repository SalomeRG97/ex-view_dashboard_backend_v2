'use strict';

/**
 * report.chunked.routes.js
 * Rutas para subida de PDFs grandes en fragmentos (chunked upload).
 *
 * Montadas en: /api/admin/dashboards/:dashboardId/reports/chunks
 */

const { Router } = require('express');
const { requireAdminAuth } = require('../../middlewares/auth.middleware');
const { chunkUpload } = require('../../config/multer');
const { initUpload, uploadChunk, completeUpload } = require('./report.chunked.controller');

const router = Router({ mergeParams: true });

// POST   /api/admin/dashboards/:dashboardId/reports/chunks
// → Iniciar sesión de upload (recibe JSON: { fileName, totalChunks })
router.post('/', requireAdminAuth, initUpload);

// PUT    /api/admin/dashboards/:dashboardId/reports/chunks/:uploadId/:chunkIndex
// → Subir un fragmento (campo "chunk" en multipart/form-data)
router.put(
  '/:uploadId/:chunkIndex',
  requireAdminAuth,
  chunkUpload.single('chunk'),
  uploadChunk
);

// POST   /api/admin/dashboards/:dashboardId/reports/chunks/:uploadId/complete
// → Ensamblar todos los fragmentos y procesar el PDF final
router.post('/:uploadId/complete', requireAdminAuth, completeUpload);

module.exports = router;
