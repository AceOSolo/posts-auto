"""Produit les fichiers de marque du site à partir de la géométrie du logo.

- apps/web/src/components/logo.tsx : logo horizontal et symbole en SVG en ligne, couleurs en variables CSS ;
- apps/web/src/app/icon.svg et apple-icon.png : favicon et icône d'écran d'accueil ;
- apps/web/src/app/opengraph-image.png (+ .alt.txt) : image de partage 1200 × 630 ;
- apps/web/public/marque/ : logos SVG et PNG pour les e-mails et les partenaires.

Usage : python exporter_site.py
"""
import pathlib
import re

from playwright.sync_api import sync_playwright

from compose import COLORS, SH, SW, horizontal, symbol, symbol_group, svg
from geom import BUBBLE, COLUMN, RAM, SYMBOL_BOX

HERE = pathlib.Path(__file__).parent
ROOT = HERE.parents[2]
WEB = ROOT / 'apps' / 'web'
APP = WEB / 'src' / 'app'
PUBLIC = WEB / 'public'
POLICES = HERE.parent / 'polices'

TRAVERTIN, ENCRE, POMPEIEN = '#F5EFE4', '#221C1A', '#A8372A'


def inner(svg_text):
    w, h = re.search(r'viewBox="0 0 ([\d.]+) ([\d.]+)"', svg_text).groups()
    body = re.sub(r'^.*?<title>Rostra</title>', '', svg_text, flags=re.S).replace('</svg>\n', '')
    return float(w), float(h), body


def themed(body):
    """Remplace les couleurs de la version couleur par des classes CSS."""
    c = COLORS['couleur']
    body = body.replace(f'fill="{c["column"]}" d="{COLUMN}"', f'className="logo-column" d="{COLUMN}"')
    body = body.replace(f'fill="{c["speech"]}"', 'className="logo-speech"')
    body = body.replace(f'fill="{c["name"]}"', 'className="logo-name"')
    return body.replace('fill-rule=', 'fillRule=')


def logo_tsx():
    hw, hh, hbody = inner(horizontal('couleur'))
    sw, sh, sbody = inner(symbol('couleur'))
    return f'''// Fichier généré par docs/marque/outils/exporter_site.py : ne pas modifier à la main.
// Logo Rostra (charte graphique v1.0). Couleurs : variables CSS --logo-column, --logo-speech, --logo-name.

/** Logo horizontal : symbole et nom. Le texte est vectorisé, aucune police n'est requise. */
export function Logo({{ className = 'logo', title = 'Rostra' }}: {{ className?: string; title?: string }}) {{
  return (
    <svg className={{className}} viewBox="0 0 {hw:.2f} {hh:.2f}" role="img" aria-label={{title}}>
      {hbody}
    </svg>
  );
}}

/** Symbole seul : à réserver aux endroits où le nom figure déjà. */
export function LogoSymbol({{ className = 'logo-symbol' }}: {{ className?: string }}) {{
  return (
    <svg className={{className}} viewBox="0 0 {sw:.2f} {sh:.2f}" aria-hidden="true">
      {sbody}
    </svg>
  );
}}
'''.replace(hbody, themed(hbody)).replace(sbody, themed(sbody))


def app_icon(size, radius_ratio=0.22, bg=POMPEIEN, color='blanc', ratio=0.56):
    h = size * ratio; w = h * SW / SH
    r = size * radius_ratio
    rect = f'<rect width="{size}" height="{size}" rx="{r:.1f}" fill="{bg}"/>' if radius_ratio else f'<rect width="{size}" height="{size}" fill="{bg}"/>'
    return svg(size, size, rect + symbol_group(COLORS[color], (size - w) / 2 + h * 0.03, (size - h) / 2, h))


def og_html():
    hw, hh, _ = inner(horizontal('couleur'))
    logo = horizontal('couleur')
    big_h = 520; big_w = big_h * SW / SH
    big = svg(big_w, big_h, symbol_group({'column': '#EBE2D3', 'speech': '#EBDCCB', 'name': ''}, 0, 0, big_h))
    return f'''<!doctype html><meta charset="utf-8"><style>
@font-face{{font-family:Fraunces;src:url({(POLICES / 'Fraunces.ttf').as_uri()})}}
@font-face{{font-family:Hanken;src:url({(POLICES / 'HankenGrotesk.ttf').as_uri()})}}
html,body{{margin:0}}
.og{{width:1200px;height:630px;background:{TRAVERTIN};position:relative;overflow:hidden;color:{ENCRE};font-family:Hanken}}
.big{{position:absolute;right:-40px;bottom:-70px;width:{big_w:.0f}px}}
.logo{{position:absolute;left:80px;top:72px;width:300px}}
h1{{position:absolute;left:80px;top:210px;margin:0;font-family:Fraunces;font-variation-settings:'wght' 650,'opsz' 144,'SOFT' 50;font-size:104px;line-height:1;letter-spacing:-.02em}}
p{{position:absolute;left:84px;top:470px;margin:0;width:640px;font-size:30px;line-height:1.35;color:#5C524C}}
.logo svg,.big svg{{display:block;width:100%;height:auto}}
.rule{{position:absolute;left:84px;top:440px;width:64px;height:5px;background:{POMPEIEN}}}
</style><div class="og"><div class="big">{big}</div><div class="logo">{logo}</div>
<h1>Prenez<br>la parole.</h1><div class="rule"></div><p>Vos posts LinkedIn rédigés par l’IA, validés par chacun, publiés à l’heure.</p></div>'''


def main():
    (WEB / 'src' / 'components' / 'logo.tsx').write_text(logo_tsx(), encoding='utf-8', newline='\n')
    (APP / 'icon.svg').write_text(app_icon(64), encoding='utf-8', newline='\n')
    marque = PUBLIC / 'marque'
    marque.mkdir(parents=True, exist_ok=True)
    for color in ('couleur', 'negatif'):
        (marque / f'rostra_horizontal_{color}.svg').write_text(horizontal(color), encoding='utf-8', newline='\n')
    (marque / 'rostra_symbole_couleur.svg').write_text(symbol('couleur'), encoding='utf-8', newline='\n')
    with sync_playwright() as p:
        browser = p.chromium.launch(channel='chrome')
        page = browser.new_page()
        # Icône d'écran d'accueil : carré plein (iOS arrondit lui-même).
        page.set_viewport_size({'width': 180, 'height': 180})
        page.set_content(f'<style>html,body{{margin:0}}svg{{display:block}}</style>{app_icon(180, radius_ratio=0)}')
        page.locator('svg').screenshot(path=str(APP / 'apple-icon.png'))
        # Logo pour les e-mails : 2× la taille d'affichage (160 px de large).
        logo = horizontal('couleur')
        w, h = (float(v) for v in re.search(r'viewBox="0 0 ([\d.]+) ([\d.]+)"', logo).groups())
        pw = 320; ph = round(pw * h / w)
        page.set_viewport_size({'width': pw, 'height': ph})
        page.set_content(f'<style>html,body{{margin:0;background:transparent}}svg{{display:block;width:{pw}px;height:{ph}px}}</style>{logo}')
        page.locator('svg').screenshot(path=str(marque / 'rostra_horizontal_couleur_320px.png'), omit_background=True)
        # Image de partage.
        page.set_viewport_size({'width': 1200, 'height': 630})
        tmp = HERE.parent / 'sortie' / 'og.html'
        tmp.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_text(og_html(), encoding='utf-8', newline='\n')
        page.goto(tmp.as_uri()); page.wait_for_timeout(300)
        page.locator('.og').screenshot(path=str(APP / 'opengraph-image.png'))
        browser.close()
    (APP / 'opengraph-image.alt.txt').write_text('Rostra : prenez la parole. Vos posts LinkedIn rédigés par l’IA, validés par chacun, publiés à l’heure.', encoding='utf-8', newline='\n')
    print('ok')


if __name__ == '__main__':
    main()
