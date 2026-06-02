const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const url = require('url');

class PDFGeneratorService {
  /**
   * Genera un PDF a partir de un HTML string usando Puppeteer.
   * @param {string} html - HTML completo del informe
   * @returns {Promise<Buffer>} Buffer del PDF generado
   */
  async generate(html) {
    let browser;
    let tempFilePath;
    try {
      const tempDir = os.tmpdir();
      const tempFileName = `temp-report-${Date.now()}-${Math.random().toString(36).substring(7)}.html`;
      tempFilePath = path.join(tempDir, tempFileName);

      fs.writeFileSync(tempFilePath, html, 'utf8');

      const launchOptions = {
        headless: 'new',
        protocolTimeout: 300000, // 5 minutos para evitar timeouts de protocolo en PDFs grandes
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-features=FirstPartySets',
          '--disable-gpu',
          '--allow-file-access-from-files',
          '--disable-web-security',
        ],
      };

      if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
      }

      browser = await puppeteer.launch(launchOptions);

      const page = await browser.newPage();

      // Aumentar los timeouts por defecto para PDFs grandes de muchas páginas
      page.setDefaultTimeout(180000);
      page.setDefaultNavigationTimeout(180000);

      // Cargar el HTML usando file:/// URL para evitar sobrepasar límites de memoria con imágenes en base64
      await page.goto(url.pathToFileURL(tempFilePath).href, {
        waitUntil: 'load',
        timeout: 90000, // 90 segundos para PDFs grandes
      });

      // Esperar que todas las imágenes y fuentes terminen de cargar de forma asíncrona
      await page.evaluate(async () => {
        // 1. Esperar imágenes
        await Promise.all(
          Array.from(document.images)
            .filter(img => !img.complete)
            .map(img => new Promise(resolve => {
              img.onload = resolve;
              img.onerror = resolve;
            }))
        );
        // 2. Esperar fuentes
        await document.fonts.ready;
        // 3. Breve delay de cortesía para renderizado/rasterización final
        await new Promise(resolve => setTimeout(resolve, 100));
      });

      const pdfBuffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: 0, right: 0, bottom: 0, left: 0 },
        preferCSSPageSize: true,
      });

      return Buffer.from(pdfBuffer);
    } finally {
      if (tempFilePath && fs.existsSync(tempFilePath)) {
        try {
          fs.unlinkSync(tempFilePath);
        } catch (err) {
          console.warn('Warning: Error deleting temporary HTML file:', err.message);
        }
      }
      if (browser) {
        try {
          await browser.close();
        } catch (closeError) {
          console.warn('Warning: Error closing puppeteer browser:', closeError.message);
        }
      }
    }
  }
}

module.exports = new PDFGeneratorService();
