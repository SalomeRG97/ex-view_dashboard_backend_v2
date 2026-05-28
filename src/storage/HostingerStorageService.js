'use strict';

const ftp            = require('basic-ftp');
const StorageService = require('./StorageService');
const path           = require('path');
const fs             = require('fs');
const { Readable, Writable } = require('stream');

// ─────────────────────────────────────────────────────────────
//  Configuración de reintentos y timeouts FTP
// ─────────────────────────────────────────────────────────────
const MAX_RETRIES      = 3;          // Intentos por operación antes de lanzar error
const RETRY_BASE_MS    = 1_500;      // Backoff base (se multiplica: 1.5s, 3s, 6s)

/**
 * Espera exponencial antes de cada reintento.
 */
const wait = (ms) => new Promise(res => setTimeout(res, ms));

// ─────────────────────────────────────────────────────────────
class HostingerStorageService extends StorageService {

  constructor() {
    super();
    this.ftpConfig = {
      host:     process.env.FTP_HOST,
      user:     process.env.FTP_USER,
      password: process.env.FTP_PASSWORD,
      port:     parseInt(process.env.FTP_PORT || '21', 10),
      secure:   process.env.FTP_SECURE === 'true',
    };
    this.basePath  = process.env.FTP_BASE_PATH    || '/public_html/storage';
    this.publicUrl = process.env.STORAGE_PUBLIC_URL || 'https://ex-view.com/storage';
  }

  // ─────────────────────────────────────────────────────────
  //  Fábrica de cliente FTP con timeouts explícitos
  // ─────────────────────────────────────────────────────────

  /**
   * Crea y conecta un cliente FTP con keepAlive TCP activado.
   * IMPORTANTE: el keepAlive debe configurarse DESPUÉS de client.access(),
   * porque es entonces cuando el socket real de control queda establecido.
   * @returns {Promise<ftp.Client>}
   */
  async _connect() {
    // 300 000 ms = 5 minutos: tiempo máximo de inactividad del control socket.
    // Debe ser mayor que el tiempo de subida del PDF más grande esperado.
    const client = new ftp.Client(300_000);
    client.ftp.verbose = false; // cambiar a true solo para depuración

    // Conectar primero
    await client.access(this.ftpConfig);

    // Activar TCP keepAlive en el socket de control YA conectado.
    // Esto envía probes TCP cada 15 s para que el servidor no cierre
    // la conexión por inactividad durante una transferencia larga.
    const sock = client.ftp.socket;
    if (sock && typeof sock.setKeepAlive === 'function') {
      sock.setKeepAlive(true, 15_000);
    }

    return client;
  }

  /**
   * Ejecuta una operación FTP con reintentos automáticos y backoff exponencial.
   * Si la conexión muere a mitad de camino, reconecta y vuelve a intentar.
   *
   * @param {(client: ftp.Client) => Promise<T>} operation
   * @returns {Promise<T>}
   */
  async _withRetry(operation) {
    let lastError;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      let client;
      try {
        client = await this._connect();
        const result = await operation(client);
        return result;

      } catch (err) {
        lastError = err;
        const isFatal = err.message?.toLowerCase().includes('timeout') ||
                        err.message?.toLowerCase().includes('econnreset') ||
                        err.message?.toLowerCase().includes('econnrefused') ||
                        err.message?.toLowerCase().includes('epipe') ||
                        err.code === 'ECONNRESET' ||
                        err.code === 'EPIPE';

        if (attempt < MAX_RETRIES) {
          const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
          console.warn(
            `[FTP] ⚠️  Intento ${attempt}/${MAX_RETRIES} fallido` +
            `${isFatal ? ' (error de red)' : ''}: ${err.message}. ` +
            `Reintentando en ${delay}ms...`
          );
          await wait(delay);
        }

      } finally {
        if (client) {
          try { client.close(); } catch { /* ignorar */ }
        }
      }
    }

    console.error(`[FTP] ❌ Operación fallida tras ${MAX_RETRIES} intentos: ${lastError?.message}`);
    throw lastError;
  }

  // ─────────────────────────────────────────────────────────
  //  Helpers de ruta
  // ─────────────────────────────────────────────────────────

  _remotePath(relPath) {
    const normalized = relPath.replace(/\\/g, '/');
    return path.posix.join(this.basePath, normalized);
  }

  // ─────────────────────────────────────────────────────────
  //  API pública
  // ─────────────────────────────────────────────────────────

  /**
   * Sube un Buffer a Hostinger vía FTP con reintentos automáticos.
   * @param {Buffer} buffer
   * @param {string} destPath - ruta relativa (ej: 'reports/abc.pdf')
   * @returns {Promise<string>} ruta relativa guardada
   */
  async save(buffer, destPath) {
    const remoteFilePath = this._remotePath(destPath);
    const remoteDir      = path.posix.dirname(remoteFilePath);
    const filename       = path.posix.basename(remoteFilePath);

    await this._withRetry(async (client) => {
      await client.ensureDir(remoteDir);
      // Volver a navegar al directorio después de ensureDir
      await client.cd(remoteDir);
      const stream = Readable.from(buffer);
      await client.uploadFrom(stream, filename);
    });

    console.log(`[FTP] ✅ Archivo subido: ${destPath} (${Math.round(buffer.length / 1024)}KB)`);
    return destPath.replace(/\\/g, '/');
  }

  /**
   * Descarga un archivo de Hostinger como Buffer.
   * @param {string} filePath - ruta relativa
   * @returns {Promise<Buffer>}
   */
  async download(filePath) {
    const remoteFilePath = this._remotePath(filePath);

    return await this._withRetry(async (client) => {
      const chunks = [];
      const sink   = new Writable({
        write(chunk, _enc, cb) { chunks.push(chunk); cb(); },
      });
      await client.downloadTo(sink, remoteFilePath);
      return Buffer.concat(chunks);
    });
  }

  /**
   * Verifica si un archivo existe en Hostinger.
   * @param {string} filePath - ruta relativa
   * @returns {Promise<boolean>}
   */
  async exists(filePath) {
    const remoteFilePath = this._remotePath(filePath);
    const remoteDir      = path.posix.dirname(remoteFilePath);
    const filename       = path.posix.basename(remoteFilePath);

    try {
      return await this._withRetry(async (client) => {
        await client.cd(remoteDir);
        const list = await client.list();
        return list.some(item => item.name === filename);
      });
    } catch {
      return false;
    }
  }

  /**
   * Elimina un archivo de Hostinger.
   * @param {string} filePath - ruta relativa
   */
  async delete(filePath) {
    const remoteFilePath = this._remotePath(filePath);
    try {
      await this._withRetry(async (client) => {
        await client.remove(remoteFilePath);
      });
    } catch (err) {
      console.warn(`[FTP] delete ignorado para ${filePath}: ${err.message}`);
    }
  }

  /**
   * Elimina un directorio y todo su contenido de forma recursiva.
   * @param {string} dirPath - ruta relativa
   */
  async deleteDirectory(dirPath) {
    const remoteDirPath = this._remotePath(dirPath);
    try {
      await this._withRetry(async (client) => {
        await client.removeDir(remoteDirPath);
      });
    } catch (err) {
      console.warn(`[FTP] deleteDirectory ignorado para ${dirPath}: ${err.message}`);
    }
  }

  /**
   * Upload masivo desde archivos locales temporales.
   * Abre un pool de `concurrency` conexiones FTP. Cada conexión drena la cola
   * de forma secuencial sin reconectar entre archivos → máxima eficiencia.
   *
   * @param {Array<{localPath: string, remotePath: string}>} items
   * @param {number} concurrency - conexiones FTP paralelas (default 2)
   */
  async batchUpload(items, concurrency = 2) {
    if (!items || items.length === 0) return;

    const batchStart    = Date.now();
    const queue         = [...items];
    let   uploadedCount = 0;

    console.log(`[FTP Batch] 🚀 Iniciando batch: ${items.length} archivos | workers: ${concurrency}`);

    // ── Worker: UNA conexión FTP que drena la cola sin reconectar ─────────
    const worker = async (workerId) => {
      let client;
      try {
        client = await this._connect();
        console.log(`[FTP Batch][W${workerId}] ✅ Conexión FTP establecida`);

        while (true) {
          const item = queue.shift();
          if (!item) break;

          const { localPath, remotePath } = item;
          const remoteFilePath = this._remotePath(remotePath);
          const remoteDir      = path.posix.dirname(remoteFilePath);
          const filename       = path.posix.basename(remoteFilePath);
          const fileStart      = Date.now();

          // Crear directorio y posicionarse (la conexión recuerda el CWD)
          await client.ensureDir(remoteDir);
          await client.cd(remoteDir);

          // Subir directamente desde el archivo local (sin leer a memoria)
          await client.uploadFrom(localPath, filename);

          uploadedCount++;
          const stat    = fs.existsSync(localPath) ? fs.statSync(localPath) : null;
          const sizeKB  = stat ? Math.round(stat.size / 1024) : '?';
          console.log(
            `[FTP Batch][W${workerId}] 📤 ${remotePath} ` +
            `(${sizeKB}KB | ${Date.now() - fileStart}ms)`
          );
        }

      } catch (err) {
        console.error(`[FTP Batch][W${workerId}] ❌ Error fatal: ${err.message}`);
        // Reintentar los items restantes en cola con el worker de respaldo
        // (el otro worker seguirá vaciando la cola)
      } finally {
        if (client) {
          try { client.close(); } catch { /* ignorar */ }
          console.log(`[FTP Batch][W${workerId}] 🔒 Conexión FTP cerrada`);
        }
      }
    };

    // Lanzar workers en paralelo
    const workerCount = Math.min(concurrency, items.length);
    await Promise.all(
      Array.from({ length: workerCount }, (_, i) => worker(i))
    );

    const elapsed = Date.now() - batchStart;
    console.log(
      `[FTP Batch] ✅ Completado: ${uploadedCount}/${items.length} archivos ` +
      `en ${elapsed}ms` +
      (uploadedCount > 0 ? ` (~${Math.round(elapsed / uploadedCount)}ms/archivo)` : '')
    );
  }

  /**
   * Retorna la URL pública del archivo.
   * @param {string} filePath - ruta relativa
   * @returns {string}
   */
  getPublicUrl(filePath) {
    const normalized = filePath.replace(/\\/g, '/');
    // encodeURI codificará espacios y caracteres especiales pero preservará los '/'
    return `${this.publicUrl}/${encodeURI(normalized)}`;
  }
}

module.exports = new HostingerStorageService();
