"""Exporte les fichiers du logo Rostra (SVG, PNG, JPEG, avatars) dans docs/marque/sortie/Rostra/Logos.

Usage : python exporter_logos.py
Les SVG sont vectorisés (aucune police requise). Les PNG sont transparents et sans marge ;
les JPEG ont un fond plein et incluent la zone de protection.
"""
import pathlib
import shutil

from playwright.sync_api import sync_playwright

from compose import COLORS, SH, SW, horizontal, logotype, symbol, symbol_group, svg, vertical

HERE = pathlib.Path(__file__).parent
OUT = HERE.parent / 'sortie' / 'Rostra' / 'Logos'

TRAVERTIN, ENCRE, POMPEIEN, BLANC = '#F5EFE4', '#221C1A', '#A8372A', '#FFFFFF'
JPEG_BG = {'couleur': BLANC, 'noir': BLANC, 'negatif': ENCRE, 'blanc': POMPEIEN}

# Zone de protection x, exprimée en fraction de la hauteur du fichier SVG produit.
# Symbole et versions avec symbole : x = largeur de la colonne du R (29/96 de la hauteur du symbole).
X_SYMBOL = 29 / SH

DOSSIERS = {
    'horizontal': ('1. Horizontal', (3000, 800), 3000),
    'vertical': ('2. Vertical', (2000, 600), 2000),
    'symbole': ('3. Symbole seul (sans texte)', (2000, 512), 2000),
    'logotype': ('4. Logotype seul (texte seul)', (3000, 800), 3000),
}


def dims(svg_text):
    import re
    w, h = re.search(r'viewBox="0 0 ([\d.]+) ([\d.]+)"', svg_text).groups()
    return float(w), float(h)


def protection(version, svg_text):
    """Zone de protection en unités du SVG."""
    w, h = dims(svg_text)
    if version == 'horizontal':
        return X_SYMBOL * 200  # symbole dessiné à H = 200
    if version == 'vertical':
        return X_SYMBOL * (200 * SH / SW)
    if version == 'symbole':
        return X_SYMBOL * h
    # logotype : x = hauteur d'x du nom (0,63 de la capitale), capitale dessinée à 200
    return 0.63 * 200


def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    builders = {'horizontal': horizontal, 'vertical': vertical, 'symbole': symbol, 'logotype': logotype}
    with sync_playwright() as p:
        browser = p.chromium.launch(channel='chrome')
        page = browser.new_page(device_scale_factor=1)
        for version, (dossier, png_widths, jpeg_width) in DOSSIERS.items():
            base = OUT / dossier
            for sub in ('SVG', 'PNG', 'JPEG'):
                (base / sub).mkdir(parents=True, exist_ok=True)
            for color in COLORS:
                text = builders[version](color)
                (base / 'SVG' / f'rostra_{version}_{color}.svg').write_text(text, encoding='utf-8', newline='\n')
                w, h = dims(text)
                for pw in png_widths:
                    ph = round(pw * h / w)
                    page.set_viewport_size({'width': pw, 'height': ph})
                    page.set_content(f'<style>html,body{{margin:0;background:transparent}}svg{{display:block;width:{pw}px;height:{ph}px}}</style>{text}')
                    page.locator('svg').screenshot(path=str(base / 'PNG' / f'rostra_{version}_{color}_{pw}px.png'), omit_background=True)
                x = protection(version, text)
                tw, th = w + 2 * x, h + 2 * x
                jw = jpeg_width; jh = round(jw * th / tw); scale = jw / tw
                page.set_viewport_size({'width': jw, 'height': jh})
                page.set_content(
                    f'<style>html,body{{margin:0}}div{{width:{jw}px;height:{jh}px;background:{JPEG_BG[color]};display:grid;place-items:center}}'
                    f'svg{{display:block;width:{w * scale:.2f}px;height:{h * scale:.2f}px}}</style><div>{text}</div>')
                page.locator('div').screenshot(path=str(base / 'JPEG' / f'rostra_{version}_{color}_{jw}px.jpg'), type='jpeg', quality=92)
        # Réseaux sociaux : symbole centré, inscrit dans le cercle de recadrage (diamètre utile 62 %).
        social = OUT / '5. Réseaux sociaux'
        social.mkdir(parents=True, exist_ok=True)
        for name, bg, color in [('fond-travertin', TRAVERTIN, 'couleur'), ('fond-blanc', BLANC, 'couleur'), ('fond-encre', ENCRE, 'negatif'), ('fond-pompeien', POMPEIEN, 'blanc')]:
            size = 1080; h = size * 0.46; w = h * SW / SH
            body = f'<rect width="{size}" height="{size}" fill="{bg}"/>' + symbol_group(COLORS[color], (size - w) / 2 + h * 0.02, (size - h) / 2, h)
            text = svg(size, size, body)
            page.set_viewport_size({'width': size, 'height': size})
            page.set_content(f'<style>html,body{{margin:0}}svg{{display:block}}</style>{text}')
            page.locator('svg').screenshot(path=str(social / f'rostra_avatar_{name}_1080px.png'))
            page.locator('svg').screenshot(path=str(social / f'rostra_avatar_{name}_1080px.jpg'), type='jpeg', quality=92)
        browser.close()
    count = sum(1 for f in OUT.rglob('*') if f.is_file())
    print(f'{count} fichiers dans {OUT}')


if __name__ == '__main__':
    main()
