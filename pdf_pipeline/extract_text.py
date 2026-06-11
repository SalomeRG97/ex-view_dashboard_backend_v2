import sys
import json
import fitz

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No file provided"}))
        sys.exit(1)
        
    path = sys.argv[1]
    
    text_full = []
    pages = []
    
    try:
        # PyMuPDF is extremely fast and uses very little RAM
        doc = fitz.open(path)
        num_pages = doc.page_count
        
        # La TOC siempre está en la página 2 (índice 1)
        if num_pages > 1:
            page = doc.load_page(1)
            page_text = page.get_text() or ""
            text_full.append(page_text)
            pages.append({"text": page_text})
        elif num_pages == 1:
            page = doc.load_page(0)
            page_text = page.get_text() or ""
            text_full.append(page_text)
            pages.append({"text": page_text})
            
        doc.close()
            
        full_string = "\n".join(text_full)
        
        print(json.dumps({
            "numPages": num_pages,
            "text": full_string,
            "pages": pages
        }))
        
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
