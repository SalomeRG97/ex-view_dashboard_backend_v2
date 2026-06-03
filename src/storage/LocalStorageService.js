const fs = require('fs');
const path = require('path');
const StorageService = require('./StorageService');

// Directorio raíz donde se almacenarán todos los archivos localmente
const STORAGE_ROOT = path.join(__dirname, '..', '..', 'storage');

class LocalStorageService extends StorageService {
  /**
   * Guarda un Buffer en disco bajo storage/<destPath>
   * @param {Buffer} buffer 
   * @param {string} destPath - ej: 'reports/abc.pdf' o 'processed/abc/page-1.png'
   * @returns {Promise<string>} ruta relativa guardada
   */
  async save(buffer, destPath) {
    const fullPath = path.join(STORAGE_ROOT, destPath);
    const dir = path.dirname(fullPath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    await fs.promises.writeFile(fullPath, buffer);
    return destPath; // ruta relativa → lo que se guarda en DB
  }

  /**
   * Elimina un archivo del disco
   * @param {string} filePath - ruta relativa guardada en DB
   */
  async delete(filePath) {
    const fullPath = path.join(STORAGE_ROOT, filePath);
    if (fs.existsSync(fullPath)) {
      await fs.promises.unlink(fullPath);
    }
  }

  /**
   * Devuelve la ruta absoluta del archivo en el servidor.
   * En producción con S3, esto retornaría la URL pública.
   * @param {string} filePath - ruta relativa
   * @returns {string} ruta absoluta en disco
   */
  getPublicUrl(filePath) {
    return path.join(STORAGE_ROOT, filePath);
  }

  /**
   * Descarga el archivo de disco y lo retorna como Buffer.
   * @param {string} filePath - ruta relativa
   * @returns {Promise<Buffer>}
   */
  async download(filePath) {
    const fullPath = path.join(STORAGE_ROOT, filePath);
    return await fs.promises.readFile(fullPath);
  }

  /**
   * Obtiene un stream de lectura para el archivo local.
   * @param {string} filePath - ruta relativa
   * @returns {Promise<import('fs').ReadStream>}
   */
  async getReadableStream(filePath) {
    const fullPath = path.join(STORAGE_ROOT, filePath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Archivo no encontrado: ${filePath}`);
    }
    return fs.createReadStream(fullPath);
  }

  /**
   * Verifica si el archivo existe en disco.
   * @param {string} filePath - ruta relativa
   * @returns {Promise<boolean>}
   */
  async exists(filePath) {
    const fullPath = path.join(STORAGE_ROOT, filePath);
    return fs.existsSync(fullPath);
  }

  /**
   * Elimina un directorio recursivamente.
   * @param {string} dirPath - ruta relativa
   */
  async deleteDirectory(dirPath) {
    const fullPath = path.join(STORAGE_ROOT, dirPath);
    if (fs.existsSync(fullPath)) {
      fs.rmSync(fullPath, { recursive: true, force: true });
    }
  }

  /**
   * Devuelve la ruta base de storage.
   */
  getStorageRoot() {
    return STORAGE_ROOT;
  }

  /**
   * Upload masivo desde archivos locales temporales.
   * Para el storage local simplemente copia los archivos al directorio de storage.
   * @param {Array<{localPath: string, remotePath: string}>} items
   */
  async batchUpload(items, _concurrency = 2) {
    if (!items || items.length === 0) return;
    const start = Date.now();
    console.log(`[LocalStorage Batch] 📂 Copiando ${items.length} archivos al storage local...`);

    for (const { localPath, remotePath } of items) {
      const destPath = path.join(STORAGE_ROOT, remotePath);
      await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
      await fs.promises.copyFile(localPath, destPath);
    }

    console.log(`[LocalStorage Batch] ✅ ${items.length} archivos copiados en ${Date.now() - start}ms`);
  }
}

module.exports = new LocalStorageService();
