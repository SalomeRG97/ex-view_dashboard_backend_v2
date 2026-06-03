const Handlebars = require('handlebars');
const fs = require('fs');
const path = require('path');

// Template HTML para el informe filtrado (si existiera en disk)
const TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'report.hbs');

class HTMLBuilderService {
  /**
   * Construye el HTML completo del informe filtrado.
   * @param {object} options
   * @param {string} options.dashboardName - Nombre del dashboard
   * @param {string} options.clientName    - Nombre del cliente
   * @param {string} options.coverPageSrc  - Ruta file:/// de la portada original renderizada
   * @param {string} options.tocHtml       - HTML de la tabla de contenidos recalculada
   * @param {Array}  options.pages         - Páginas de contenido con src, pageNum, label
   * @param {number} options.totalPages    - Total de páginas del PDF generado
   * @param {string} options.generatedAt   - Fecha de generación
   * @returns {string} HTML string listo para Puppeteer
   */
  build({ dashboardName, clientName, coverPageSrc, tocHtml, pages, totalPages, generatedAt, logoUrl }) {
    const templateSrc = this._getTemplate();
    const template = Handlebars.compile(templateSrc);

    return template({
      dashboardName,
      clientName,
      generatedAt,
      coverPageSrc,
      tocHtml,
      pages,
      totalPages,
      logoUrl,
    });
  }

  _getTemplate() {
    // Si el archivo de template existe, usarlo; si no, usar el inline
    if (fs.existsSync(TEMPLATE_PATH)) {
      return fs.readFileSync(TEMPLATE_PATH, 'utf8');
    }
    return this._inlineTemplate();
  }

  _inlineTemplate() {
    return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"/>
  <style>
    ${this._getStyles()}
  </style>
</head>
<body>

  <!-- PORTADA ORIGINAL -->
  <div class="cover-page-original">
    <img src="{{coverPageSrc}}" alt="Portada Original" />
  </div>

  <!-- TABLA DE CONTENIDOS -->
  <div class="toc-page">
    <div class="page-header-box">
      <div class="header-logo-container">
        <img src="{{logoUrl}}" alt="EX-VIEW SOLAR" />
      </div>
      <div class="header-text-container">
        INFORME DE INSPECCIÓN RGB/IR - {{dashboardName}}
      </div>
    </div>

    <div class="toc-title">TABLA DE CONTENIDO</div>

    <div class="toc-content">
      {{{tocHtml}}}
    </div>

    <div class="page-footer">
      <span>2</span>
    </div>
  </div>

  <!-- PÁGINAS DE CONTENIDO -->
  {{#each pages}}
  <div class="content-page">
    <img src="{{this.src}}" alt="Página {{this.pageNum}}" />
    <div class="page-footer">
      <span>{{this.pageNum}}</span>
    </div>
  </div>
  {{/each}}

</body>
</html>`;
  }

  buildIntroChunk({ coverPageSrc, tocHtml, dashboardName, logoUrl }) {
    const templateStr = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"/>
  <style>
    ${this._getStyles()}
  </style>
</head>
<body>
  <!-- PORTADA ORIGINAL -->
  <div class="cover-page-original">
    <img src="{{coverPageSrc}}" alt="Portada Original" />
  </div>

  <!-- TABLA DE CONTENIDOS -->
  <div class="toc-page">
    <div class="page-header-box">
      <div class="header-logo-container">
        <img src="{{logoUrl}}" alt="EX-VIEW SOLAR" />
      </div>
      <div class="header-text-container">
        INFORME DE INSPECCIÓN RGB/IR - {{dashboardName}}
      </div>
    </div>

    <div class="toc-title">TABLA DE CONTENIDO</div>

    <div class="toc-content">
      {{{tocHtml}}}
    </div>

    <div class="page-footer">
      <span>2</span>
    </div>
  </div>
</body>
</html>`;
    const template = Handlebars.compile(templateStr);
    return template({ coverPageSrc, tocHtml, dashboardName, logoUrl });
  }

  buildContentChunk({ pages }) {
    const templateStr = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"/>
  <style>
    ${this._getStyles()}
  </style>
</head>
<body>
  <!-- PÁGINAS DE CONTENIDO -->
  {{#each pages}}
  <div class="content-page">
    <img src="{{this.src}}" alt="Página {{this.pageNum}}" />
    <div class="page-footer">
      <span>{{this.pageNum}}</span>
    </div>
  </div>
  {{/each}}
</body>
</html>`;
    const template = Handlebars.compile(templateStr);
    return template({ pages });
  }

  _getStyles() {
    return `* { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Times New Roman', Times, serif; background: #fff; }

    /* ── Portada Original ── */
    .cover-page-original {
      width: 210mm; height: 297mm;
      page-break-after: always;
      display: flex;
      justify-content: center;
      align-items: center;
      background: #fff;
    }
    .cover-page-original img {
      width: 100%; height: 100%;
      object-fit: contain;
    }

    /* ── TOC ── */
    .toc-page {
      width: 210mm; height: 297mm;
      padding: 20mm 20mm 25mm 20mm;
      page-break-after: always;
      position: relative;
      background: #fff;
    }
    
    /* ── Cabecera de Página (Borde Negro, Logo y Título) ── */
    .page-header-box {
      width: 100%;
      height: 20mm;
      border: 1.5px solid #000;
      display: flex;
      margin-bottom: 15mm;
    }
    .header-logo-container {
      width: 35mm;
      height: 100%;
      border-right: 1.5px solid #000;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 2mm;
    }
    .header-logo-container img {
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
    }
    .header-text-container {
      flex: 1;
      height: 100%;
      display: flex;
      justify-content: center;
      align-items: center;
      text-align: center;
      font-size: 10pt;
      font-weight: bold;
      color: #000;
      font-family: 'Times New Roman', Times, serif;
      padding: 0 4mm;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .toc-title {
      font-size: 14pt;
      font-weight: bold;
      color: #000;
      text-align: center;
      margin-bottom: 12mm;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .toc-content {
      width: 100%;
    }

    .toc-container {
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .toc-row {
      width: 100%;
      display: flex;
      align-items: flex-end;
    }

    .toc-row.main-row {
      margin-top: 8px;
    }

    .toc-row.sub-row {
      padding-left: 20px;
    }

    .toc-label {
      color: #000;
      text-transform: uppercase;
      white-space: nowrap;
      padding-right: 6px;
      font-family: 'Times New Roman', Times, serif;
    }

    .toc-label.main-label {
      font-size: 11pt;
      font-weight: normal;
    }

    .toc-label.sub-label {
      font-size: 9.5pt;
      font-weight: normal;
    }

    .toc-dots {
      flex: 1;
      border-bottom: 1.5px dotted #000;
      margin-bottom: 4px;
    }

    .toc-page-num {
      color: #000;
      white-space: nowrap;
      padding-left: 6px;
      text-align: right;
      font-family: 'Times New Roman', Times, serif;
    }

    .toc-page-num.main-page {
      font-size: 11pt;
      font-weight: normal;
    }

    .toc-page-num.sub-page {
      font-size: 9.5pt;
      font-weight: normal;
    }

    /* ── Páginas de contenido ── */
    .content-page {
      width: 210mm;
      height: 297mm;
      page-break-after: always;
      position: relative;
      background: #fff;
    }
    .content-page img {
      max-width: 100%;
      max-height: calc(100% - 22mm);
      object-fit: contain;
      display: block;
      margin: 0 auto;
    }

    /* ── Footer dinámico ── */
    .page-footer {
      position: absolute;
      bottom: 12mm;
      right: 20mm;
      background: #fff;
      color: #000;
      font-size: 10pt;
      font-family: 'Times New Roman', Times, serif;
      padding: 2px 4px;
      display: flex;
      justify-content: flex-end;
      align-items: center;
      min-width: 15px;
      height: 20px;
    }

    @media print {
      @page { margin: 0; size: A4; }
      .content-page { page-break-after: always; height: 297mm; }
      .cover-page-original { page-break-after: always; }
      .toc-page { page-break-after: always; }
    }`;
  }
}

module.exports = new HTMLBuilderService();
