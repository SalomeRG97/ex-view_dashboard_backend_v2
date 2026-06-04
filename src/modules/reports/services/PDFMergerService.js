const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { PDFDocument } = require('pdf-lib');

class PDFMergerService {
  /**
   * Une múltiples archivos PDF locales en un único archivo PDF de forma
   * **incremental** (un chunk a la vez) para no saturar la RAM en VPS de 512 MB.
   * Elimina los archivos chunk de origen al finalizar para liberar espacio en disco.
   *
   * @param {string[]} chunkPaths - Rutas absolutas de los PDFs chunk (en orden)
   * @returns {Promise<string>}   - Ruta absoluta al PDF combinado final
   */
  async merge(chunkPaths) {
    if (!chunkPaths || chunkPaths.length === 0) {
      throw new Error('No se especificaron PDFs para unir.');
    }

    // Si solo hay un chunk, renombrar/mover y devolver directamente
    if (chunkPaths.length === 1) {
      return chunkPaths[0];
    }

    console.log(`[PDFMergerService] Iniciando unión incremental de ${chunkPaths.length} chunks...`);

    const mergedPdf = await PDFDocument.create();

    for (let i = 0; i < chunkPaths.length; i++) {
      const chunkPath = chunkPaths[i];

      if (!fs.existsSync(chunkPath)) {
        console.warn(`[PDFMergerService] ⚠️ Chunk no encontrado, omitido: ${chunkPath}`);
        continue;
      }

      let chunkBuffer = null;
      try {
        // Cargar UN chunk a la vez en memoria
        chunkBuffer = fs.readFileSync(chunkPath);
        const chunkDoc  = await PDFDocument.load(chunkBuffer);
        const pages     = await mergedPdf.copyPages(chunkDoc, chunkDoc.getPageIndices());
        pages.forEach(p => mergedPdf.addPage(p));

        const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
        console.log(`[PDFMergerService] Chunk ${i + 1}/${chunkPaths.length} copiado. RSS: ${memMB}MB`);
      } catch (err) {
        console.error(`[PDFMergerService] ❌ Error al copiar chunk ${chunkPath}:`, err.message);
        throw err;
      } finally {
        // Liberar el buffer del chunk inmediatamente, antes de cargar el siguiente
        chunkBuffer = null;
        if (global.gc) global.gc();
      }
    }

    // Serializar el PDF final
    const mergedPdfBytes = await mergedPdf.save();

    const tempDir      = os.tmpdir();
    const finalPdfPath = path.join(tempDir, `merged-report-${Date.now()}-${Math.random().toString(36).substring(7)}.pdf`);

    fs.writeFileSync(finalPdfPath, mergedPdfBytes);

    const sizeMB = (fs.statSync(finalPdfPath).size / 1024 / 1024).toFixed(2);
    console.log(`[PDFMergerService] ✅ PDF final generado: ${finalPdfPath} (${sizeMB} MB)`);

    // Liberar bytes del PDF en memoria
    // eslint-disable-next-line no-unused-vars
    let _bytes = mergedPdfBytes; _bytes = null;
    if (global.gc) global.gc();

    // Eliminar los chunks de origen para liberar espacio en disco
    for (const chunkPath of chunkPaths) {
      try {
        if (fs.existsSync(chunkPath)) {
          fs.unlinkSync(chunkPath);
        }
      } catch (unlinkErr) {
        console.warn(`[PDFMergerService] No se pudo eliminar chunk temporal ${chunkPath}:`, unlinkErr.message);
      }
    }

    return finalPdfPath;
  }
}

module.exports = new PDFMergerService();
