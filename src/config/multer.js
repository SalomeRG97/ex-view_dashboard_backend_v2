const multer = require('multer');
const os = require('os');

// ── Multer para upload completo (compatibilidad) ────
// diskStorage evita colapsar la RAM con PDFs de gran tamaño.
const pdfStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, os.tmpdir());
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + '.pdf');
  }
});

const pdfFilter = (req, file, cb) => {
  if (file.mimetype === 'application/pdf') {
    cb(null, true);
  } else {
    cb(new Error('Solo se permiten archivos PDF'), false);
  }
};

// Upload directo (legacy, mantiene compatibilidad)
const upload = multer({
  storage: pdfStorage,
  fileFilter: pdfFilter,
  limits: {
    fileSize: 2 * 1024 * 1024 * 1024, // 2 GB
  },
});

// ── Multer para chunks individuales ─────────────────
// Cada chunk es binario (application/octet-stream), máximo 15 MB.
const chunkStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, os.tmpdir());
  },
  filename: function (req, file, cb) {
    const { uploadId, chunkIndex } = req.params;
    cb(null, `chunk-${uploadId}-${chunkIndex}.bin`);
  }
});

const chunkUpload = multer({
  storage: chunkStorage,
  limits: {
    fileSize: 15 * 1024 * 1024, // 15 MB por chunk
  },
});

module.exports = upload;
module.exports.chunkUpload = chunkUpload;

