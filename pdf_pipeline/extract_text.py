import sys
import json
import pdfplumber

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No file provided"}))
        sys.exit(1)
        
    path = sys.argv[1]
    
    # Intentar optimizar el uso de memoria para PDFs gigantes
    text_full = []
    pages = []
    
    try:
        with pdfplumber.open(path) as pdf:
            num_pages = len(pdf.pages)
            
            # La TOC siempre está en la página 2 (índice 1)
            # Solo extraer texto de la página 2
            if num_pages > 1:
                page_text = pdf.pages[1].extract_text() or ""
                text_full.append(page_text)
                pages.append({"text": page_text})
            elif num_pages == 1:
                page_text = pdf.pages[0].extract_text() or ""
                text_full.append(page_text)
                pages.append({"text": page_text})
                
        # Unir todo el texto
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
