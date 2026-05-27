const multer = require('multer');

// ── Multer con almacenamiento en memoria (Buffer) ──────────────
// Usamos memoryStorage para luego pasar el buffer a nuestro StorageService
// abstracto. Así la migración a S3 no requiere cambiar nada en multer.
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  if (file.mimetype === 'application/pdf') {
    cb(null, true);
  } else {
    cb(new Error('Solo se permiten archivos PDF'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 150 * 1024 * 1024, // 150 MB máximo
  },
});

module.exports = upload;
