"""Produit les illustrations en mosaïque de Rostra à partir des aplats de docs/marque/illustrations.

- apps/web/public/marque/ : buste et pictogrammes des étapes, en SVG, pour le site ;
- docs/marque/sortie/Rostra/Illustrations/ : les mêmes en SVG et en PNG (2000 px) pour les supports.

Usage : python exporter_illustrations.py
"""
import pathlib

from playwright.sync_api import sync_playwright

from mosaique import mosaic

HERE = pathlib.Path(__file__).parent
SRC = HERE.parent / 'illustrations'
ROOT = HERE.parents[2]
PUBLIC = ROOT / 'apps' / 'web' / 'public' / 'marque'
OUT = HERE.parent / 'sortie' / 'Rostra' / 'Illustrations'
JOINT = '#3A3560'

# nom : (source, taille de travail, tesselle, graine, joint)
ILLUSTRATIONS = {
    'buste-mosaique': ('buste.svg', 400, 8, 11, JOINT),
    'etape-planning': ('planning.svg', 240, 20, 3, JOINT),
    'etape-redaction': ('redaction.svg', 240, 20, 5, JOINT),
    'etape-validation': ('validation.svg', 240, 20, 8, JOINT),
    'etape-publication': ('publication.svg', 240, 20, 13, JOINT),
}


def main():
    PUBLIC.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    made = {}
    for name, (src, size, cell, seed, grout) in ILLUSTRATIONS.items():
        text = mosaic((SRC / src).read_text(encoding='utf-8'), size, cell, seed, grout)
        for folder in (PUBLIC, OUT):
            (folder / f'{name}.svg').write_text(text, encoding='utf-8', newline='\n')
        made[name] = text
    with sync_playwright() as p:
        b = p.chromium.launch(channel='chrome')
        pg = b.new_page(viewport={'width': 2000, 'height': 2000})
        for name, text in made.items():
            pg.set_content(f'<style>html,body{{margin:0;background:transparent}}svg{{display:block;width:2000px;height:2000px}}</style>{text}')
            pg.locator('svg').screenshot(path=str(OUT / f'{name}_2000px.png'), omit_background=True)
        b.close()
    print(len(made), 'illustrations')


if __name__ == '__main__':
    main()
