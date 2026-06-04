const { PDFParse } = require('pdf-parse');

// Tipos de anomalías reconocidos (expandible)
const ANOMALY_TYPES = [
  { type: 'hotspot_critical',     label: 'PC Crítico',          keywords: ['pc crítico', 'pc critico', 'crítico', 'critico', 'hotspot critical', 'punto caliente crítico', 'punto caliente critico'] },
  { type: 'dba',                  label: 'DBA',                 keywords: ['dba'] },
  { type: 'hotspot_mild',         label: 'PC Leve',             keywords: ['pc leve', 'leve', 'hotspot mild', 'punto caliente leve'] },
  { type: 'shading',              label: 'Sombras',             keywords: ['sombreado', 'shading'] },
  { type: 'shadow',               label: 'Sombras',             keywords: ['shadow', 'sombra', 'sombras'] },
  { type: 'hotspot_permissible',  label: 'PC Permisible',       keywords: ['pc permisible', 'permisible', 'hotspot permissible', 'punto caliente permisible'] },
  { type: 'dirt',                 label: 'Suciedad',            keywords: ['suciedad', 'dirt', 'polvo'] },
  { type: 'vegetation',           label: 'Vegetación',          keywords: ['vegetación', 'vegetacion', 'vegetation', 'planta', 'maleza'] },
  { type: 'soiling',              label: 'Soiling',             keywords: ['soiling'] },
  { type: 'pid',                  label: 'PID',                 keywords: ['pid', 'potential induced degradation'] },
  { type: 'diode_failure',        label: 'Falla en diodo',      keywords: ['diode failure', 'falla en diodo', 'diodo bypass', 'diodo by-pass', 'bypass diode', 'falla de diodo', 'bypass_diode', 'falla en diodo bypass', 'falla de diodo bypass'] },
  { type: 'string_failure',       label: 'String desconectado', keywords: ['string failure', 'falla de string', 'string desconectado', 'string_failure', 'desconectado', 'string'] },
  { type: 'other',                label: 'Otros',               keywords: ['otros', 'other'] },
  { type: 'broken_glass_hotspot', label: 'Daño físico',         keywords: ['broken glass', 'daño físico', 'dano fisico', 'broken_glass_hotspot', 'daño fisico', 'daño fisico por hotspot', 'vidrio roto', 'daño físico'] },
  { type: 'reverse_polarity',     label: 'Polaridad inversa',   keywords: ['reverse polarity', 'polaridad inversa'] },
];

class PDFParserService {
  /**
   * Extrae texto y metadata básica del PDF.
   * @param {Buffer|string} input - Buffer del PDF o ruta al archivo
   * @returns {Promise<{text: string, numPages: number, info: object, pages: Array}>}
   */
  async parse(input) {
    if (typeof input === 'string') {
      // Uso de script en Python para extracción sin saturar la RAM de Node
      const { spawn } = require('child_process');
      const path = require('path');
      
      return new Promise((resolve, reject) => {
        const scriptPath = path.join(__dirname, '../../../../../pdf_pipeline/extract_text.py');
        const python = spawn('python3', [scriptPath, input]);
        
        let outputData = '';
        let errorData = '';
        
        python.stdout.on('data', (data) => {
          outputData += data.toString();
        });
        
        python.stderr.on('data', (data) => {
          errorData += data.toString();
        });
        
        python.on('close', (code) => {
          if (code !== 0) {
            return reject(new Error(`Python script failed with code ${code}: ${errorData}`));
          }
          
          try {
            const result = JSON.parse(outputData);
            if (result.error) {
              return reject(new Error(`Python script error: ${result.error}`));
            }
            resolve({
              text: result.text || '',
              numPages: result.numPages || 0,
              info: {},
              pages: result.pages || []
            });
          } catch (e) {
            reject(new Error(`Failed to parse Python output: ${e.message}`));
          }
        });
      });
    }

    // pdf-parse v2 requiere Uint8Array en lugar de Buffer de Node
    const uint8 = new Uint8Array(input);
    const parser = new PDFParse(uint8);
    await parser.load();
    
    const textObj = await parser.getText();
    const info = await parser.getInfo();
    
    const text = textObj?.text || '';
    const numPages = info?.total || textObj?.total || 0;
    
    return {
      text,
      numPages,
      info: info?.info || {},
      pages: textObj?.pages || [],
    };
  }

  /**
   * Detecta las anomalías presentes en el texto del PDF.
   * @param {string} text - Texto extraído del PDF
   * @returns {Array<{type, label, foundAt}>}
   */
  detectAnomalies(text) {
    const lower = text.toLowerCase();
    const found = [];

    for (const anomaly of ANOMALY_TYPES) {
      const match = anomaly.keywords.some(k => lower.includes(k));
      if (match) {
        found.push({ type: anomaly.type, label: anomaly.label });
      }
    }

    return found;
  }

  /**
   * Extrae todas las entradas de la Tabla de Contenido del PDF.
   * @param {Array} pages - Páginas del PDF obtenidas del parser
   * @param {number} numPages - Número total de páginas
   * @returns {Array<{title, originalPageNum, isSub}>}
   */
  parseTOCEntries(pages, numPages) {
    if (!pages || !Array.isArray(pages) || pages.length === 0) {
      return [];
    }

    // Buscar la página de la Tabla de Contenido (usualmente en la hoja 2)
    const tocPage = pages.slice(0, 5).find(p => p.text && p.text.includes('TABLA DE CONTENIDO'));
    if (!tocPage) return [];

    const lines = tocPage.text.split('\n');
    const tocEntries = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Expresión regular robusta para detectar páginas y títulos del índice
      const match = trimmed.match(/^(?:\.\s*)*(\d+)\s*\t+\s*(.+?)(?:\s*\.+\s*)*$/) ||
                    trimmed.match(/^(?:\.\s*)*(\d+)\s+(.+?)(?:\s*\.+\s*)*$/);

      if (match) {
        const pageNum = parseInt(match[1], 10);
        const title = match[2].trim().replace(/\.+$/, '').trim();
        const isSub = line.trim().startsWith('.');
        tocEntries.push({ title, originalPageNum: pageNum, isSub });
      }
    }

    // Ordenar las entradas de la TOC por número de página
    tocEntries.sort((a, b) => a.originalPageNum - b.originalPageNum);
    return tocEntries;
  }

  /**
   * Intenta detectar rangos de páginas para cada anomalía basado en la TOC del PDF.
   * Retorna heurísticas aproximadas o rangos exactos si hay Tabla de Contenido.
   * @param {string} text
   * @param {number} numPages
   * @param {Array} detectedAnomalies
   * @param {Array} [pages] - Array opcional de objetos de páginas para análisis estructurado
   * @returns {Array<{type, label, pageStart, pageEnd}>}
   */
  detectPageRanges(text, numPages, detectedAnomalies, pages) {
    const tocEntries = this.parseTOCEntries(pages, numPages);

    if (tocEntries.length > 0) {
      const sections = [];

      for (const entry of tocEntries) {
        const titleLower = entry.title.toLowerCase();

        // Buscar si esta entrada corresponde a alguna anomalía definida
        let matchedType = null;
        for (const anomaly of ANOMALY_TYPES) {
          const isMatch = anomaly.type === 'string_failure'
            ? titleLower.includes('string')
            : anomaly.keywords.some(k => titleLower.includes(k));

          if (isMatch) {
            matchedType = anomaly;
            break;
          }
        }

        if (matchedType) {
          const pageStart = entry.originalPageNum;
          let pageEnd = numPages;

          // Encontrar la siguiente entrada del índice con número de página estrictamente mayor
          const nextEntry = tocEntries.find(e => e.originalPageNum > pageStart);
          if (nextEntry) {
            pageEnd = nextEntry.originalPageNum - 1;
          }

          sections.push({
            type: matchedType.type,
            label: entry.title, // Conservar el nombre exacto de la anomalía de la TOC
            pageStart,
            pageEnd,
          });
        }
      }

      if (sections.length > 0) {
        return sections;
      }
    }

    // --- ALGORITMO DE RESPALDO (BACKWARD COMPATIBILITY) ---
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const sections = [];

    for (const anomaly of detectedAnomalies) {
      let pageStart = 1;
      let pageEnd = numPages;
      let foundPage = false;

      for (let i = 0; i < lines.length; i++) {
        const lineLower = lines[i].toLowerCase();
        const isMatch = anomaly.type === 'string_failure'
          ? lineLower.includes('string')
          : ANOMALY_TYPES.find(a => a.type === anomaly.type)
              ?.keywords.some(k => lineLower.includes(k));

        if (isMatch) {
          // Busca un número de página en la misma línea o la siguiente
          const pageNumMatch = (lines[i] + ' ' + (lines[i + 1] || '')).match(/\b(\d+)\b/);
          if (pageNumMatch) {
            pageStart = parseInt(pageNumMatch[1], 10);
            pageEnd = Math.min(pageStart + 10, numPages); // estimado: 10 páginas por sección
            foundPage = true;
            break;
          }
        }
      }

      sections.push({
        type: anomaly.type,
        label: anomaly.label,
        pageStart: foundPage ? pageStart : 1,
        pageEnd:   foundPage ? pageEnd   : numPages,
      });
    }

    return sections;
  }
}

module.exports = new PDFParserService();
