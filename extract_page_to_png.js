const pageRender = require('./src/modules/reports/services/PageRenderService');
const fs = require('fs');
const path = require('path');

async function main() {
  try {
    const pdfPath = path.join(__dirname, 'test_id_output.pdf');
    if (!fs.existsSync(pdfPath)) {
      console.error('❌ test_id_output.pdf no existe.');
      return;
    }

    const buffer = fs.readFileSync(pdfPath);
    console.log('Renderizando la página 2 (Tabla de Contenido)...');
    
    const results = await pageRender.renderPages(buffer, [2]);
    if (results.length === 0) {
      console.error('❌ No se pudo renderizar la página.');
      return;
    }

    const outputDir = 'C:\\Users\\salom\\.gemini\\antigravity-ide\\brain\\7baa33ec-9d94-4912-a16f-45edd1b85434';
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const outputPath = path.join(outputDir, 'toc_page_rendered.png');
    fs.writeFileSync(outputPath, results[0].buffer);
    console.log(`✅ Página 2 guardada como imagen en: ${outputPath}`);

  } catch (error) {
    console.error('❌ Error renderizando página a imagen:', error);
  }
}

main();
