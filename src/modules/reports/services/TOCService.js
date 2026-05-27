/**
 * TOCService — Genera la tabla de contenidos dinámica para el informe filtrado.
 */
class TOCService {
  /**
   * Renderiza la TOC como HTML para ser usado en el template de Handlebars.
   * @param {Array<{label, page, isSub}>} tocEntries
   * @returns {string} HTML string
   */
  renderTOCHtml(tocEntries) {
    const rows = tocEntries
      .map(
        entry => {
          const rowClass = entry.isSub ? 'toc-row sub-row' : 'toc-row main-row';
          const labelClass = entry.isSub ? 'toc-label sub-label' : 'toc-label main-label';
          const pageClass = entry.isSub ? 'toc-page-num sub-page' : 'toc-page-num main-page';
          return `
          <div class="${rowClass}">
            <span class="${labelClass}">${entry.label}</span>
            <span class="toc-dots"></span>
            <span class="${pageClass}">${entry.page}</span>
          </div>`;
        }
      )
      .join('');

    return `
      <div class="toc-container">
        ${rows}
      </div>
    `;
  }
}

module.exports = new TOCService();
