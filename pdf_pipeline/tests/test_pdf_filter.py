"""
Tests básicos para el pipeline pdf_filter.py.

Para ejecutar:
    cd backend
    pip install -r pdf_pipeline/requirements.txt
    pytest pdf_pipeline/tests/ -v
"""

import io
import json
import sys
import os
import pytest

# Asegurar que el módulo sea importable desde cualquier directorio de trabajo
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from pdf_filter import (
    parse_toc,
    build_new_toc_page,
    generate_filtered_pdf,
    apply_page_number_overlay,
)

import pikepdf
import pdfplumber


# ─────────────────────────────────────────────────────────────────────────────
#  Fixtures — PDF de prueba en memoria
# ─────────────────────────────────────────────────────────────────────────────

def make_minimal_pdf(num_pages: int = 5) -> bytes:
    """Crea un PDF mínimo de N páginas con texto simple usando pikepdf."""
    pdf = pikepdf.Pdf.new()
    for i in range(num_pages):
        page = pikepdf.Page(pikepdf.Dictionary(
            Type=pikepdf.Name('/Page'),
            MediaBox=[0, 0, 595, 842],
        ))
        # Añadir texto simple como stream de contenido
        page_text = f'Página {i + 1}'
        if i == 1:
            # Simular página de índice con texto de TOC
            page_text = (
                'TABLA DE CONTENIDO\n'
                '3 INTRODUCCIÓN\n'
                '5 RESULTADOS\n'
                '.7 PC Crítico\n'
                '.10 Soiling\n'
            )
        content_stream = pikepdf.Stream(pdf, f'BT /F1 12 Tf 50 800 Td ({page_text}) Tj ET'.encode())
        page.obj['/Contents'] = content_stream
        pdf.pages.append(page)

    buf = io.BytesIO()
    pdf.save(buf)
    return buf.getvalue()


# ─────────────────────────────────────────────────────────────────────────────
#  Tests
# ─────────────────────────────────────────────────────────────────────────────

class TestParseTOC:
    def test_parse_toc_returns_dict(self):
        """parse_toc debe devolver un dict (puede estar vacío en PDF minimal)."""
        pdf_bytes = make_minimal_pdf(10)
        result = parse_toc(pdf_bytes)
        assert isinstance(result, dict)

    def test_parse_toc_no_crash_empty_pdf(self):
        """parse_toc no debe lanzar excepción con PDFs sin índice."""
        pdf = pikepdf.Pdf.new()
        buf = io.BytesIO()
        pdf.save(buf)
        result = parse_toc(buf.getvalue())
        assert result == {}


class TestBuildNewTocPage:
    def test_toc_page_is_valid_pdf(self):
        """build_new_toc_page debe devolver un PDF válido."""
        entries = [
            {'label': 'INTRODUCCIÓN', 'page': 3, 'isSub': False},
            {'label': 'PC Crítico',   'page': 5, 'isSub': True},
        ]
        toc_bytes = build_new_toc_page(entries, 'Test Dashboard')
        assert isinstance(toc_bytes, bytes)
        assert len(toc_bytes) > 0

        # Verificar que es un PDF válido
        with pikepdf.open(io.BytesIO(toc_bytes)) as pdf:
            assert len(pdf.pages) == 1

    def test_toc_page_empty_entries(self):
        """build_new_toc_page no debe fallar con lista vacía."""
        toc_bytes = build_new_toc_page([], 'Vacío')
        assert isinstance(toc_bytes, bytes)


class TestGenerateFilteredPdf:
    def test_page_count_after_filter(self):
        """
        El PDF filtrado debe tener:
          portada (1) + TOC nueva (1) + páginas seleccionadas (N) páginas.
        """
        pdf_bytes = make_minimal_pdf(10)

        selected_sections = [
            {'pageStart': 3, 'pageEnd': 4, 'label': 'INTRODUCCIÓN', 'type': 'other'},
            {'pageStart': 5, 'pageEnd': 6, 'label': 'RESULTADOS',   'type': 'other'},
        ]

        result = generate_filtered_pdf(pdf_bytes, selected_sections, 'Test')
        assert isinstance(result, bytes)
        assert len(result) > 0

        with pikepdf.open(io.BytesIO(result)) as out_pdf:
            # portada(1) + TOC(1) + páginas 3,4,5,6 (4) = 6 páginas
            assert len(out_pdf.pages) == 6

    def test_empty_selection_includes_only_cover_and_toc(self):
        """Sin secciones seleccionadas, el PDF debe tener solo portada + TOC."""
        pdf_bytes = make_minimal_pdf(5)
        result = generate_filtered_pdf(pdf_bytes, [], 'Test')

        with pikepdf.open(io.BytesIO(result)) as out_pdf:
            assert len(out_pdf.pages) == 2  # portada + TOC nueva

    def test_output_is_valid_pdf(self):
        """El PDF resultante debe ser un PDF válido que pikepdf puede abrir."""
        pdf_bytes = make_minimal_pdf(8)
        selected = [{'pageStart': 3, 'pageEnd': 5, 'label': 'Sección A', 'type': 'other'}]
        result = generate_filtered_pdf(pdf_bytes, selected)

        with pikepdf.open(io.BytesIO(result)) as pdf:
            assert len(pdf.pages) > 0


class TestApplyOverlay:
    def test_overlay_does_not_crash(self):
        """apply_page_number_overlay no debe lanzar excepción en una página normal."""
        pdf = pikepdf.Pdf.new()
        page = pikepdf.Page(pikepdf.Dictionary(
            Type=pikepdf.Name('/Page'),
            MediaBox=[0, 0, 595, 842],
        ))
        pdf.pages.append(page)

        # No debe lanzar excepción
        apply_page_number_overlay(pdf.pages[0])
