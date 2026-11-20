"""Rend un fichier HTML en PNG (ou PDF) avec Chromium. Usage : render.py in.html out.png [largeur] [hauteur] [transparent]"""
import sys, pathlib
from playwright.sync_api import sync_playwright
src, out = pathlib.Path(sys.argv[1]).resolve(), sys.argv[2]
w = int(sys.argv[3]) if len(sys.argv) > 3 else 1400
h = int(sys.argv[4]) if len(sys.argv) > 4 else 900
transparent = len(sys.argv) > 5 and sys.argv[5] == '1'
with sync_playwright() as p:
    b = p.chromium.launch(channel='chrome')
    pg = b.new_page(viewport={'width': w, 'height': h})
    pg.goto(src.as_uri()); pg.wait_for_timeout(300)
    if out.endswith('.pdf'):
        pg.pdf(path=out, prefer_css_page_size=True, print_background=True)
    else:
        pg.screenshot(path=out, full_page=True, omit_background=transparent)
    b.close()
