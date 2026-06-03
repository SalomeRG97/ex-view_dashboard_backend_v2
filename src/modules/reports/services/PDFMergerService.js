const fs = require('fs');
const path = require('path');
const os = require('os');
const { PDFDocument } = require('pdf-lib');

class PDFMergerService {
  /**
   * Une múltiples archivos PDF locales en un único archivo PDF.
   * Elimina los archivos chunk de origen al finalizar para liberar espacio.
   * @param {string[]} chunkPaths - Lista de rutas absolutas de los PDFs chunks
   * @returns {Promise<string>} - Ruta absoluta al PDF combinado final
   */
  async merge(chunkPaths) {
    if (!chunkPaths || chunkPaths.length === 0) {
      throw new Error('No se especificaron PDFs para unir.');
    }

    // Si solo hay un chunk, no es necesario hacer merge
    if (chunkPaths.length === 1) {
      return chunkPaths[0];
    }

    console.log(`[PDFMergerService] Iniciando unión de ${chunkPaths.length} archivos PDF...`);
    const mergedPdf = await PDFDocument.create();

    for (const chunkPath of chunkPaths) {
      if (!fs.existsSync(chunkPath)) {
        console.warn(`[PDFMergerService] Advertencia: El chunk no existe en la ruta: ${chunkPath}`);
        continue;
      }

      try {
        const chunkBuffer = fs.readFileSync(chunkPath);
        const chunkDoc = await PDFDocument.load(chunkBuffer);
        const copiedPages = await mergedPdf.copyPages(chunkDoc, chunkDoc.getPageIndices());
        copiedPages.forEach((page) => mergedPdf.addPage(page));
      } catch (err) {
        console.error(`[PDFMergerService] Error al cargar o copiar el chunk ${chunkPath}:`, err.message);
        throw err;
      }
    }

    const mergedPdfBytes = await mergedPdf.save();
    
    // Crear archivo temporal de destino
    const tempDir = os.tmpdir();
    const finalPdfPath = path.join(tempDir, `merged-report-${Date.now()}-${Math.random().toString(36).substring(7)}.pdf`);
    
    fs.writeFileSync(finalPdfPath, mergedPdfBytes);
    console.log(`[PDFMergerService] Unión de PDF completada con éxito. Archivo final guardado en: ${finalPdfPath}`);

    // Eliminar los chunks de origen para liberar espacio en disco inmediatamente
    for (const chunkPath of chunkPaths) {
      try {
        if (fs.existsSync(chunkPath)) {
          fs.unlinkSync(chunkPath);
        }
      } catch (unlinkErr) {
        console.warn(`[PDFMergerService] No se pudo eliminar el chunk temporal ${chunkPath}:`, unlinkErr.message);
      }
    }

    return finalPdfPath;
  }
}

module.exports = new PDFMergerService();
