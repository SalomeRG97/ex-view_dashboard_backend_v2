/**
 * StorageService — Interfaz abstracta de almacenamiento.
 * Preparada para futura migración a S3 u otro proveedor.
 * Implementar todos los métodos en cada proveedor concreto.
 */
class StorageService {
  /**
   * Guardar archivo en el storage.
   * @param {Buffer} buffer - Contenido del archivo
   * @param {string} destPath - Ruta destino relativa (ej: 'reports/abc.pdf')
   * @returns {Promise<string>} - Ruta pública o URL del archivo guardado
   */
  async save(buffer, destPath) {
    throw new Error('StorageService.save() debe ser implementado');
  }

  /**
   * Eliminar un archivo del storage.
   * @param {string} filePath - Ruta del archivo a eliminar
   */
  async delete(filePath) {
    throw new Error('StorageService.delete() debe ser implementado');
  }

  /**
   * Obtener la ruta absoluta o URL pública del archivo.
   * @param {string} filePath - Ruta relativa guardada en DB
   * @returns {string}
   */
  getPublicUrl(filePath) {
    throw new Error('StorageService.getPublicUrl() debe ser implementado');
  }

  /**
   * Descargar archivo y retornar buffer.
   * @param {string} filePath
   * @returns {Promise<Buffer>}
   */
  async download(filePath) {
    throw new Error('StorageService.download() debe ser implementado');
  }

  /**
   * Obtener un stream de lectura para el archivo.
   * @param {string} filePath
   * @returns {Promise<import('stream').Readable>}
   */
  async getReadableStream(filePath) {
    throw new Error('StorageService.getReadableStream() debe ser implementado');
  }

  /**
   * Verificar existencia de archivo.
   * @param {string} filePath
   * @returns {Promise<boolean>}
   */
  async exists(filePath) {
    throw new Error('StorageService.exists() debe ser implementado');
  }

  /**
   * Eliminar directorio de forma recursiva.
   * @param {string} dirPath
   */
  async deleteDirectory(dirPath) {
    throw new Error('StorageService.deleteDirectory() debe ser implementado');
  }

  /**
   * Upload masivo desde archivos locales temporales.
   * Más eficiente que llamar save() por cada archivo individualmente.
   *
   * @param {Array<{localPath: string, remotePath: string}>} items
   *   - localPath  : ruta absoluta al archivo temporal en disco local
   *   - remotePath : ruta relativa de destino en el storage
   * @param {number} concurrency - conexiones/workers paralelos (default 2)
   */
  async batchUpload(items, concurrency = 2) {
    throw new Error('StorageService.batchUpload() debe ser implementado');
  }
}

module.exports = StorageService;
