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
import re
import sys
import traceback
from typing import Optional

import pikepdf
import pdfplumber
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

# Timeout descarga PDF (segundos)
DOWNLOAD_TIMEOUT_S = 120


# ─────────────────────────────────────────────────────────────────────────────
#  1. Descarga
# ─────────────────────────────────────────────────────────────────────────────

import tempfile
import os

def download_pdf(url: str) -> str:
    """Descarga el PDF original a un archivo temporal y devuelve su ruta."""
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix='.pdf')
    with requests.get(url, timeout=DOWNLOAD_TIMEOUT_S, stream=True) as resp:
        resp.raise_for_status()
        for chunk in resp.iter_content(chunk_size=8192):
            tmp.write(chunk)
    tmp.close()
    return tmp.name


# ─────────────────────────────────────────────────────────────────────────────
#  2. Parseo del índice
# ─────────────────────────────────────────────────────────────────────────────

def parse_toc(pdf_path: str) -> list[dict]:
    """
    Extrae las entradas del índice (página 2 del PDF) usando pdfplumber.

    Devuelve lista de dicts:
      [{ 'title': str, 'page_num': int, 'is_sub': bool }]

    Detecta si una línea es subsección por indentación o por comienzo con número
    de sección (1.1, 2., 4.1., etc.).
    """
    entries: list[dict] = []
    try:
        with pdfplumber.open(pdf_path) as pdf:
            num_pages = len(pdf.pages)

            # Buscar página de índice (generalmente pág. 2, índice 1)
            toc_text = None
            for idx in range(min(5, num_pages)):
                text = pdf.pages[idx].extract_text() or ''
                if 'TABLA DE CONTENIDO' in text.upper() or 'CONTENIDO' in text.upper():
                    toc_text = text
                    break

            if not toc_text:
                print('[pdf_filter] WARN: No se encontró página de índice.', file=sys.stderr)
                return []

            for raw_line in toc_text.split('\n'):
                line = raw_line.rstrip()
                stripped = line.strip()
                if not stripped:
                    continue

                # Detectar subsección:
                # - línea tiene indentación (espacios al inicio)
                # - o comienza con un número de sección tipo "1.1", "2.", "4.1."
                has_indent = raw_line.startswith('  ') or raw_line.startswith('\t')
                starts_with_section_num = bool(re.match(r'^\s*\d+(\.\d+)*\.?\s+[A-ZÁÉÍÓÚÑ]', raw_line))
                is_sub = has_indent or starts_with_section_num

                # Patrón A: TÍTULO ...... N  (número al final, separado por puntos o espacios)
                m = re.match(r'^\.?\s*(.+?)\s*(?:\.{2,}|\. (?:\. )+)\s*(\d{1,3})\s*$', stripped)
                if m:
                    title = m.group(1).strip().rstrip('. ')
                    page_num = int(m.group(2))
                    if title:
                        entries.append({'title': title, 'page_num': page_num, 'is_sub': is_sub})
                    continue

                # Patrón B: N TÍTULO (número al inicio)
                m = re.match(r'^\s*(\d{1,3})\s+(.+?)(?:\s*\.{2,})?$', stripped)
                if m:
                    page_num = int(m.group(1))
                    title = m.group(2).strip().rstrip('. ')
                    if title:
                        entries.append({'title': title, 'page_num': page_num, 'is_sub': is_sub})
                    continue

                # Patrón C: sección numerada tipo "4.1. EVALUACIÓN" sin número al final
                # (subsección sin número de página al final — poco común pero defensivo)
                m = re.match(r'^\s*(\d+(?:\.\d+)+\.?\s+.+)', stripped)
                if m:
                    # No tiene número de página → skip (no podemos mapearla)
                    pass

    except Exception as exc:
        print(f'[pdf_filter] ERROR en parse_toc: {exc}', file=sys.stderr)
        traceback.print_exc(file=sys.stderr)

    return entries


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

def build_new_toc_page_text_only(toc_entries: list[dict]) -> bytes:
    """
    Genera el texto de la página TOC con reportlab.
    NO dibuja encabezado, porque este se fusionará sobre la página original.
    """
    buf = io.BytesIO()
    page_w, page_h = A4   # 595.28 x 841.89 pt
    c = rl_canvas.Canvas(buf, pagesize=A4)

    # ── Título TABLA DE CONTENIDO ─────────────────────────────────────────────
    # Posición original aproximada en el PDF
    title_y = page_h - 126
    c.setFont('Times-Bold', 13)
    c.drawCentredString(page_w / 2, title_y, 'TABLA DE CONTENIDO')

    # ── Entradas del TOC ─────────────────────────────────────────────────────
    # Más centrado: incrementamos márgenes
    margin_l  = 45
    margin_r  = 45
    cx_left  = margin_l + 5
    cx_right = page_w - margin_r - 5
    y = title_y - 28   # posición inicial (decrece hacia abajo)

    for entry in toc_entries:
        if y < 50:    # protección overflow de página
            break

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

    # ── Número de página 2 al pie ─────────────────────────────────────────────
    c.setFont('Times-Roman', 10)
    c.setFillColorRGB(0, 0, 0)
    c.drawRightString(cx_right, 18, '2')

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

    1. Parsear índice del PDF original (pdfplumber).
    2. Calcular qué páginas incluir:
         portada + pre-resultados + anomalías seleccionadas + post-resultados
    3. Construir mapa de renumeración: p_original → p_nueva.
    4. Filtrar entradas del TOC (quitar anomalías no seleccionadas, actualizar páginas).
    5. Copiar páginas nativas con pikepdf; aplicar overlay blanco + nuevo número.
    6. Generar TOC nueva (reportlab).
    7. Ensamblar: portada (p1) + TOC (p2) + contenido (p3+).
    """
    print(f'[pdf_filter] Iniciando pipeline desde archivo local.', file=sys.stderr)

    # ── 1. Parsear TOC original ───────────────────────────────────────────────
    toc_raw = parse_toc(pdf_path)
    import gc
    gc.collect()
    print(f'[pdf_filter] TOC parseado: {len(toc_raw)} entradas', file=sys.stderr)

    # ── 2. Conjuntos de páginas de anomalías ──────────────────────────────────
    all_anomaly_starts   = {int(s['pageStart']) for s in all_sections}
    sel_anomaly_starts   = {int(s['pageStart']) for s in selected_sections}

    if all_sections:
        first_anomaly_start = min(int(s['pageStart']) for s in all_sections)
        last_anomaly_end    = max(int(s['pageEnd'])   for s in all_sections)
    else:
        first_anomaly_start = 10 ** 9
        last_anomaly_end    = 0

    # ── 3. Abrir PDF fuente ───────────────────────────────────────────────────
    with pikepdf.open(pdf_path) as src_pdf:
        total_pages = len(src_pdf.pages)
        print(f'[pdf_filter] PDF fuente: {total_pages} páginas', file=sys.stderr)

        # ── 4. Determinar páginas a incluir ───────────────────────────────────
        pages_to_include: list[int] = []

        # 4a. Portada (siempre)
        pages_to_include.append(1)

        # 4b. Pre-resultados: páginas 3 hasta antes de la primera anomalía
        #     (página 2 = TOC original → excluida, reemplazada por la nueva)
        for p in range(3, first_anomaly_start):
            if p <= total_pages:
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

        # ── 5. Mapa de renumeración: p_original → p_nueva ────────────────────
        # La estructura final del PDF es:
        #   p1  = portada
        #   p2  = TOC nueva (insertada por nosotros)
        #   p3+ = resto de contenido
        original_to_new: dict[int, int] = {}
        for new_idx, orig_p in enumerate(pages_to_include):
            if orig_p == 1:
                original_to_new[orig_p] = 1
            else:
                # +2 porque p2 va a ser la TOC nueva
                original_to_new[orig_p] = new_idx + 2

        # ── 6. Filtrar entradas del TOC ───────────────────────────────────────
        new_toc_entries: list[dict] = []

        for entry in toc_raw:
            orig_p  = entry['page_num']
            is_sub  = entry['is_sub']
            title   = entry['title']

            # ¿Es una subsección de anomalía?
            is_anomaly_sub = orig_p in all_anomaly_starts

            if is_anomaly_sub:
                # Solo incluir si el usuario la seleccionó
                if orig_p not in sel_anomaly_starts:
                    continue
                new_p = original_to_new.get(orig_p)
                if new_p is None:
                    continue
                new_toc_entries.append({'title': title, 'page': new_p, 'is_sub': True})
            else:
                # Sección normal (siempre presente): actualizar número de página
                new_p = original_to_new.get(orig_p)

                if new_p is None:
                    # La página original no está en el mapa directo;
                    # buscar la primera página incluida >= orig_p
                    for cand in sorted(original_to_new.keys()):
                        if cand >= orig_p:
                            new_p = original_to_new[cand]
                            break

                if new_p is not None:
                    new_toc_entries.append({'title': title, 'page': new_p, 'is_sub': is_sub})

        # Insertar RESULTADOS antes de la primera anomalía
        # Buscamos donde quedó "THERMAL ANALYSIS" y metemos RESULTADOS justo después
        for idx, entry in enumerate(new_toc_entries):
            if 'THERMAL ANALYSIS' in entry['title'].upper():
                # Obtener número de página de la primera anomalía (la que le sigue)
                if idx + 1 < len(new_toc_entries):
                    next_page = new_toc_entries[idx + 1]['page']
                    # Validar que no hayamos insertado RESULTADOS ya en un parseo raro
                    if 'RESULTADOS' not in new_toc_entries[idx + 1]['title'].upper():
                        new_toc_entries.insert(idx + 1, {'title': 'RESULTADOS', 'page': next_page, 'is_sub': False})
                break

        print(f'[pdf_filter] Entradas TOC nuevo: {len(new_toc_entries)}', file=sys.stderr)

        # ── 7. Generar TOC nueva texto ────────────────────────────────────────
        toc_text_bytes = build_new_toc_page_text_only(new_toc_entries)
        print(f'[pdf_filter] TOC texto nuevo: {len(toc_text_bytes) / 1024:.1f} KB', file=sys.stderr)

        # ── 8. Ensamblar PDF final (MODIFICACIÓN IN-PLACE PARA AHORRAR RAM) ───
        with pikepdf.open(io.BytesIO(toc_text_bytes)) as toc_text_pdf:
            # Páginas a conservar: 1 (portada), 2 (TOC), y el resto del contenido
            pages_to_keep = set([1, 2] + [p for p in pages_to_include if p > 1])

            # Eliminar páginas excluidas EN ORDEN INVERSO
            for p in range(total_pages, 0, -1):
                if p not in pages_to_keep:
                    del src_pdf.pages[p - 1]

            # Reemplazar cuerpo de TOC (ahora es la página en índice 1)
            if len(src_pdf.pages) > 1:
                orig_toc_page = src_pdf.pages[1]
                w = float(orig_toc_page.mediabox[2])
                
                rl_page = toc_text_pdf.pages[0]
                rl_xobj = src_pdf.copy_foreign(rl_page.as_form_xobject())
                
                res = orig_toc_page.obj.get('/Resources')
                if not res:
                    res = pikepdf.Dictionary()
                    orig_toc_page.obj['/Resources'] = res
                xobjs = res.get('/XObject')
                if not xobjs:
                    xobjs = pikepdf.Dictionary()
                    res['/XObject'] = xobjs
                xobjs['/RLTOC'] = rl_xobj

                overlay = b'q 1 1 1 rg 1 1 1 RG 0 0 ' + f'{w:.2f} 745.00 re f '.encode() + b' 1 0 0 1 0 0 cm /RLTOC Do Q'
                overlay_stream = pikepdf.Stream(src_pdf, overlay)

                if '/Contents' not in orig_toc_page.obj:
                    orig_toc_page.obj['/Contents'] = pikepdf.Array([src_pdf.make_indirect(overlay_stream)])
                else:
                    existing = orig_toc_page.obj['/Contents']
                    if isinstance(existing, pikepdf.Array):
                        existing.append(src_pdf.make_indirect(overlay_stream))
                    else:
                        orig_toc_page.obj['/Contents'] = pikepdf.Array([existing, src_pdf.make_indirect(overlay_stream)])

            # Aplicar overlays al resto de las páginas (índice 2 en adelante)
            remaining_content_pages = [p for p in pages_to_include if p > 1]
            for idx, orig_p in enumerate(remaining_content_pages):
                page = src_pdf.pages[idx + 2]
                new_page_num = original_to_new[orig_p]
                apply_page_number_overlay(page, src_pdf, new_page_num)

            tmp_out = tempfile.NamedTemporaryFile(delete=False, suffix='.pdf')
            tmp_out.close()
            src_pdf.save(tmp_out.name)
            result_path = tmp_out.name

    total_final = len(pages_to_include) + 1  # portada + TOC + ...
    print(
        f'[pdf_filter] PDF final guardado en disco (IN-PLACE). '
        f'{total_final} páginas',
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
