import sys, io
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas as rl_canvas
from reportlab.platypus import Paragraph, Frame, Table, TableStyle
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.colors import HexColor

def build_warning_page():
    buf = io.BytesIO()
    page_w, page_h = A4
    c = rl_canvas.Canvas(buf, pagesize=A4)

    text_html_bold = (
        '<font color="#E74C3C" size="28"><b>NOTA IMPORTANTE</b></font><br/><br/><br/>'
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
        fontSize=20,
        leading=30,
        alignment=TA_CENTER,
        textColor=HexColor('#333333')
    )

    p = Paragraph(text_html_bold, style)
    
    rect_w = page_w - 80
    rect_h = page_h * 0.60
    rect_x = 40
    rect_y = (page_h - rect_h) / 2
    
    c.setStrokeColor(HexColor('#E74C3C'))
    c.setLineWidth(3)
    c.line(rect_x, rect_y + rect_h, rect_x + rect_w, rect_y + rect_h)
    c.line(rect_x, rect_y, rect_x + rect_w, rect_y)

    frame_w = rect_w - 40
    frame_h = rect_h - 40
    frame_x = rect_x + 20
    frame_y = rect_y + 20

    t = Table([[p]], colWidths=[frame_w], rowHeights=[frame_h])
    t.setStyle(TableStyle([
        ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
        ('ALIGN', (0,0), (-1,-1), 'CENTER'),
    ]))

    f = Frame(frame_x, frame_y, frame_w, frame_h, showBoundary=0)
    f.addFromList([t], c)
    c.save()
    return buf.getvalue()

with open('test_warn.pdf', 'wb') as f:
    f.write(build_warning_page())
