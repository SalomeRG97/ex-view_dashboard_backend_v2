import sys, io, tempfile, json
import pikepdf
from reportlab.pdfgen import canvas as rl_canvas
from reportlab.lib.pagesizes import A4

def test_in_place():
    src_pdf = pikepdf.Pdf.new()
    # add 10 pages
    for i in range(10):
        src_pdf.add_blank_page(page_size=(595,841))
        
    total_pages = len(src_pdf.pages)
    
    # say we want to include pages 1, 3, 5, 6
    pages_to_include = [1, 3, 5, 6]
    
    # 1. Map new pages
    original_to_new = {}
    for new_idx, orig_p in enumerate(pages_to_include):
        if orig_p == 1: original_to_new[orig_p] = 1
        else: original_to_new[orig_p] = new_idx + 2
        
    pages_to_keep = set([1, 2] + [p for p in pages_to_include if p > 1])
    print(f"Keeping: {pages_to_keep}")
    
    for p in range(total_pages, 0, -1):
        if p not in pages_to_keep:
            del src_pdf.pages[p - 1]
            
    print(f"Remaining pages: {len(src_pdf.pages)}")
    
    # TOC
    orig_toc_page = src_pdf.pages[1]
    w = float(orig_toc_page.mediabox[2])
    # create rl page
    buf = io.BytesIO()
    c = rl_canvas.Canvas(buf, pagesize=A4)
    c.drawString(100, 100, "NEW TOC")
    c.save()
    rl_pdf = pikepdf.Pdf.open(io.BytesIO(buf.getvalue()))
    rl_page = rl_pdf.pages[0]
    rl_xobj = src_pdf.copy_foreign(rl_page.as_form_xobject())
    
    res = orig_toc_page.obj.get('/Resources')
    if not res:
        res = pikepdf.Dictionary()
        orig_toc_page.obj['/Resources'] = res
    xobjs = res.setdefault('/XObject', pikepdf.Dictionary())
    xobjs['/RLTOC'] = rl_xobj
    
    overlay = b'q 1 1 1 rg 0 0 ' + f'{w:.2f} 745.00 re f 1 0 0 1 0 0 cm /RLTOC Do Q'.encode()
    overlay_stream = pikepdf.Stream(src_pdf, overlay)
    
    if '/Contents' not in orig_toc_page.obj:
        orig_toc_page.obj['/Contents'] = pikepdf.Array([src_pdf.make_indirect(overlay_stream)])
    else:
        existing = orig_toc_page.obj['/Contents']
        if isinstance(existing, pikepdf.Array):
            existing.append(src_pdf.make_indirect(overlay_stream))
        else:
            orig_toc_page.obj['/Contents'] = pikepdf.Array([existing, src_pdf.make_indirect(overlay_stream)])
            
    # Remaining
    remaining_content_pages = [p for p in pages_to_include if p > 1]
    for idx, orig_p in enumerate(remaining_content_pages):
        page_obj = src_pdf.pages[idx + 2]
        new_page_num = original_to_new[orig_p]
        print(f"Page {idx + 3} was {orig_p} now {new_page_num}")
        
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix='.pdf')
    tmp.close()
    src_pdf.save(tmp.name)
    print("Saved to", tmp.name)

test_in_place()
