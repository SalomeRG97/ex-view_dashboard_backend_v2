const pdfParser = require('./src/modules/reports/services/PDFParserService');
const fs = require('fs');
const path = require('path');

async function main() {
  try {
    const pdfPath = path.join(__dirname, 'test_id_output.pdf');
    if (!fs.existsSync(pdfPath)) {
      console.error('❌ test_id_output.pdf no existe.');
      return;
    }

    console.log('--- VERIFICANDO PDF GENERADO ---');
    const buffer = fs.readFileSync(pdfPath);
    const { text, numPages, pages } = await pdfParser.parse(buffer);

    console.log(`Total de páginas en el PDF generado: ${numPages}`);

    // Extraemos la tabla de contenido del PDF generado
    const tocEntries = pdfParser.parseTOCEntries(pages, numPages);
    console.log('\nTabla de contenidos en el nuevo PDF:');
    if (tocEntries.length > 0) {
      tocEntries.forEach(entry => {
        console.log(`- ${entry.isSub ? '  ' : ''}${entry.title} -> Pág. ${entry.originalPageNum}`);
      });
    } else {
      console.log('⚠️ No se detectó una tabla de contenido estándar en el texto (o no se pudo parsear directamente).');
    }

    // Buscaremos si algún texto perteneciente a la sección excluida (Pág 128-172) existe
    // Por ejemplo, la sección excluida se llama "SOILING"
    console.log('\nVerificando si la sección de "SOILING" fue completamente excluida:');
    const lowerText = text.toLowerCase();
    
    // Contar ocurrencias de palabras clave en páginas individuales
    let soilingPagesCount = 0;
    pages.forEach((p, idx) => {
      if (p.text && p.text.toLowerCase().includes('soiling') && !p.text.toLowerCase().includes('tabla de contenido')) {
        soilingPagesCount++;
        // console.log(`  - Coincidencia de 'soiling' en página nueva ${idx + 1}`);
      }
    });

    console.log(`Páginas nuevas que mencionan 'soiling' (excluyendo TOC): ${soilingPagesCount}`);
    console.log('¡Prueba finalizada con éxito!');

  } catch (error) {
    console.error('❌ Error verificando PDF:', error);
  }
}

main();
