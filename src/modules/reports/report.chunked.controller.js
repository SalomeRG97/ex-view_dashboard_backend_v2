'use strict';

/**
 * report.chunked.controller.js
 * Maneja la subida de PDFs grandes en fragmentos (chunked upload).
 *
 * Flujo:
 *   1. POST   /chunks              → initUpload()   → { uploadId, totalChunks }
 *   2. PUT    /chunks/:uploadId/:chunkIndex → uploadChunk()  → { ok }
 *   3. POST   /chunks/:uploadId/complete   → completeUpload() → { report }
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { v4: uuidv4 } = require('uuid');
const reportService = require('./report.service');

// Mapa en memoria: uploadId → { dashboardId, originalName, totalChunks, receivedChunks, dir }
// En producción con múltiples instancias se usaría Redis; para single-instance es suficiente.
const sessions = new Map();

// Tiempo de vida máximo de una sesión sin actividad: 30 minutos
const SESSION_TTL_MS = 30 * 60 * 1000;

/**
 * POST /api/admin/dashboards/:dashboardId/reports/chunks
 * Body JSON: { fileName, totalChunks }
 * → Crea directorio temporal, guarda sesión, devuelve uploadId.
 */
async function initUpload(req, res, next) {
  try {
    const { dashboardId } = req.params;
    const { fileName, totalChunks } = req.body;

    if (!fileName || typeof fileName !== 'string')
      return res.status(400).json({ error: 'fileName es requerido' });
    if (!Number.isInteger(Number(totalChunks)) || Number(totalChunks) < 1)
      return res.status(400).json({ error: 'totalChunks debe ser un entero positivo' });

    const uploadId = uuidv4();
    const dir = path.join(os.tmpdir(), `chunked-${uploadId}`);
    fs.mkdirSync(dir, { recursive: true });

    sessions.set(uploadId, {
      dashboardId,
      originalName: fileName,
      totalChunks:  Number(totalChunks),
      receivedChunks: new Set(),
      dir,
      createdAt: Date.now(),
    });

    // Limpiar sesión expirada en background
    setTimeout(() => cleanSession(uploadId), SESSION_TTL_MS);

    console.log(`[ChunkedUpload] Sesión iniciada: ${uploadId} | chunks: ${totalChunks} | archivo: ${fileName}`);
    res.status(201).json({ uploadId, totalChunks: Number(totalChunks) });
  } catch (err) { next(err); }
}

/**
 * PUT /api/admin/dashboards/:dashboardId/reports/chunks/:uploadId/:chunkIndex
 * Body: archivo binario (campo "chunk" via multipart/form-data)
 * → Guarda el chunk en el directorio temporal de la sesión.
 */
async function uploadChunk(req, res, next) {
  try {
    const { uploadId, chunkIndex } = req.params;
    const idx = Number(chunkIndex);

    const session = sessions.get(uploadId);
    if (!session) {
      // Limpiar archivo temporal de multer si existe
      if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
      return res.status(404).json({ error: 'Sesión de upload no encontrada o expirada' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No se recibió el chunk' });
    }

    if (isNaN(idx) || idx < 0 || idx >= session.totalChunks) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: `chunkIndex inválido: ${chunkIndex}` });
    }

    // Mover el chunk desde el tmp de multer al directorio de la sesión
    const destPath = path.join(session.dir, `chunk-${String(idx).padStart(6, '0')}.bin`);
    fs.renameSync(req.file.path, destPath);
    session.receivedChunks.add(idx);

    console.log(`[ChunkedUpload] Chunk ${idx + 1}/${session.totalChunks} recibido para sesión ${uploadId}`);
    res.json({ ok: true, chunkIndex: idx, received: session.receivedChunks.size });
  } catch (err) { next(err); }
}

/**
 * POST /api/admin/dashboards/:dashboardId/reports/chunks/:uploadId/complete
 * → Verifica que todos los chunks llegaron, los concatena en un PDF temporal
 *   y delega a reportService.uploadReport() como si fuera un archivo normal.
 */
async function completeUpload(req, res, next) {
  let assembledPath = null;
  let session = null;

  try {
    const { dashboardId, uploadId } = req.params;
    session = sessions.get(uploadId);

    if (!session) {
      return res.status(404).json({ error: 'Sesión de upload no encontrada o expirada' });
    }

    // Verificar que todos los chunks llegaron
    if (session.receivedChunks.size !== session.totalChunks) {
      const missing = [];
      for (let i = 0; i < session.totalChunks; i++) {
        if (!session.receivedChunks.has(i)) missing.push(i);
      }
      return res.status(400).json({
        error: `Faltan ${missing.length} chunk(s)`,
        missingChunks: missing.slice(0, 20), // mostrar máximo 20
      });
    }

    // Ensamblar: concatenar chunks en orden
    console.log(`[ChunkedUpload] Ensamblando ${session.totalChunks} chunks para ${session.originalName}...`);
    assembledPath = path.join(os.tmpdir(), `assembled-${uploadId}.pdf`);
    const writeStream = fs.createWriteStream(assembledPath);

    await new Promise((resolve, reject) => {
      writeStream.on('error', reject);
      writeStream.on('finish', resolve);

      (async () => {
        for (let i = 0; i < session.totalChunks; i++) {
          const chunkPath = path.join(session.dir, `chunk-${String(i).padStart(6, '0')}.bin`);
          await new Promise((res2, rej2) => {
            const rs = fs.createReadStream(chunkPath);
            rs.on('error', rej2);
            rs.on('end', res2);
            rs.pipe(writeStream, { end: false });
          });
        }
        writeStream.end();
      })().catch(reject);
    });

    const stat = fs.statSync(assembledPath);
    console.log(`[ChunkedUpload] Ensamblado completo. Tamaño: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);

    // Construir objeto compatible con lo que espera reportService.uploadReport()
    const mockFile = {
      path:         assembledPath,
      originalname: session.originalName,
      mimetype:     'application/pdf',
      size:         stat.size,
    };

    const report = await reportService.uploadReport(dashboardId, mockFile);

    // Limpiar sesión y directorio de chunks
    cleanSession(uploadId);

    res.status(201).json({
      message: 'PDF ensamblado y procesamiento iniciado en segundo plano.',
      report,
    });

  } catch (err) {
    // Limpiar archivo ensamblado si hubo error
    if (assembledPath) {
      fs.unlink(assembledPath, () => {});
    }
    if (session) cleanSession(session.id || req.params.uploadId);
    next(err);
  }
}

/**
 * Eliminar directorio temporal de chunks y remover sesión del mapa.
 */
function cleanSession(uploadId) {
  const session = sessions.get(uploadId);
  if (!session) return;
  sessions.delete(uploadId);

  fs.rm(session.dir, { recursive: true, force: true }, (err) => {
    if (err) console.warn(`[ChunkedUpload] No se pudo limpiar dir ${session.dir}:`, err.message);
    else console.log(`[ChunkedUpload] Sesión ${uploadId} limpiada.`);
  });
}

module.exports = { initUpload, uploadChunk, completeUpload };
