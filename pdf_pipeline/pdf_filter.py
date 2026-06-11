#!/usr/bin/env python3
"""
pdf_filter.py — Pipeline PDF nativo para informes filtrados de EX-VIEW SOLAR.

Recibe por stdin: JSON con {
  "pdfUrl":           str,
  "selectedSections": list[dict],   # solo las anomalías elegidas por el usuario
  "allSections":      list[dict],   # TODAS las anomalías del informe (para saber cuáles excluir)
  "dashboardName":    str
}

Escribe por stdout: bytes del PDF filtrado.

Estructura del PDF de salida:
  p1  = portada (página 1 original)
  p2  = TOC nueva (generada con reportlab, mismas secciones sin las anomalías excluidas)
  p3+ = páginas pre-resultados (glosario, intro, metodología, análisis, etc.)
       + páginas de anomalías seleccionadas
       + páginas post-resultados (conclusiones, certificados, etc.)

NO convierte ninguna página a imagen. RAM objetivo: ~50 KB/página.
"""

from __future__ import annotations

import io
import json
import os
import re
import sys
import tempfile
import traceback
from typing import Optional



import pikepdf
import fitz
import requests
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.pdfgen import canvas as rl_canvas


# ─────────────────────────────────────────────────────────────────────────────
#  Constantes
# ─────────────────────────────────────────────────────────────────────────────

# Altura en puntos del pie de página que se cubre con el overlay blanco.
# 75pt cubre aproximadamente los últimos 26mm del pie de cualquier A4.
PAGE_FOOTER_COVER_PT = 75

# Posición vertical donde se escribe el nuevo número de página (desde y0)
PAGE_NUM_TEXT_Y_PT = 20

# Timeout descarga PDF (segundos).
# Para PDFs de hasta 2 GB a 10 Mbps se necesitan ~27 min → 1800s de margen.
DOWNLOAD_TIMEOUT_S = int(os.environ.get('PDF_DOWNLOAD_TIMEOUT_S', '1800'))


# ─────────────────────────────────────────────────────────────────────────────
#  1. Descarga
# ─────────────────────────────────────────────────────────────────────────────



def download_pdf(url: str) -> str:
    """Descarga el PDF original a un archivo temporal y devuelve su ruta."""
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix='.pdf')
    downloaded = 0
    with requests.get(url, timeout=DOWNLOAD_TIMEOUT_S, stream=True) as resp:
        resp.raise_for_status()
        for chunk in resp.iter_content(chunk_size=1024 * 1024):  # 1 MB por chunk
            tmp.write(chunk)
            downloaded += len(chunk)
            if downloaded % (100 * 1024 * 1024) == 0:  # log cada 100 MB
                print(f'[pdf_filter] Descargando... {downloaded // (1024*1024)} MB', file=sys.stderr)
    tmp.close()
    print(f'[pdf_filter] Descarga completa: {downloaded // (1024*1024)} MB → {tmp.name}', file=sys.stderr)
    return tmp.name


# ─────────────────────────────────────────────────────────────────────────────
#  2. Parseo del índice
# ─────────────────────────────────────────────────────────────────────────────

def _parse_toc_lines(text: str, entries: list[dict]) -> None:
    """
    Procesa las líneas de texto de una página TOC y agrega entradas a la lista.
    """
    for raw_line in text.split('\n'):
        line    = raw_line.rstrip()
        stripped = line.strip()
        if not stripped:
            continue

        # Detectar subsección por indentación o número de sección (1.1, 2., 4.1., etc.)
        has_indent            = raw_line.startswith('  ') or raw_line.startswith('\t')
        starts_with_section_num = bool(re.match(r'^\s*\d+(\.\d+)*\.?\s+[A-ZÁÉÍÓÚÑ]', raw_line))
        is_sub = has_indent or starts_with_section_num

        # Patrón A: TÍTULO ...... N  (puntos o espacios entre título y número)
        m = re.match(r'^\.?\s*(.+?)\s*(?:\.{2,}|\. (?:\. )+|\s{3,})\s*(\d{1,4})\s*$', stripped)
        if m:
            title    = m.group(1).strip().rstrip('. ')
            page_num = int(m.group(2))
            if title:
                entries.append({'title': title, 'page_num': page_num, 'is_sub': is_sub})
            continue

        # Patrón B: N TÍTULO (número al inicio, sin puntos al final)
        m = re.match(r'^\s*(\d{1,4})\s+(.+?)(?:\s*\.{2,})?$', stripped)
        if m:
            page_num = int(m.group(1))
            title    = m.group(2).strip().rstrip('. ')
            if title:
                entries.append({'title': title, 'page_num': page_num, 'is_sub': is_sub})
            continue

        # Patrón C: TÍTULO TAB N  (tabulación como separador)
        m = re.match(r'^(.+?)\t+(\d{1,4})\s*$', stripped)
        if m:
            title    = m.group(1).strip().rstrip('. ')
            page_num = int(m.group(2))
            if title:
                entries.append({'title': title, 'page_num': page_num, 'is_sub': is_sub})
            continue


def _looks_like_toc_page(text: str) -> bool:
    """
    Heurística rápida: ¿tiene esta página suficientes líneas con patrón TOC?
    (título ... número  ó  número título)
    """
    pattern = re.compile(
        r'(?:\.{2,}|\. (?:\. )+|\t|\s{3,})\s*\d{1,4}\s*$'   # TÍTULO ...... N  ó  TÍTULO\tN ó TÍTULO    N
        r'|^\s*\d{1,4}\s+[A-ZÁÉÍÓÚÑ]',   # N TÍTULO
        re.MULTILINE,
    )
    matches = pattern.findall(text)
    return len(matches) >= 2              # al menos 2 entradas para considerar TOC


def parse_toc(pdf_path: str) -> tuple[list[dict], list[int]]:
    """
    Extrae TODAS las entradas del indice del PDF, incluso si el TOC ocupa
    varias paginas consecutivas.

    Retorna:
      (entries, toc_page_indices)
      - entries:          lista de { 'title', 'page_num', 'is_sub' }
      - toc_page_indices: lista de indices 0-based de las paginas fisicas del TOC
                          (e.g. [1, 2] si el TOC ocupa las paginas 2 y 3 del PDF)
    """
    entries: list[dict]  = []
    toc_indices: list[int] = []
    try:
        doc = fitz.open(pdf_path)
        num_pages   = doc.page_count
        toc_started = False
        toc_idx     = -1

        # Paso 1: primera pagina del TOC
        for idx in range(min(8, num_pages)):
            page = doc.load_page(idx)
            try:
                text = page.get_text("layout") or ''
            except Exception:
                text = page.get_text("text", sort=True) or ''
            if 'TABLA DE CONTENIDO' in text.upper() or 'CONTENIDO' in text.upper():
                toc_started = True
                toc_idx     = idx
                toc_indices.append(idx)
                print(f'[pdf_filter] TOC: primera pag en indice {idx} (fisico {idx+1})', file=sys.stderr)
                _parse_toc_lines(text, entries)
                break

        if not toc_started:
            print('[pdf_filter] WARN: No se encontro pagina de indice.', file=sys.stderr)
            doc.close()
            return [], []

        # Paso 2: paginas de continuacion del TOC
        for idx in range(toc_idx + 1, min(toc_idx + 40, num_pages)):
            page = doc.load_page(idx)
            try:
                text = page.get_text("layout") or ''
            except Exception:
                text = page.get_text("text", sort=True) or ''
            if _looks_like_toc_page(text):
                toc_indices.append(idx)
                print(f'[pdf_filter] TOC: continuacion en pag indice {idx} (fisico {idx+1})', file=sys.stderr)
                _parse_toc_lines(text, entries)
            else:
                break
        
        doc.close()

    except Exception as exc:
        print(f'[pdf_filter] ERROR en parse_toc: {exc}', file=sys.stderr)
        traceback.print_exc(file=sys.stderr)

    print(f'[pdf_filter] TOC total: {len(entries)} entradas | paginas TOC: {[i+1 for i in toc_indices]}', file=sys.stderr)
    return entries, toc_indices



def build_warning_page() -> bytes:
    """Construye una página de advertencia para insertar al inicio del PDF."""
    buf = io.BytesIO()
    page_w, page_h = A4
    c = rl_canvas.Canvas(buf, pagesize=A4)

    from reportlab.platypus import Paragraph
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.enums import TA_CENTER
    from reportlab.lib.colors import HexColor

    text_html_bold = (
        '<font color="#000000" size="28"><b>NOTA IMPORTANTE</b></font><br/><br/><br/>'
        'Les recordamos que el informe que se entrega es completo en su '
        'versión base. La plataforma permite aplicar filtros para ajustarlo a las necesidades '
        'específicas de cada usuario.<br/><br/>'
        'Queremos subrayar que cualquier ajuste o filtrado que '
        'se aplique es responsabilidad de ustedes. Les recomendamos verificar que no se '
        'omitan datos clave, de cara al análisis final del cliente.<br/><br/>'
        'Muchas gracias por su atención.'
    )

    style = ParagraphStyle(
        name='WarningStyle',
        fontName='Helvetica-Bold',
        fontSize=16,
        leading=26,
        alignment=TA_CENTER,
        textColor=HexColor('#333333')
    )

    p = Paragraph(text_html_bold, style)
    
    rect_w = page_w - 80
    rect_h = page_h * 0.60
    rect_x = 40
    rect_y = (page_h - rect_h) / 2

    frame_w = rect_w - 40
    frame_h = rect_h - 40
    frame_x = rect_x + 20
    frame_y = rect_y + 20

    w, h = p.wrap(frame_w, frame_h)
    # Centrar verticalmente dentro del contenedor
    p.drawOn(c, frame_x, frame_y + (frame_h - h) / 2)

    c.save()
    return buf.getvalue()


# ─────────────────────────────────────────────────────────────────────────────
#  3. Overlay blanco + nuevo número de página
# ─────────────────────────────────────────────────────────────────────────────

def apply_page_number_overlay(page: pikepdf.Page, pdf: pikepdf.Pdf, new_page_num: int) -> None:
    """
    Sobre la página dada:
      1. Dibuja un rectángulo blanco cubriendo el pie completo (PAGE_FOOTER_COVER_PT pt de alto).
      2. Escribe el nuevo número de página en Helvetica 10pt, alineado a la derecha.

    Usa Helvetica (font Type1 estándar de PDF, no requiere embedding).
    El stream se AGREGA al final del /Contents de la página → se renderiza encima de todo.
    """
    mediabox = page.mediabox
    x0 = float(mediabox[0])
    x1 = float(mediabox[2])
    y0 = float(mediabox[1])

    cover_h = PAGE_FOOTER_COVER_PT
    text_x  = x1 - 55    # posición X del número (aproximadamente alineado a la derecha)
    text_y  = y0 + PAGE_NUM_TEXT_Y_PT

    # ── Añadir Helvetica a recursos de la página ──────────────────────────────
    font_key = pikepdf.Name('/HvPgN')
    page_obj = page.obj

    if '/Resources' not in page_obj:
        page_obj['/Resources'] = pikepdf.Dictionary()

    res = page_obj['/Resources']
    if '/Font' not in res:
        res['/Font'] = pikepdf.Dictionary()

    if font_key not in res['/Font']:
        res['/Font'][font_key] = pdf.make_indirect(
            pikepdf.Dictionary(
                Type=pikepdf.Name('/Font'),
                Subtype=pikepdf.Name('/Type1'),
                BaseFont=pikepdf.Name('/Helvetica'),
                Encoding=pikepdf.Name('/WinAnsiEncoding'),
            )
        )

    # ── Content stream ────────────────────────────────────────────────────────
    overlay_bytes = (
        b'q '
        # Rectángulo blanco sobre todo el pie de página
        + f'1 1 1 rg 1 1 1 RG '
          f'{x0:.2f} {y0:.2f} {x1 - x0:.2f} {cover_h:.2f} re f '.encode()
        # Nuevo número de página en negro
        + b'BT '
        + b'/HvPgN 10 Tf '
        + b'0 0 0 rg '
        + f'{text_x:.2f} {text_y:.2f} Td ({new_page_num}) Tj '.encode()
        + b'ET '
        + b'Q'
    )

    overlay_stream   = pikepdf.Stream(pdf, overlay_bytes)
    indirect_overlay = pdf.make_indirect(overlay_stream)

    if '/Contents' not in page_obj:
        page_obj['/Contents'] = pikepdf.Array([indirect_overlay])
    else:
        existing = page_obj['/Contents']
        if isinstance(existing, pikepdf.Array):
            existing.append(indirect_overlay)
        else:
            page_obj['/Contents'] = pikepdf.Array([existing, indirect_overlay])


# ─────────────────────────────────────────────────────────────────────────────
#  4. Generación de la nueva página de índice con reportlab
# ─────────────────────────────────────────────────────────────────────────────

def build_new_toc_pages(toc_entries: list[dict]) -> bytes:
    """
    Genera el texto de la página TOC con reportlab. Puede generar múltiples páginas.
    Retorna los bytes de un PDF con 1 o más páginas.
    NO dibuja encabezado, porque este se fusionará sobre la página original.
    """
    buf = io.BytesIO()
    page_w, page_h = A4   # 595.28 x 841.89 pt
    c = rl_canvas.Canvas(buf, pagesize=A4)

    margin_l  = 45
    margin_r  = 45
    cx_left  = margin_l + 5
    cx_right = page_w - margin_r - 5

    def draw_header():
        # ── Título TABLA DE CONTENIDO ─────────────────────────────────────────────
        title_y = page_h - 126
        c.setFont('Times-Bold', 13)
        c.drawCentredString(page_w / 2, title_y, 'TABLA DE CONTENIDO')
        return title_y - 28

    y = draw_header()
    page_number = 3

    for entry in toc_entries:
        if y < 50:    # protección overflow de página
            # Last page number for current page
            c.setFont('Times-Roman', 10)
            c.setFillColorRGB(0, 0, 0)
            c.drawRightString(cx_right, 18, str(page_number))
            
            c.showPage()
            page_number += 1
            y = draw_header()

        title    = (entry.get('title') or '').upper()
        page_num = str(entry.get('page', ''))
        is_sub   = entry.get('is_sub', False)

        if is_sub:
            font      = 'Times-Roman'
            font_sz   = 9.5
            indent    = 20
            line_gap  = 15
        else:
            font      = 'Times-Roman'
            font_sz   = 11
            indent    = 0
            line_gap  = 18

        tx = cx_left + indent

        c.setFillColorRGB(0, 0, 0)
        c.setFont(font, font_sz)

        # Título
        c.drawString(tx, y, title)

        # Número de página (alineado a la derecha)
        c.drawRightString(cx_right, y, page_num)

        # Línea punteada entre título y número
        title_w = c.stringWidth(title, font, font_sz)
        num_w   = c.stringWidth(page_num, font, font_sz)
        dot_x0  = tx + title_w + 4
        dot_x1  = cx_right - num_w - 4

        if dot_x1 > dot_x0 + 6:
            c.saveState()
            c.setLineWidth(0.4)
            # Subsecciones: puntos espaciados (. . . .); principales: densos (....)
            if is_sub:
                c.setDash(1, 4)
            else:
                c.setDash(1, 2)
            c.line(dot_x0, y + font_sz * 0.3, dot_x1, y + font_sz * 0.3)
            c.restoreState()

        y -= line_gap

    # ── Número de página al pie (última página TOC) ───────────────────────────
    c.setFont('Times-Roman', 10)
    c.setFillColorRGB(0, 0, 0)
    c.drawRightString(cx_right, 18, str(page_number))

    c.save()
    return buf.getvalue()


# ─────────────────────────────────────────────────────────────────────────────
#  5. Pipeline principal
# ─────────────────────────────────────────────────────────────────────────────

def generate_filtered_pdf(
    pdf_path:          str,
    selected_sections: list[dict],
    all_sections:      list[dict],
    dashboard_name:    str = 'Informe Solar',
) -> str:
    """
    Pipeline completo:
    """
    print(f'[pdf_filter] Iniciando pipeline desde archivo local.', file=sys.stderr)

    # ── 1. Parsear TOC original ───────────────────────────────────────────────
    toc_raw, toc_page_indices = parse_toc(pdf_path)

    # Paginas fisicas del TOC (1-indexed). Ej: {2, 3} si el TOC ocupa 2 paginas.
    toc_physical_pages  = {idx + 1 for idx in toc_page_indices}  # e.g. {2, 3}
    first_toc_page      = min(toc_physical_pages) if toc_physical_pages else 2
    content_start_page  = max(toc_physical_pages) + 1 if toc_physical_pages else 3
    print(
        f'[pdf_filter] Paginas TOC: {sorted(toc_physical_pages)} | '
        f'Contenido empieza en pagina {content_start_page}',
        file=sys.stderr,
    )

    # ── 2. Conjuntos de páginas de anomalías ──────────────────────────────────
    if all_sections:
        first_anomaly_start = min(int(s['pageStart']) for s in all_sections)
        last_anomaly_end    = max(int(s['pageEnd'])   for s in all_sections)
    else:
        first_anomaly_start = 10 ** 9
        last_anomaly_end    = 0

    print(
        f'[pdf_filter] Secciones: total={len(all_sections)} seleccionadas={len(selected_sections)} '
        f'| anomalias pag {first_anomaly_start}-{last_anomaly_end}',
        file=sys.stderr,
    )

    # ── 3. Abrir PDF fuente ───────────────────────────────────────────────────
    with pikepdf.open(pdf_path) as src_pdf:
        total_pages = len(src_pdf.pages)
        print(f'[pdf_filter] PDF fuente: {total_pages} páginas', file=sys.stderr)

        # ── 4. Determinar páginas a incluir ───────────────────────────────────
        pages_to_include: list[int] = []

        # 4a. Portada (siempre)
        pages_to_include.append(1)

        # 4b. Pre-resultados: desde la primera pagina de contenido real
        for p in range(content_start_page, first_anomaly_start):
            if p <= total_pages and p not in toc_physical_pages:
                pages_to_include.append(p)

        # 4c. Páginas de anomalías seleccionadas
        for sec in selected_sections:
            for p in range(int(sec['pageStart']), int(sec['pageEnd']) + 1):
                if p <= total_pages and p not in pages_to_include:
                    pages_to_include.append(p)

        # 4d. Post-resultados: páginas después del último bloque de anomalías
        for p in range(last_anomaly_end + 1, total_pages + 1):
            if p not in pages_to_include:
                pages_to_include.append(p)

        pages_to_include = sorted(set(pages_to_include))

        if pages_to_include:
            print(
                f'[pdf_filter] Páginas a incluir: {len(pages_to_include)} '
                f'(de {pages_to_include[0]} a {pages_to_include[-1]})',
                file=sys.stderr,
            )

        # ── 5. Filtrar entradas del TOC ───────────────────────────────────────
        excluded_anomaly_pages: set[int] = set()
        for sec in all_sections:
            ps, pe = int(sec['pageStart']), int(sec['pageEnd'])
            is_selected = any(abs(int(s['pageStart']) - ps) <= 2 for s in selected_sections)
            if not is_selected:
                for p in range(ps, pe + 1):
                    excluded_anomaly_pages.add(p)

        filtered_raw_entries = []
        for entry in toc_raw:
            orig_p = entry['page_num']
            if orig_p in excluded_anomaly_pages:
                print(f'[pdf_filter] TOC omitida (excluida): "{entry["title"]}" pag {orig_p}', file=sys.stderr)
                continue
            filtered_raw_entries.append(entry)

        # ── 6. Estimar páginas de TOC ─────────────────────────────────────────
        # Generamos un PDF TOC temporal con los números originales para saber cuántas páginas ocupa
        dummy_toc_bytes = build_new_toc_pages(filtered_raw_entries)
        with pikepdf.open(io.BytesIO(dummy_toc_bytes)) as dummy_pdf:
            K = len(dummy_pdf.pages)
            print(f'[pdf_filter] El nuevo TOC ocupará {K} páginas.', file=sys.stderr)

        # ── 7. Mapa de renumeración: p_original → p_nueva ─────────────────────
        # La estructura final del PDF es:
        #   p1  = advertencia (nueva)
        #   p2  = portada
        #   p3..p(2+K) = TOC nueva (insertada por nosotros)
        #   p(3+K)+ = resto de contenido
        original_to_new: dict[int, int] = {}
        for new_idx, orig_p in enumerate(pages_to_include):
            if orig_p == 1:
                original_to_new[orig_p] = 2
            else:
                original_to_new[orig_p] = new_idx + 2 + K

        # ── 8. Actualizar números de página en entradas del TOC ───────────────
        new_toc_entries: list[dict] = []
        sorted_orig_keys = sorted(original_to_new.keys())

        for entry in filtered_raw_entries:
            orig_p = entry['page_num']
            new_p = original_to_new.get(orig_p)
            if new_p is None:
                for cand in sorted_orig_keys:
                    if cand >= orig_p:
                        new_p = original_to_new[cand]
                        break

            if new_p is not None:
                new_toc_entries.append({'title': entry['title'], 'page': new_p, 'is_sub': entry['is_sub']})
            else:
                print(f'[pdf_filter] TOC sin mapeo (omitida): "{entry["title"]}" pag {orig_p}', file=sys.stderr)

        # Insertar RESULTADOS antes de la primera anomalia si existe THERMAL ANALYSIS
        for idx, entry in enumerate(new_toc_entries):
            if 'THERMAL ANALYSIS' in entry['title'].upper():
                if idx + 1 < len(new_toc_entries):
                    next_page = new_toc_entries[idx + 1]['page']
                    if 'RESULTADOS' not in new_toc_entries[idx + 1]['title'].upper():
                        new_toc_entries.insert(idx + 1, {'title': 'RESULTADOS', 'page': next_page, 'is_sub': False})
                break

        print(f'[pdf_filter] Entradas TOC nuevo: {len(new_toc_entries)}', file=sys.stderr)

        # ── 9. Generar TOC nueva texto (final) ────────────────────────────────
        toc_text_bytes = build_new_toc_pages(new_toc_entries)
        print(f'[pdf_filter] TOC texto nuevo: {len(toc_text_bytes) / 1024:.1f} KB', file=sys.stderr)

        # ── 10. Ensamblar PDF final (MODIFICACIÓN IN-PLACE PARA AHORRAR RAM) ──
        with pikepdf.open(io.BytesIO(toc_text_bytes)) as toc_text_pdf:
            # Eliminar páginas excluidas en ORDEN INVERSO
            # Nos quedamos con: 1, first_toc_page, y el resto de pages_to_include (excluyendo todas las del TOC físico)
            pages_to_keep = set(
                [1, first_toc_page]
                + [p for p in pages_to_include if p > 1 and p not in toc_physical_pages]
            )

            for p in range(total_pages, 0, -1):
                if p not in pages_to_keep:
                    del src_pdf.pages[p - 1]

            # Reemplazar cuerpo de TOC.
            if len(src_pdf.pages) > 1:
                # El TOC original está en la posición 1 (la portada está en 0)
                orig_toc_page = src_pdf.pages[1]
                w = float(orig_toc_page.mediabox[2])

                # Si el nuevo TOC necesita múltiples páginas (K > 1), insertamos (K-1) copias
                # de orig_toc_page para usarlas como fondo. Hacemos un shallow copy.
                for _ in range(K - 1):
                    new_page_dict = pikepdf.Dictionary(orig_toc_page.obj)
                    if '/Contents' in new_page_dict:
                        if isinstance(new_page_dict['/Contents'], pikepdf.Array):
                            new_page_dict['/Contents'] = pikepdf.Array(new_page_dict['/Contents'])
                        else:
                            new_page_dict['/Contents'] = pikepdf.Array([new_page_dict['/Contents']])
                    src_pdf.pages.insert(2, pikepdf.Page(src_pdf.make_indirect(new_page_dict)))

                # Ahora superponemos cada página generada por ReportLab
                for i in range(K):
                    target_page = src_pdf.pages[1 + i]
                    rl_page = toc_text_pdf.pages[i]
                    rl_xobj = src_pdf.copy_foreign(rl_page.as_form_xobject())

                    res = target_page.obj.get('/Resources')
                    if not res:
                        res = pikepdf.Dictionary()
                        target_page.obj['/Resources'] = res
                    xobjs = res.get('/XObject')
                    if not xobjs:
                        xobjs = pikepdf.Dictionary()
                        res['/XObject'] = xobjs
                    xobj_name = f'/RLTOC{i}'
                    xobjs[xobj_name] = rl_xobj

                    # Dibujar un rectángulo blanco y colocar la página de reportlab encima
                    overlay = b'q 1 1 1 rg 1 1 1 RG 0 0 ' + f'{w:.2f} 745.00 re f '.encode() + b' 1 0 0 1 0 0 cm ' + xobj_name.encode() + b' Do Q'
                    overlay_stream = pikepdf.Stream(src_pdf, overlay)

                    if '/Contents' not in target_page.obj:
                        target_page.obj['/Contents'] = pikepdf.Array([src_pdf.make_indirect(overlay_stream)])
                    else:
                        existing = target_page.obj['/Contents']
                        if isinstance(existing, pikepdf.Array):
                            existing.append(src_pdf.make_indirect(overlay_stream))
                        else:
                            target_page.obj['/Contents'] = pikepdf.Array([existing, src_pdf.make_indirect(overlay_stream)])

            # Aplicar overlays (números de página nuevos) al resto del contenido
            remaining_content_pages = [p for p in pages_to_include if p > 1]
            for idx, orig_p in enumerate(remaining_content_pages):
                # +1 (portada) + K (páginas de TOC)
                page = src_pdf.pages[idx + 1 + K]
                new_page_num = original_to_new[orig_p]
                apply_page_number_overlay(page, src_pdf, new_page_num)

            # Insertar página de advertencia al inicio (se convierte en p1)
            warning_bytes = build_warning_page()
            with pikepdf.open(io.BytesIO(warning_bytes)) as warning_pdf:
                src_pdf.pages.insert(0, warning_pdf.pages[0])

            tmp_out = tempfile.NamedTemporaryFile(delete=False, suffix='.pdf')
            tmp_out.close()
            result_path = tmp_out.name
            try:
                src_pdf.save(result_path)
            except Exception:
                os.unlink(result_path)
                raise
            
    total_final = len(pages_to_include) + K  # advertencia(1) + portada(1) -1 (1 orig toc included) + K + content... wait
    print(
        f'[pdf_filter] PDF final guardado en disco (IN-PLACE). '
        f'Aprox {total_final + 1} páginas totales',
        file=sys.stderr,
    )
    return result_path


# ─────────────────────────────────────────────────────────────────────────────
#  6. Punto de entrada
# ─────────────────────────────────────────────────────────────────────────────

def main() -> None:
    """
    stdin  → JSON { pdfUrl, selectedSections, allSections, dashboardName }
    stdout → bytes del PDF filtrado
    stderr → logs
    """
    try:
        raw     = sys.stdin.buffer.read()
        payload = json.loads(raw.decode('utf-8'))

        pdf_url           = payload['pdfUrl']
        selected_sections = payload.get('selectedSections', [])
        all_sections      = payload.get('allSections', selected_sections)
        dashboard_name    = payload.get('dashboardName', 'Informe Solar')

        print(f'[pdf_filter] Descargando PDF: {pdf_url}', file=sys.stderr)
        pdf_path = download_pdf(pdf_url)
        
        try:
            out_path = generate_filtered_pdf(
                pdf_path, selected_sections, all_sections, dashboard_name
            )
        finally:
            # Limpiar archivo temporal de entrada
            try:
                os.unlink(pdf_path)
            except Exception:
                pass

        # Devolver JSON con la ruta del archivo y tamaño
        size = os.path.getsize(out_path)
        payload = json.dumps({'tmpFile': out_path, 'size': size}).encode('utf-8')
        sys.stdout.buffer.write(payload)
        sys.stdout.buffer.flush()

    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        error_payload = json.dumps({'error': str(exc)}).encode('utf-8')
        sys.stdout.buffer.write(error_payload)
        sys.stdout.buffer.flush()
        sys.exit(1)


if __name__ == '__main__':
    main()

