// Global error handling middleware
// Captura errores de Multer y otros errores de la aplicación
// Devuelve JSON estructurado con código de estado apropiado

module.exports = (err, req, res, next) => {
  // Si el error es de Multer (por ejemplo, límite de tamaño excedido)
  const multer = require('multer');
  if (err instanceof multer.MulterError) {
    // MulterError tiene códigos como LIMIT_FILE_SIZE
    return res.status(400).json({ error: err.message });
  }

  // Otros errores pueden ser de validación u otros problemas internos
  const status = err.status || 500;
  const message = err.message || 'Error interno del servidor';
  res.status(status).json({ error: message });
};
