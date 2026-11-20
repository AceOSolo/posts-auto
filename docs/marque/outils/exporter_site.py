"""Produit les fichiers de marque du site à partir de la géométrie du logo.

- apps/web/src/components/logo.tsx : logo horizontal et symbole en SVG en ligne, couleurs en variables CSS ;
- apps/web/src/app/icon.svg et apple-icon.png : favicon et icône d'écran d'accueil ;
- apps/web/src/app/opengraph-image.png (+ .alt.txt) : image de partage 1200 × 630 ;
- apps/web/public/marque/ : logos SVG et PNG pour les e-mails et les partenaires.

Usage : python exporter_site.py (après exporter_illustrations.py, pour le buste de l'image de partage)
"""
import pathlib
import re

from playwright.sync_api import sync_playwright

from compose import SH, SW, horizontal, symbol, symbol_group, svg, COLORS

HERE = pathlib.Path(__file__).parent
ROOT = HERE.parents[2]
WEB = ROOT / 'apps' / 'web'
APP = WEB / 'src' / 'app'
PUBLIC = WEB / 'public'
POLICES = HERE.parent / 'polices'
SORTIE = HERE.parent / 'sortie'

MARBRE, NUIT, ROSE, SOLEIL = '#FFF4E2', '#1E1A45', '#DF1C60', '#FFC93C'


def write(path, text):
    path.write_text(text, encoding='utf-8', newline='\n')


def inner(svg_text):
    w, h = re.search(r'viewBox="0 0 ([\d.]+) ([\d.]+)"', svg_text).groups()
    body = re.sub(r'^.*?<title>Rostra</title>', '', svg_text, flags=re.S).replace('</svg>\n', '')
    return float(w), float(h), body.replace('class=', 'className=').replace('fill-rule=', 'fillRule=')


def logo_tsx():
    hw, hh, hbody = inner(horizontal('couleur', classes=True))
    sw, sh, sbody = inner(symbol('couleur', classes=True))
    return f'''// Fichier généré par docs/marque/outils/exporter_site.py : ne pas modifier à la main.
// Logo Rostra (charte graphique v1.0). Couleurs : variables CSS --logo-tile, --logo-accent, --logo-name.

/** Logo horizontal : la bulle en tesselles et le nom. Le texte est vectorisé, aucune police n'est requise. */
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
'''


def app_icon(size, bg=MARBRE, ratio=0.62):
    h = size * ratio; w = h * SW / SH
    return svg(size, size, f'<rect width="{size}" height="{size}" fill="{bg}"/>' + symbol_group(COLORS['couleur'], (size - w) / 2, (size - h) / 2 + h * 0.04, h))


def og_html():
    buste = (PUBLIC / 'marque' / 'buste-mosaique.svg').read_text(encoding='utf-8')
    return f'''<!doctype html><meta charset="utf-8"><style>
@font-face{{font-family:Bagel;src:url({(POLICES / 'BagelFatOne.ttf').as_uri()})}}
@font-face{{font-family:Schibsted;src:url({(POLICES / 'SchibstedGrotesk.ttf').as_uri()})}}
html,body{{margin:0}}
.og{{width:1200px;height:630px;background:{MARBRE};position:relative;overflow:hidden;color:{NUIT};font-family:Schibsted}}
.logo{{position:absolute;left:72px;top:64px;width:250px}}
.logo svg,.buste svg{{display:block;width:100%;height:auto}}
h1{{position:absolute;left:72px;top:170px;margin:0;width:640px;font:400 86px/1.02 Bagel;letter-spacing:-.01em}}
h1 .u{{color:{ROSE};position:relative;white-space:nowrap}}
h1 .u svg{{position:absolute;left:-4px;right:-4px;bottom:-12px;width:calc(100% + 8px);height:22px}}
p{{position:absolute;left:74px;top:470px;margin:0;width:560px;font-size:28px;line-height:1.4;color:#4D4870}}
.buste{{position:absolute;right:-30px;top:40px;width:560px}}
</style><div class="og"><div class="logo">{horizontal('couleur')}</div>
<h1>Toute l’équipe prend la <span class="u">parole.<svg viewBox="0 0 300 24" preserveAspectRatio="none"><path d="M4 16C60 6 120 20 170 11S260 6 296 14" stroke="{SOLEIL}" stroke-width="9" fill="none" stroke-linecap="round"/></svg></span></h1>
<p>Vos posts LinkedIn rédigés par l’IA, validés par chacun, publiés à l’heure.</p>
<div class="buste">{buste}</div></div>'''


def main():
    write(WEB / 'src' / 'components' / 'logo.tsx', logo_tsx())
    write(APP / 'icon.svg', symbol('couleur', H=64))
    marque = PUBLIC / 'marque'
    marque.mkdir(parents=True, exist_ok=True)
    for color in ('couleur', 'negatif'):
        write(marque / f'rostra_horizontal_{color}.svg', horizontal(color))
    write(marque / 'rostra_symbole_couleur.svg', symbol('couleur'))
    with sync_playwright() as p:
        browser = p.chromium.launch(channel='chrome')
        page = browser.new_page()
        # Icône d'écran d'accueil : carré plein (iOS arrondit lui-même).
        page.set_viewport_size({'width': 180, 'height': 180})
        page.set_content(f'<style>html,body{{margin:0}}svg{{display:block}}</style>{app_icon(180)}')
        page.locator('svg').screenshot(path=str(APP / 'apple-icon.png'))
        # Logo pour les e-mails : 2× la taille d'affichage (160 px de large).
        logo = horizontal('couleur')
        w, h = (float(v) for v in re.search(r'viewBox="0 0 ([\d.]+) ([\d.]+)"', logo).groups())
        pw = 320; ph = round(pw * h / w)
        page.set_viewport_size({'width': pw, 'height': ph})
        page.set_content(f'<style>html,body{{margin:0;background:transparent}}svg{{display:block;width:{pw}px;height:{ph}px}}</style>{logo}')
        page.locator('svg').screenshot(path=str(marque / 'rostra_horizontal_couleur_320px.png'), omit_background=True)
        # Image de partage.
        tmp = SORTIE / 'og.html'
        tmp.parent.mkdir(parents=True, exist_ok=True)
        write(tmp, og_html())
        page.set_viewport_size({'width': 1200, 'height': 630})
        page.goto(tmp.as_uri()); page.wait_for_timeout(400)
        page.locator('.og').screenshot(path=str(APP / 'opengraph-image.png'))
        browser.close()
    write(APP / 'opengraph-image.alt.txt', 'Rostra : toute l’équipe prend la parole. Vos posts LinkedIn rédigés par l’IA, validés par chacun, publiés à l’heure.')
    print('ok')


if __name__ == '__main__':
    main()
