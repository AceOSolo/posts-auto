"""Génère la charte graphique Rostra (PDF A4 paysage) dans docs/marque/sortie/Rostra/.

Usage : python charte.py
Prérequis : exporter_logos.py (pour la liste des fichiers) et des captures du site dans
docs/marque/sortie/captures (site-ordinateur.png, site-telephone.png, site-sombre.png).
Les contrastes et les valeurs CMJN sont calculés ici (CMJN : profil Coated FOGRA39 de Windows,
intention colorimétrique relative).
"""
import html
import pathlib
import re

from PIL import Image, ImageCms
from playwright.sync_api import sync_playwright

from compose import CAP, COLORS, GAP_H, GAP_V, SH, SW, V_WIDTH, horizontal, logotype, symbol, symbol_group, svg, vertical
from geom import BUBBLE, COLUMN, RAM

HERE = pathlib.Path(__file__).parent
SORTIE = HERE.parent / 'sortie'
OUT = SORTIE / 'Rostra'
POLICES = HERE.parent / 'polices'
CAPTURES = SORTIE / 'captures'
APP = HERE.parents[2] / 'apps' / 'web' / 'src' / 'app'
VERSION = 'Version 1.0 · novembre 2026'
FOGRA39 = pathlib.Path(r'C:\Windows\System32\spool\drivers\color\CoatedFOGRA39.icc')

# --- Couleurs -------------------------------------------------------------------------------
C = dict(
    encre='#221C1A', travertin='#F5EFE4', pompeien='#A8372A', ocre='#C8912E',
    pompeien_fonce='#8A2B20', pompeien_profond='#5E1D16', pompeien_clair='#E98B72', pompeien_brume='#F6E1DA',
    ocre_fonce='#85591A', ocre_clair='#E8C27A', ocre_brume='#F5E7C8',
    encre_douce='#5C524C', encre_brume='#BDB3AA', travertin_soutenu='#ECE3D4', marbre='#FFFCF7', filet='#DCD0BE',
    blanc='#FFFFFF',
)


def lum(hexa):
    h = hexa.lstrip('#'); c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    c = [x / 12.92 if x <= 0.03928 else ((x + 0.055) / 1.055) ** 2.4 for x in c]
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]


def contrast(a, b):
    x, y = sorted([lum(a), lum(b)], reverse=True)
    return (x + 0.05) / (y + 0.05)


_transform = None
def cmyk(hexa):
    global _transform
    if _transform is None:
        _transform = ImageCms.buildTransform(ImageCms.createProfile('sRGB'), ImageCms.getOpenProfile(str(FOGRA39)), 'RGB', 'CMYK',
                                             renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC)
    h = hexa.lstrip('#'); rgb = tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
    px = ImageCms.applyTransform(Image.new('RGB', (1, 1), rgb), _transform).getpixel((0, 0))
    return ' · '.join(str(round(v / 255 * 100)) for v in px)


def rgb(hexa):
    h = hexa.lstrip('#'); return ' · '.join(str(int(h[i:i + 2], 16)) for i in (0, 2, 4))


def fmt(x):
    return f'{x:.1f}'.replace('.', ',')


# --- Mise en page ---------------------------------------------------------------------------
pages = []


def page(section, body, cls='', bare=False):
    pages.append((section, body, cls, bare))


def head(kicker, title, intro=''):
    return (f'<p class="kicker">{kicker}</p><h1>{title}</h1>' + (f'<p class="intro">{intro}</p>' if intro else ''))


def inline(svg_text, cls=''):
    return f'<div class="logo-box {cls}">{svg_text}</div>'


def tile(svg_text, bg, label, sub='', cls=''):
    if bg == C['travertin'] and 'bordered' not in cls:
        cls += ' bordered'
    return f'<figure class="tile {cls}"><div class="tile-art" style="background:{bg}">{svg_text}</div><figcaption><strong>{label}</strong>{f"<span>{sub}</span>" if sub else ""}</figcaption></figure>'


def swatch(name, hexa, role, big=False, dark_text=None):
    fg = dark_text if dark_text else (C['encre'] if lum(hexa) > 0.35 else C['travertin'])
    return (f'<div class="sw {"big" if big else ""}" style="background:{hexa};color:{fg}"><strong>{name}</strong><span class="role">{role}</span>'
            f'<span class="codes">HEX {hexa}<br>RVB {rgb(hexa)}<br>CMJN {cmyk(hexa)}</span></div>')


def chip(name, hexa, role):
    return (f'<div class="chip"><span class="dot" style="background:{hexa}"></span><div><strong>{name}</strong><span>{role}</span>'
            f'<small>{hexa} · RVB {rgb(hexa)}<br>CMJN {cmyk(hexa)}</small></div></div>')


# 1. Couverture -------------------------------------------------------------------------------
big = svg(SW / SH * 300, 300, symbol_group(COLORS['couleur'], 0, 0, 300))
page('', f'''
<div class="cover">
  <div class="cover-logo">{horizontal('couleur')}</div>
  <div class="cover-text">
    <p class="kicker">Identité visuelle · version 1.0</p>
    <h1 class="display">Charte<br>graphique</h1>
    <p class="intro">Logo, couleurs, typographie, éléments graphiques et ton de la marque Rostra.</p>
    <p class="meta">Novembre 2026 · Rostra, un service édité par SimplX</p>
  </div>
  <div class="cover-symbol">{big}</div>
</div>''', cls='p-cover', bare=True)

# 2. Sommaire ---------------------------------------------------------------------------------
SOMMAIRE = [
    ('01', 'La marque', 'Le nom, la promesse, la personnalité', 3),
    ('02', 'Le logo', 'Construction, versions, couleurs, protection, interdits', 5),
    ('03', 'Les couleurs', 'Palette principale, nuances, règles, contrastes', 12),
    ('04', 'La typographie', 'Polices et hiérarchie', 15),
    ('05', 'Les éléments graphiques', 'Chiffres romains, ligne de tribune, formes, interface', 17),
    ('06', 'Le ton', 'Écrire comme Rostra', 19),
    ('07', 'Exemples d’application', 'Site, image de partage, réseaux sociaux, e-mail', 20),
    ('08', 'Les fichiers fournis', 'Où trouver quoi, quel format choisir', 22),
]
page('Sommaire', head('Sommaire', 'Ce que contient<br>cette charte', 'Ce document fixe les règles d’usage de l’identité Rostra. Il s’adresse à toute personne qui crée un support : équipe, prestataire, imprimeur, partenaire, agence cliente.') +
     '<ol class="toc">' + ''.join(f'<li><span class="n">{n}</span><span class="t"><strong>{t}</strong><span>{d}</span></span><span class="p">p. {p:02d}</span></li>' for n, t, d, p in SOMMAIRE) + '</ol>', cls='p-toc')

# 3. La marque : le nom ---------------------------------------------------------------------------
page('01 · La marque', head('01 · La marque', 'Une tribune<br>pour chacun') + f'''
<div class="cols-2">
  <div>
    <p class="lead">En 338 av. J.-C., après la bataille d’Antium, les Romains fixent les éperons de bronze des navires pris à l’ennemi sur la tribune aux harangues du Forum. Ces éperons s’appellent <em>rostra</em>, et la tribune prend leur nom.</p>
    <p>Du haut des Rostres, on prenait la parole devant le peuple. Aujourd’hui, le forum s’appelle LinkedIn. Rostra donne la tribune à chaque collaborateur d’une entreprise : l’IA rédige ses posts dans son ton, il les valide en un clic, ils partent à l’heure.</p>
    <div class="facts">
      <div><strong>Le nom</strong><span>Rostra, du latin <em>rostrum</em> : l’éperon d’un navire, puis la tribune.</span></div>
      <div><strong>La promesse</strong><span>Vos posts LinkedIn rédigés par l’IA, validés par chacun, publiés à l’heure.</span></div>
      <div><strong>La signature</strong><span class="sig">Prenez la parole.</span></div>
    </div>
  </div>
  <div class="story">
    <div class="story-row"><span class="num">I</span><div><strong>Une tribune</strong><span>la colonne du R : l’entreprise qui donne la parole</span></div></div>
    <div class="story-row"><span class="num">II</span><div><strong>Une parole</strong><span>la boucle du R, dessinée comme une bulle</span></div></div>
    <div class="story-row"><span class="num">III</span><div><strong>Un éperon</strong><span>la jambe du R, pointée vers l’avant comme une proue</span></div></div>
    <div class="story-symbol">{symbol('couleur')}</div>
  </div>
</div>''')

# 4. Personnalité ---------------------------------------------------------------------------
page('01 · La marque', head('01 · La marque', 'Claire, chaleureuse, fiable', 'La marque parle à des dirigeants, des experts et des équipes de communication. Elle leur fait gagner du temps sans jamais parler à leur place.') + '''
<div class="cols-3 traits">
  <div><span class="num">I</span><h3>Claire</h3><p>Des titres francs, une idée par phrase, beaucoup d’air. On écrit pour être lu sur un téléphone, entre deux rendez-vous.</p></div>
  <div><span class="num">II</span><h3>Chaleureuse</h3><p>Un fond de pierre claire, une serif qui a du caractère, un rouge de fresque. On s’adresse à des personnes, pas à des utilisateurs.</p></div>
  <div><span class="num">III</span><h3>Fiable</h3><p>Rien ne part sans l’accord du titulaire, rien n’est inventé. Le dessin reste net et constant, sans effet.</p></div>
</div>
<div class="cols-2 gap-top">
  <div class="note"><h3>Le clin d’œil</h3><p>L’identité garde une trace de Rome : la colonne et la proue du symbole, les chiffres romains des étapes, la ligne de tribune. Toujours discret, jamais déguisé.</p></div>
  <div class="note avoid"><h3>À éviter</h3><ul>
    <li>Le décor « péplum » : lauriers, SPQR, colonnes doriques, polices gravées type Trajan</li>
    <li>Les codes « IA » et « SaaS » génériques : dégradés violets, robots, étincelles</li>
    <li>Le bleu et le logo de LinkedIn : la marque ne doit pas s’y confondre</li>
    <li>Les emojis dans les supports de marque</li>
    <li>Les chiffres, témoignages ou références non vérifiés</li>
  </ul></div>
</div>''')

# 5. Le logo : un symbole, un nom ---------------------------------------------------------------
s = 2.4
anat = f'''<svg viewBox="0 0 {126 * s:.0f} {120 * s:.0f}" class="anat">
<g transform="scale({s})">
<path d="{COLUMN}" fill="{C['encre']}"/><path d="{BUBBLE}" fill-rule="evenodd" fill="{C['pompeien']}"/><path d="{RAM}" fill="{C['pompeien']}"/>
</g>
<g font-family="Hanken Grotesk" font-size="15" font-weight="700" fill="{C['travertin']}">
<circle cx="{26.5 * s}" cy="{92 * s}" r="13" fill="{C['travertin']}"/><text x="{26.5 * s}" y="{92 * s + 5}" text-anchor="middle" fill="{C['encre']}">1</text>
<circle cx="{58 * s}" cy="{22 * s}" r="13" fill="{C['travertin']}"/><text x="{58 * s}" y="{22 * s + 5}" text-anchor="middle" fill="{C['encre']}">2</text>
<circle cx="{88 * s}" cy="{86 * s}" r="13" fill="{C['travertin']}"/><text x="{88 * s}" y="{86 * s + 5}" text-anchor="middle" fill="{C['encre']}">3</text>
</g></svg>'''
page('02 · Le logo', head('02 · Le logo', 'Un symbole, un nom') + f'''
<div class="cols-2">
  <div class="anat-wrap">{anat}</div>
  <div>
    <ol class="legend-list">
      <li><span class="n">1</span><div><strong>La colonne</strong><span>En encre. La tribune, l’entreprise qui porte la parole de ses collaborateurs.</span></div></li>
      <li><span class="n">2</span><div><strong>La bulle</strong><span>En rouge pompéien. La parole ; sa contreforme ronde est la voix de chacun.</span></div></li>
      <li><span class="n">3</span><div><strong>L’éperon</strong><span>En rouge pompéien. La proue des <em>rostra</em> : la parole qui avance, publiée à l’heure.</span></div></li>
    </ol>
    <p>Réunies, les trois formes dessinent un R. La colonne est soudée à la bulle : le symbole se lit d’un bloc, et la bicolorie raconte la tribune et la parole.</p>
    <div class="logotype-demo">{logotype('couleur')}</div>
    <p class="small">Le logotype : « Rostra » en Fraunces, graisse 650, taille optique 144, douceur 50, approche −1,2 %. Le texte est vectorisé dans les fichiers : il ne dépend d’aucune police installée.</p>
  </div>
</div>''')

# 6. Construction ---------------------------------------------------------------------------
g = 3.0
grid = ''.join(f'<line x1="{i * g}" y1="0" x2="{i * g}" y2="{120 * g}"/>' for i in range(0, 121, 12)) + ''.join(f'<line x1="0" y1="{i * g}" x2="{120 * g}" y2="{i * g}"/>' for i in range(0, 121, 12))
cons = f'''<svg viewBox="-30 -10 {120 * g + 60} {120 * g + 30}" class="cons">
<g stroke="{C['filet']}" stroke-width="1">{grid}</g>
<g transform="scale({g})" opacity=".92"><path d="{COLUMN}" fill="{C['encre']}"/><path d="{BUBBLE}" fill-rule="evenodd" fill="{C['pompeien']}"/><path d="{RAM}" fill="{C['pompeien']}"/></g>
<g stroke="{C['ocre_fonce']}" stroke-width="1.5" fill="none" stroke-dasharray="4 3">
<circle cx="{78 * g}" cy="{42 * g}" r="{30 * g}"/><circle cx="{74 * g}" cy="{42 * g}" r="{12 * g}"/>
</g>
<g font-family="Hanken Grotesk" font-size="13" fill="{C['encre']}" font-weight="600">
<text x="{12 * g}" y="{112 * g + 14}">12</text><text x="{41 * g - 8}" y="{112 * g + 14}">41</text><text x="{114 * g - 14}" y="{112 * g + 14}">114</text>
<text x="-26" y="{12 * g + 5}">12</text><text x="-26" y="{72 * g + 5}">72</text><text x="-26" y="{108 * g + 5}">108</text>
</g></svg>'''
hz = horizontal('couleur')
hz_inner = re.sub(r'^.*?</title>', '', hz, flags=re.S).replace('</svg>\n', '')
hw = float(re.search(r'viewBox="0 0 ([\d.]+)', hz).group(1))
sw_px = SW / SH * 200
ann = f'''<svg viewBox="-60 -20 {hw + 170:.0f} 310" class="hz-cons">{hz_inner}
<g stroke="{C['ocre_fonce']}" stroke-width="2" fill="none">
<line x1="-30" y1="0" x2="-30" y2="200"/><line x1="-38" y1="0" x2="-22" y2="0"/><line x1="-38" y1="200" x2="-22" y2="200"/>
<line x1="{sw_px:.1f}" y1="230" x2="{sw_px + GAP_H * 200:.1f}" y2="230"/><line x1="{sw_px:.1f}" y1="222" x2="{sw_px:.1f}" y2="238"/><line x1="{sw_px + GAP_H * 200:.1f}" y1="222" x2="{sw_px + GAP_H * 200:.1f}" y2="238"/>
<line x1="{hw + 20:.1f}" y1="{100 - CAP * 100:.1f}" x2="{hw + 20:.1f}" y2="{100 + CAP * 100:.1f}"/>
</g>
<line x1="-10" y1="100" x2="{hw + 30:.1f}" y2="100" stroke="{C['ocre_fonce']}" stroke-dasharray="6 5" stroke-width="1.5"/>
<g font-family="Hanken Grotesk" font-size="22" font-weight="700" fill="{C['ocre_fonce']}">
<text x="-52" y="108">H</text><text x="{sw_px + 6:.1f}" y="268">0,34 H</text><text x="{hw + 28:.1f}" y="108">0,56 H</text>
</g></svg>'''
page('02 · Construction', head('02 · Construction', 'Une grille exacte') + f'''
<div class="cols-2 cons-grid">
  <div>{cons}</div>
  <div>
    <p>Le symbole est dessiné sur une grille de 120 unités. Toutes ses mesures en découlent.</p>
    <table class="spec">
      <tr><th>Colonne</th><td>29 × 96 (de 12 à 41)</td></tr>
      <tr><th>Bulle</th><td>hauteur 60, extrémité en demi-cercle de rayon 30</td></tr>
      <tr><th>Contreforme</th><td>cercle de diamètre 24, centré sur la bulle</td></tr>
      <tr><th>Éperon</th><td>base de 32 sous la bulle, pointe en (114 ; 108)</td></tr>
      <tr><th>Encombrement</th><td>102 × 96</td></tr>
    </table>
    <h3 class="gap-top">Version horizontale</h3>
    {ann}
    <p class="small">H : hauteur du symbole · 0,34 H : espace entre le symbole et le nom · 0,56 H : hauteur des capitales, centrées sur le symbole. Version verticale : nom de {fmt(V_WIDTH)} fois la largeur du symbole, centré dessous, à {fmt(GAP_V)} fois cette largeur.</p>
  </div>
</div>''')

# 7. Versions ---------------------------------------------------------------------------------
page('02 · Les versions', head('02 · Les versions', 'Quatre versions, un même dessin', 'Choisissez la version selon la place disponible. Ne recomposez jamais le logo vous-même : utilisez les fichiers fournis.') + f'''
<div class="cols-4 versions">
  {tile(horizontal('couleur'), C['travertin'], 'Horizontal', 'Version principale. En-têtes de site et de documents, signatures e-mail, présentations : partout où la place est en largeur.')}
  {tile(vertical('couleur'), C['travertin'], 'Vertical', 'Formats carrés ou en hauteur : couvertures, affiches, kakémonos, objets.', 'tall')}
  {tile(symbol('couleur'), C['travertin'], 'Symbole seul', 'Petits formats et rappels : favicon, icône d’application, avatar des réseaux sociaux. Là où le nom est déjà présent ou connu.', 'tall')}
  {tile(logotype('couleur'), C['travertin'], 'Logotype seul', 'Quand le symbole figure déjà ailleurs sur le support, ou dans un espace très bas : bandeau, pied de page.')}
</div>''')

# 8. Couleurs du logo -----------------------------------------------------------------------------
page('02 · Les couleurs du logo', head('02 · Les couleurs du logo', 'Quatre déclinaisons') + f'''
<div class="cols-2 decl">
  {tile(horizontal('couleur'), C['travertin'], 'Couleur', 'Version de référence, sur fond clair : travertin, blanc, travertin soutenu. Colonne et nom Encre #221C1A · parole Pompéien #A8372A.')}
  {tile(horizontal('negatif'), C['encre'], 'Négatif', 'Sur fond sombre : encre, pompéien profond. C’est la version du pied de page du site et du mode sombre. Colonne et nom Travertin #F5EFE4 · parole Pompéien clair #E98B72.')}
  {tile(horizontal('noir'), C['blanc'], 'Noir', 'Impression en une couleur : tampon, gravure, presse, documents photocopiés. Noir 100 %.')}
  {tile(horizontal('blanc'), C['pompeien'], 'Blanc', 'En réserve sur un aplat de couleur ou une photo sombre : marquage textile, objets, vitrophanie. Blanc 100 %.')}
</div>''')

# 9. Zone de protection et tailles minimales ---------------------------------------------------------
x_h = 29 / SH * 200
hz2 = horizontal('couleur'); hw2 = float(re.search(r'viewBox="0 0 ([\d.]+)', hz2).group(1))
hz2_inner = re.sub(r'^.*?</title>', '', hz2, flags=re.S).replace('</svg>\n', '')
prot = f'''<svg viewBox="{-x_h - 4:.1f} {-x_h - 4:.1f} {hw2 + 2 * x_h + 8:.1f} {200 + 2 * x_h + 8:.1f}" class="prot">
<rect x="{-x_h:.1f}" y="{-x_h:.1f}" width="{hw2 + 2 * x_h:.1f}" height="{200 + 2 * x_h:.1f}" fill="{C['ocre_brume']}" stroke="{C['ocre_fonce']}" stroke-dasharray="6 5" stroke-width="2"/>
<rect x="0" y="0" width="{hw2:.1f}" height="200" fill="{C['travertin']}"/>{hz2_inner}
<rect x="12" y="-{x_h:.1f}" width="{x_h * 1:.1f}" height="{x_h:.1f}" fill="none"/>
<g font-family="Hanken Grotesk" font-size="26" font-weight="700" fill="{C['ocre_fonce']}"><text x="{hw2 / 2:.0f}" y="{-x_h / 2 + 9:.0f}">x</text><text x="{-x_h / 2 - 7:.0f}" y="108">x</text><text x="{hw2 + x_h / 2 - 7:.0f}" y="108">x</text><text x="{hw2 / 2:.0f}" y="{200 + x_h / 2 + 9:.0f}">x</text></g>
</svg>'''
page('02 · Protection et tailles', head('02 · Zone de protection', 'De l’air autour') + f'''
<div class="cols-2">
  <div>
    <p>Laissez autour du logo une zone libre au moins égale à <strong>x</strong>, la largeur de la colonne du symbole. Aucun texte, image ou bord de page n’entre dans cette zone. Pour le logotype seul, x est la hauteur du « o ».</p>
    {prot}
  </div>
  <div>
    <p class="kicker">02 · Tailles minimales</p>
    <h2>Toujours lisible</h2>
    <p>En dessous de ces tailles, le nom ou la contreforme deviennent illisibles : passez à une autre version.</p>
    <table class="spec sizes">
      <tr><th>Version</th><th>Impression</th><th>Écran</th></tr>
      <tr><td>Horizontal</td><td>30 mm de large</td><td>110 px</td></tr>
      <tr><td>Vertical</td><td>20 mm de large</td><td>80 px</td></tr>
      <tr><td>Symbole seul</td><td>5 mm de côté</td><td>16 px</td></tr>
      <tr><td>Logotype seul</td><td>20 mm de large</td><td>72 px</td></tr>
    </table>
    <div class="minis"><div style="width:110px">{horizontal('couleur')}</div><div style="width:16px">{symbol('couleur')}</div><div style="width:72px">{logotype('couleur')}</div></div>
  </div>
</div>''')

# 10. Fonds ---------------------------------------------------------------------------------
page('02 · Les fonds', head('02 · Les fonds', 'Sur quel fond ?', 'Le logo se pose sur un aplat calme de la palette. Sur une photo, choisissez une zone sans détail et la version blanche ou négative.') + f'''
<div class="cols-3 fonds">
  {tile(horizontal('couleur'), C['travertin'], 'Travertin #F5EFE4', 'version couleur')}
  {tile(horizontal('couleur'), C['blanc'], 'Blanc #FFFFFF', 'version couleur', 'bordered')}
  {tile(horizontal('couleur'), C['travertin_soutenu'], 'Travertin soutenu #ECE3D4', 'version couleur')}
  {tile(horizontal('negatif'), C['encre'], 'Encre #221C1A', 'version négative')}
  {tile(horizontal('negatif'), C['pompeien_profond'], 'Pompéien profond #5E1D16', 'version négative')}
  {tile(horizontal('blanc'), C['pompeien'], 'Pompéien #A8372A', 'version blanche')}
</div>''')

# 11. Interdits ---------------------------------------------------------------------------------
H = horizontal('couleur')
wrong_colors = H.replace(C['pompeien'], '#0A66C2')
swapped = H.replace(f'fill="{C["encre"]}" d="{COLUMN}"', f'fill="{C["pompeien"]}" d="{COLUMN}"').replace(f'fill="{C["pompeien"]}" fill-rule', f'fill="{C["encre"]}" fill-rule').replace(f'fill="{C["pompeien"]}" d="{RAM}"', f'fill="{C["encre"]}" d="{RAM}"')
sym = symbol('couleur')
interdits = [
    (f'<div style="transform:scaleX(1.45)">{H}</div>', C['travertin'], 'Déformer, étirer, écraser'),
    (f'<div style="transform:rotate(-12deg)">{H}</div>', C['travertin'], 'Faire pivoter'),
    (wrong_colors, C['travertin'], 'Changer les couleurs (ni bleu LinkedIn, ni autre)'),
    (swapped, C['travertin'], 'Inverser la colonne et la parole'),
    (f'<div style="filter:drop-shadow(6px 8px 4px rgba(0,0,0,.45))">{H}</div>', C['travertin'], 'Ajouter une ombre, un contour, un dégradé'),
    (f'<div class="recompose"><span style="font-family:Fraunces;font-variation-settings:\'wght\' 650,\'opsz\' 144,\'SOFT\' 50;font-size:34px">Rostra</span><div style="width:70px">{sym}</div></div>', C['travertin'], 'Recomposer ou changer les proportions'),
    (f'<div class="recompose"><div style="width:44px">{sym}</div><span style="font-family:Arial;font-weight:700;font-size:34px">Rostra</span></div>', C['travertin'], 'Réécrire le nom dans une autre police'),
    (H, C['pompeien'], 'Poser sur un fond qui manque de contraste'),
]
page('02 · Les interdits', head('02 · Les interdits', 'Ne jamais modifier le logo') + '<div class="cols-4 donts">' + ''.join(
    f'<figure class="dont"><div class="tile-art" style="background:{bg}">{art}</div><figcaption><span class="x">✕</span>{label}</figcaption></figure>' for art, bg, label in interdits) + '</div>')

# 12. Couleurs principales ---------------------------------------------------------------------
page('03 · Les couleurs', head('03 · Les couleurs', 'Un rouge de fresque sur une pierre claire') + f'''
<div class="cols-4 main-sw">
  {swatch('Encre', C['encre'], 'Texte, titres, colonne du symbole, fonds sombres', True)}
  {swatch('Travertin', C['travertin'], 'Fond par défaut de tous les supports', True)}
  {swatch('Pompéien', C['pompeien'], 'Couleur principale : la parole, boutons, liens forts', True)}
  {swatch('Ocre', C['ocre'], 'Accent rare : ce qui attend une décision', True)}
</div>
<p class="kicker gap-top">Proportions indicatives sur un support</p>
<div class="prop"><span style="flex:60;background:{C['travertin']};color:{C['encre']}">Travertin 60 %</span><span style="flex:25;background:{C['encre']};color:{C['travertin']}">Encre 25 %</span><span style="flex:12;background:{C['pompeien']};color:{C['marbre']}">Pompéien 12 %</span><span style="flex:3;background:{C['ocre']}"></span></div>
<p class="small">Ocre : 3 % au plus. Le rouge pompéien et l’ocre sont les pigments des fresques de Pompéi ; le travertin, la pierre des monuments de Rome.</p>''')

# 13. Nuances -----------------------------------------------------------------------------------
page('03 · Les nuances', head('03 · Les nuances', 'La palette complète') + f'''
<div class="cols-3 nuances">
  <div><h3>Pompéien</h3>
    {chip('Pompéien foncé', C['pompeien_fonce'], 'Liens, sur-titres, survols')}
    {chip('Pompéien profond', C['pompeien_profond'], 'Fonds sombres')}
    {chip('Pompéien clair', C['pompeien_clair'], 'Parole sur fond sombre, boutons du mode sombre')}
    {chip('Pompéien brume', C['pompeien_brume'], 'Aplats légers')}
  </div>
  <div><h3>Ocre</h3>
    {chip('Ocre foncé', C['ocre_fonce'], 'Texte ocre sur fond clair, contour de focus')}
    {chip('Ocre clair', C['ocre_clair'], 'Ocre sur fond sombre')}
    {chip('Ocre brume', C['ocre_brume'], 'Statut « à valider », zones de protection')}
  </div>
  <div><h3>Neutres</h3>
    {chip('Encre douce', C['encre_douce'], 'Texte secondaire')}
    {chip('Encre brume', C['encre_brume'], 'Texte secondaire sur fond sombre')}
    {chip('Travertin soutenu', C['travertin_soutenu'], 'Sections, fond soutenu')}
    {chip('Marbre', C['marbre'], 'Cartes, champs de saisie')}
    {chip('Filet', C['filet'], 'Filets et contours')}
  </div>
</div>
<p class="small">CMJN calculés depuis le sRGB avec le profil ICC Coated FOGRA39 (papier couché), intention colorimétrique relative. Ces valeurs sont indicatives : validez-les sur épreuve avec votre imprimeur. Aucune référence Pantone n’est encore définie : choisissez-la avec l’imprimeur, sur nuancier.</p>''')

# 14. Règles et accessibilité -----------------------------------------------------------------------
pairs = [
    ('Encre sur travertin', C['encre'], C['travertin']), ('Encre douce sur travertin', C['encre_douce'], C['travertin']),
    ('Pompéien foncé sur travertin', C['pompeien_fonce'], C['travertin']), ('Pompéien sur travertin', C['pompeien'], C['travertin']),
    ('Marbre sur pompéien', C['marbre'], C['pompeien']), ('Ocre foncé sur travertin', C['ocre_fonce'], C['travertin']),
    ('Travertin sur pompéien profond', C['travertin'], C['pompeien_profond']), ('Pompéien clair sur encre', C['pompeien_clair'], C['encre']),
    ('Ocre sur travertin', C['ocre'], C['travertin']), ('Pompéien sur encre', C['pompeien'], C['encre']),
]
rows = ''.join(f'<div class="cr {"bad" if contrast(f, b) < 4.5 else ""}"><span class="aa" style="color:{f};background:{b}">Aa</span><span class="lbl">{l}</span><span class="ratio">{fmt(contrast(f, b))}:1</span><span class="ok">{"Texte" if contrast(f, b) >= 4.5 else "À éviter"}</span></div>' for l, f, b in pairs)
page('03 · Les règles', head('03 · Les règles', 'Chaque couleur a un rôle') + f'''
<div class="cols-2">
  <ol class="rules">
    <li><strong>Le pompéien porte la parole.</strong> Boutons d’action, liens, symbole, ligne de tribune. Une seule action pompéienne par écran ou par support.</li>
    <li><strong>L’ocre signale ce qui attend une décision.</strong> Statut « à valider », marqueurs, focus. Jamais en texte sur fond clair : utilisez l’ocre foncé.</li>
    <li><strong>Le travertin est le fond par défaut.</strong> Le blanc reste possible pour les documents bureautiques et l’impression sur papier blanc.</li>
    <li><strong>L’encre remplace le noir</strong> pour tous les textes. Le noir pur est réservé à la version monochrome du logo.</li>
    <li><strong>Pas de bleu de marque.</strong> Le bleu égyptien sert seulement au statut « validé » de l’interface.</li>
  </ol>
  <div>
    <p class="kicker">03 · Accessibilité</p>
    <h2>Contrastes vérifiés</h2>
    <p class="small">Le texte courant exige un contraste d’au moins 4,5:1 (WCAG niveau AA).</p>
    <div class="crs">{rows}</div>
  </div>
</div>''')

# 15. Typographie ------------------------------------------------------------------------------
CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ<br>abcdefghijklmnopqrstuvwxyz<br>0123456789 àâçéèêëîïôœùûü « » & € ? !'
page('04 · La typographie', head('04 · La typographie', 'Deux polices libres') + f'''
<div class="cols-2 typo">
  <div><div class="aa-big fr">Aa</div><h3>Fraunces</h3><p class="small">Titres, logotype, chiffres mis en avant</p>
    <p class="spec-fr">Prenez la parole.</p><p class="chars fr">{CHARS}</p>
    <p class="small">Graisse : SemiBold (600 à 650). Taille optique automatique, douceur 50, sans variante « wonky ». Approche resserrée, de −1,5 % à −3,5 % selon la taille.</p></div>
  <div><div class="aa-big hk">Aa</div><h3>Hanken Grotesk</h3><p class="small">Textes, boutons, sur-titres, légendes</p>
    <p class="spec-hk">Chaque titulaire valide ses posts en quelques secondes, sur son téléphone ; la publication est automatique.</p><p class="chars hk">{CHARS}</p>
    <p class="small">Graisses : Regular (400) pour le texte, SemiBold (600) pour les boutons et sur-titres, Bold (700) pour les libellés forts.</p></div>
</div>
<p class="small">Les deux polices sont sous licence SIL Open Font License 1.1 : gratuites, y compris pour un usage commercial. Téléchargement sur fonts.google.com. En bureautique et dans les e-mails, si elles ne sont pas installées, utilisez Georgia pour les titres et Arial ou Segoe UI pour le texte.</p>''')

# 16. Hiérarchie ------------------------------------------------------------------------------
page('04 · La hiérarchie', head('04 · La hiérarchie', 'Du sur-titre au texte') + f'''
<table class="hier">
<tr><th>Niveau</th><th>Exemple</th><th>Règle</th><th>Impression</th><th>Écran</th></tr>
<tr><td>Sur-titre</td><td><span class="ex-kicker">Posts LinkedIn · PME et agences</span></td><td>Hanken Grotesk SemiBold, capitales, interlettrage +14 %, pompéien foncé, précédé d’un filet</td><td>7–8 pt</td><td>13 px</td></tr>
<tr><td>Titre 1</td><td><span class="ex-h1">Prenez la parole.</span></td><td>Fraunces SemiBold, interligne 1,02, approche −3 %</td><td>40–72 pt</td><td>37–68 px</td></tr>
<tr><td>Titre 2</td><td><span class="ex-h2">Comment ça marche</span></td><td>Fraunces SemiBold, interligne 1,08, approche −2,5 %</td><td>24–36 pt</td><td>26–37 px</td></tr>
<tr><td>Titre 3</td><td><span class="ex-h3">Validation en un clic</span></td><td>Hanken Grotesk Bold, interligne 1,3</td><td>11–13 pt</td><td>17 px</td></tr>
<tr><td>Chapô</td><td><span class="ex-lead">L’IA rédige, chacun valide, tout part à l’heure.</span></td><td>Hanken Grotesk Regular, encre douce, interligne 1,6</td><td>11–13 pt</td><td>18 px</td></tr>
<tr><td>Texte courant</td><td><span class="ex-body">Rien ne part sans l’accord du titulaire.</span></td><td>Hanken Grotesk Regular, encre, interligne 1,55</td><td>9,5–11 pt</td><td>16 px</td></tr>
<tr><td>Bouton</td><td><span class="ex-btn">Essai gratuit</span></td><td>Hanken Grotesk SemiBold, fond pompéien, texte marbre, rayon 8 px</td><td>9–10 pt</td><td>16 px</td></tr>
</table>''')

# 17. Éléments graphiques ------------------------------------------------------------------------
def symbol_group_svg():
    h = 120
    return svg(SW / SH * h, h, symbol_group({'column': '#E6DBC9', 'speech': '#E9D6C4', 'name': ''}, 0, 0, h))


page('05 · Les éléments graphiques', head('05 · Les éléments graphiques', 'Un vocabulaire réduit') + f'''
<div class="cols-3 elements">
  <div><div class="el-art roman"><span>I</span><span>II</span><span>III</span><span>IV</span></div><h3>Les chiffres romains</h3><p>Ils numérotent les étapes et les parties, en Fraunces, couleur pompéien. Jamais au-delà de X.</p></div>
  <div><div class="el-art col"><div class="tribune"></div><p class="tribune-txt">Prenez la parole.</p></div><h3>La ligne de tribune</h3><p>Un filet pompéien épais et court qui annonce une phrase clé. Une fois par support au plus.</p></div>
  <div><div class="el-art"><span class="ex-kicker">Comment ça marche</span></div><h3>Le sur-titre</h3><p>Un filet fin suivi de capitales espacées, en pompéien foncé, au-dessus des titres de section.</p></div>
  <div><div class="el-art"><span class="ex-btn">Valider</span><span class="ex-btn ghost">Corriger</span></div><h3>Les boutons</h3><p>Rayon 8 px, hauteur 44 px au moins. Pompéien plein pour l’action principale, contour filet pour les autres.</p></div>
  <div><div class="el-art"><div class="mini-card"><span></span><span></span><span></span></div></div><h3>Les cartes</h3><p>Fond marbre, filet de 1 px, rayon 10 px. Ombre très douce seulement pour une carte d’illustration. Jamais de dégradé.</p></div>
  <div><div class="el-art filigrane">{symbol_group_svg()}</div><h3>Le symbole en filigrane</h3><p>Agrandi et recadré, ton sur ton sur le travertin, il habille une image de partage ou une couverture. Jamais derrière du texte courant.</p></div>
</div>''')

# 18. Interface -------------------------------------------------------------------------------
page('05 · L’interface', head('05 · L’interface', 'Les couleurs au travail', 'Dans l’application, chaque statut d’un post a sa couleur. Le libellé est toujours écrit : la couleur aide, elle ne remplace pas le mot.') + f'''
<div class="cols-2">
  <div>
    <div class="statuses">
      <div><span class="st" style="background:{C['ocre_brume']};color:#5E3F0C">À valider</span><span>Ocre brume · texte #5E3F0C</span></div>
      <div><span class="st" style="background:#E1EAF3;color:#22476B">Validé</span><span>Bleu égyptien brume #E1EAF3 · texte #22476B</span></div>
      <div><span class="st" style="background:#E3EEE6;color:#2F5D45">Publié</span><span>Vert-de-gris brume #E3EEE6 · texte #2F5D45</span></div>
      <div><span class="st" style="background:#F7DEDB;color:#8A1C1C">Erreur</span><span>Rouge alerte brume #F7DEDB · texte #8A1C1C</span></div>
    </div>
    <p class="gap-top">Le marqueur <span class="marker">[À COMPLÉTER : chiffre]</span> surligne une information que l’IA n’a pas inventée et qui bloque la publication : fond #F3D98F, texte #4A3500.</p>
    <p class="small">Le bleu égyptien, premier pigment de synthèse, était connu des peintres romains. Il reste réservé à ce statut.</p>
  </div>
  <div>
    <h3>Mode sombre</h3>
    <div class="dark-demo">
      <div class="dd-logo">{horizontal('negatif')}</div>
      <p>Fond #1A1614, cartes #241E1B, texte travertin, actions pompéien clair #E98B72 avec texte encre (6,7:1).</p>
      <span class="ex-btn dark">Valider</span>
    </div>
  </div>
</div>''')

# 19. Le ton ---------------------------------------------------------------------------------
page('06 · Le ton', head('06 · Le ton', 'Écrire comme Rostra') + '''
<div class="cols-4 tone">
  <div><h3>Vouvoyer</h3><p>On s’adresse au dirigeant, à l’expert, au chargé de communication : avec respect, sans distance.</p></div>
  <div><h3>Aller droit au but</h3><p>Phrases courtes, une idée par phrase, le verbe d’action en premier.</p></div>
  <div><h3>Rendre la main</h3><p>L’IA propose, la personne décide. On ne promet jamais de « parler à sa place ».</p></div>
  <div><h3>Rester vrai</h3><p>Aucun chiffre, témoignage, logo client ou certification sans preuve.</p></div>
</div>
<div class="cols-2 gap-top">
  <div class="quote good"><p class="kicker">Plutôt</p><p>« Chaque lundi, vos posts de la semaine vous attendent. Vous les validez en un clic ; ils partent à l’heure prévue. »</p></div>
  <div class="quote bad"><p class="kicker">Plutôt que</p><p>« Boostez votre personal branding grâce à notre IA révolutionnaire qui génère du contenu viral à votre place ! »</p></div>
</div>
<div class="cols-2 gap-top">
  <div><h3>Les mots de la marque</h3><p class="words"><span>prendre la parole</span><span>titulaire</span><span>valider</span><span>publier à l’heure</span><span>ligne éditoriale</span><span>dans le ton de chacun</span><span>rien ne part sans accord</span><span>Prenez la parole.</span></p></div>
  <div><h3>Règles d’écriture</h3><ul class="small-list">
    <li>« Rostra » avec une majuscule, sans article (« Rostra rédige », pas « le Rostra »).</li>
    <li>« LinkedIn » tel quel ; jamais de « Linked » ou « In » dans un nom de produit.</li>
    <li>Majuscules accentuées : À, É. Chiffres en chiffres : 2 semaines, 14 jours.</li>
    <li>Espace insécable avant : ; ? ! % et à l’intérieur des guillemets « ».</li>
    <li>La signature garde toujours son point final : Prenez la parole.</li>
  </ul></div>
</div>''')

# 20-21. Exemples ---------------------------------------------------------------------------------
cap = lambda n: (CAPTURES / n).as_uri()
page('07 · Exemples d’application', head('07 · Exemples d’application', 'Le site') + f'''
<div class="site-ex">
  <figure class="shot desk"><img src="{cap('site-ordinateur.png')}"><figcaption>Accueil du site, sur ordinateur : en-tête travertin, titre en Fraunces, une seule action pompéienne.</figcaption></figure>
  <figure class="shot phone"><img src="{cap('site-telephone.png')}"><figcaption>Sur téléphone</figcaption></figure>
  <figure class="shot desk dark"><img src="{cap('site-sombre.png')}"><figcaption>Mode sombre : version négative du logo, pompéien clair.</figcaption></figure>
</div>''')

avatar = svg(300, 300, f'<rect width="300" height="300" fill="{C["travertin"]}"/>' + symbol_group(COLORS['couleur'], (300 - 138 * SW / SH) / 2 + 3, (300 - 138) / 2, 138))
page('07 · Exemples d’application', head('07 · Exemples d’application', 'La marque en situation') + f'''
<div class="apps">
  <figure class="f-og"><img class="og" src="{(APP / 'opengraph-image.png').as_uri()}"><figcaption><strong>Image de partage</strong> 1200 × 630 px, affichée quand un lien du site est partagé sur LinkedIn ou dans une messagerie.</figcaption></figure>
  <figure class="f-av"><div class="avatars"><div class="round">{avatar}</div><div class="fav"><img src="{(APP / 'apple-icon.png').as_uri()}"><span>Icône d’écran d’accueil</span></div></div><figcaption><strong>Page LinkedIn et icônes</strong> Avatar 1080 px recadré en rond ; favicon et icône d’application en symbole blanc sur pompéien.</figcaption></figure>
  <figure class="f-mail"><div class="mail">
      <p>Bonjour Claire,</p><p>Votre post de mardi vous attend. Il part à 8 h 30 si vous le validez.</p>
      <p><span class="ex-btn">Voir le post</span></p>
      <hr><div class="mail-sig"><div style="width:130px">{horizontal('couleur')}</div><span>Prenez la parole.</span></div>
    </div><figcaption><strong>E-mail</strong> Arial dans les messageries, bouton pompéien, logo en PNG 320 px affiché à 160 px.</figcaption></figure>
</div>''')

# 22. Fichiers ---------------------------------------------------------------------------------
page('08 · Les fichiers fournis', head('08 · Les fichiers fournis', 'Où trouver quoi') + '''
<div class="cols-2">
  <div>
<pre class="tree">Rostra/
├─ Charte graphique Rostra.pdf
└─ Logos/
   ├─ 1. Horizontal/
   ├─ 2. Vertical/
   ├─ 3. Symbole seul (sans texte)/
   ├─ 4. Logotype seul (texte seul)/
   │     chacun avec PNG/ · JPEG/ · SVG/
   └─ 5. Réseaux sociaux/   avatars 1080 px</pre>
    <p class="small">Nom des fichiers : <strong>rostra_version_couleur_largeur.ext</strong>, par exemple rostra_horizontal_couleur_3000px.png. Couleurs : couleur, negatif (fond sombre), noir, blanc.</p>
    <h3 class="gap-top">Les polices</h3><p class="small">Fraunces et Hanken Grotesk ne sont pas incluses dans ce dossier : téléchargez-les gratuitement sur fonts.google.com et installez-les avant de créer un support.</p>
    <h3 class="gap-top">Le site</h3><p class="small">Les fichiers propres au site (composant du logo, favicon, icône, image de partage, polices en woff2) et les couleurs en variables CSS sont dans le dépôt de l’application ; les outils qui ont produit cette charte et les logos sont dans docs/marque.</p>
  </div>
  <div>
    <p class="kicker">08 · Quel format choisir ?</p>
    <div class="formats">
      <div><h3>PNG</h3><span>fond transparent</span><p>Site web, PowerPoint, Canva, réseaux sociaux. Deux tailles : HD (2000 à 3000 px) pour l’impression bureautique et les présentations, web (512 à 800 px) pour les e-mails et les pages.</p></div>
      <div><h3>JPEG</h3><span>fond plein</span><p>Word, envoi rapide, outils qui gèrent mal la transparence. Fond blanc pour les versions couleur et noire, encre pour la négative, pompéien pour la blanche. La zone de protection est déjà incluse.</p></div>
      <div><h3>SVG</h3><span>vectoriel</span><p>Imprimeur, signalétique, grands formats, intégration web. Se redimensionne sans perte. Pour un PDF ou un EPS, l’imprimeur peut le convertir depuis le SVG.</p></div>
    </div>
    <p class="tip">Dans le doute, prenez le PNG HD de la version horizontale couleur.</p>
  </div>
</div>''')

# Dos ---------------------------------------------------------------------------------------
page('', f'''<div class="back"><div class="back-logo">{vertical('negatif')}</div><p class="sig">Prenez la parole.</p><p class="meta">Rostra · un service édité par SimplX</p></div>''', cls='p-back', bare=True)


# --- Rendu ---------------------------------------------------------------------------------
CSS = f'''
@font-face{{font-family:'Fraunces';src:url({(POLICES / 'Fraunces.ttf').as_uri()})}}
@font-face{{font-family:'Hanken Grotesk';src:url({(POLICES / 'HankenGrotesk.ttf').as_uri()})}}
@page{{size:297mm 210mm;margin:0}}
*{{box-sizing:border-box}}
html,body{{margin:0;background:#888}}
body{{font-family:'Hanken Grotesk';color:{C['encre']};font-size:10.5pt;line-height:1.5}}
.page{{width:297mm;height:210mm;background:{C['travertin']};position:relative;overflow:hidden;padding:20mm 18mm 16mm;page-break-after:always;break-after:page}}
.run{{position:absolute;left:18mm;right:18mm;top:8mm;display:flex;justify-content:space-between;font-size:7.5pt;letter-spacing:.12em;text-transform:uppercase;color:{C['encre_douce']}}}
.run strong{{color:{C['encre']}}}
.foot{{position:absolute;left:18mm;right:18mm;bottom:7mm;display:flex;justify-content:space-between;font-size:7.5pt;color:{C['encre_douce']}}}
.kicker{{display:flex;align-items:center;gap:8px;margin:0 0 4mm;font-size:7.5pt;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:{C['pompeien_fonce']}}}
.kicker::before{{content:'';width:22px;height:1.5px;background:currentColor}}
h1,h2,.display{{font-family:'Fraunces';font-variation-settings:'wght' 620,'SOFT' 50;font-weight:600;letter-spacing:-.025em;line-height:1.02;margin:0 0 5mm}}
h1{{font-size:30pt}} h2{{font-size:20pt}}
h3{{font-size:10.5pt;margin:0 0 2mm;font-weight:700}}
p{{margin:0 0 3mm}}
.intro{{font-size:11.5pt;color:{C['encre_douce']};max-width:170mm;margin-bottom:7mm}}
.lead{{font-size:12.5pt;line-height:1.5}}
.small{{font-size:8.5pt;color:{C['encre_douce']}}}
.gap-top{{margin-top:6mm}}
em{{font-style:italic}}
svg{{display:block;max-width:100%;height:auto}}
.cols-2{{display:grid;grid-template-columns:1fr 1fr;gap:12mm}}
.cols-3{{display:grid;grid-template-columns:repeat(3,1fr);gap:8mm}}
.cols-4{{display:grid;grid-template-columns:repeat(4,1fr);gap:6mm}}
.num{{font-family:'Fraunces';font-variation-settings:'wght' 620,'SOFT' 50;font-size:22pt;color:{C['pompeien']};line-height:1;display:block;margin-bottom:3mm}}
/* couverture */
.p-cover{{padding:0}}
.cover{{position:absolute;inset:0}}
.cover-logo{{position:absolute;left:22mm;top:20mm;width:62mm}}
.cover-text{{position:absolute;left:22mm;top:66mm;width:150mm}}
.display{{font-size:62pt;margin-bottom:8mm}}
.cover .intro{{font-size:13pt}}
.cover .meta{{position:absolute;top:110mm;font-size:9pt;color:{C['encre_douce']}}}
.cover-symbol{{position:absolute;right:-18mm;bottom:-22mm;width:160mm;opacity:1}}
/* sommaire */
.toc{{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:1fr 1fr;gap:0 14mm}}
.toc li{{display:grid;grid-template-columns:12mm 1fr 14mm;align-items:baseline;padding:3.2mm 0;border-top:1px solid {C['filet']}}}
.toc .n{{font-family:'Fraunces';font-size:14pt;color:{C['pompeien']}}}
.toc .t strong{{display:block;font-size:11pt}} .toc .t span{{font-size:8.5pt;color:{C['encre_douce']}}}
.toc .p{{text-align:right;font-size:8.5pt;color:{C['encre_douce']}}}
/* marque */
.facts{{display:grid;gap:3mm;margin-top:6mm}}
.facts div{{display:grid;grid-template-columns:30mm 1fr;border-top:1px solid {C['filet']};padding-top:2.5mm}}
.facts strong{{font-size:8pt;text-transform:uppercase;letter-spacing:.1em;color:{C['pompeien_fonce']}}}
.sig{{font-family:'Fraunces';font-variation-settings:'wght' 620,'SOFT' 50;font-size:16pt;letter-spacing:-.01em}}
.story{{position:relative;background:{C['marbre']};border:1px solid {C['filet']};border-radius:10px;padding:8mm;min-height:120mm}}
.story-row{{display:grid;grid-template-columns:16mm 1fr;margin-bottom:6mm}}
.story-row strong{{display:block}} .story-row span:not(.num){{font-size:9pt;color:{C['encre_douce']}}}
.story-symbol{{position:absolute;right:8mm;bottom:8mm;width:40mm}}
.traits > div{{border-top:2px solid {C['encre']};padding-top:4mm}}
.note{{background:{C['marbre']};border:1px solid {C['filet']};border-radius:10px;padding:6mm}}
.note.avoid ul{{margin:0;padding-left:5mm;font-size:9pt}} .note.avoid li{{margin-bottom:1.2mm}}
/* logo */
.anat-wrap{{display:grid;place-items:center;background:{C['marbre']};border:1px solid {C['filet']};border-radius:10px;padding:10mm}}
.anat{{width:85mm}}
.legend-list{{list-style:none;padding:0;margin:0 0 4mm}}
.legend-list li{{display:grid;grid-template-columns:10mm 1fr;margin-bottom:3.5mm}}
.legend-list .n{{width:7mm;height:7mm;border-radius:50%;background:{C['encre']};color:{C['travertin']};display:grid;place-items:center;font-weight:700;font-size:8.5pt}}
.legend-list strong{{display:block}} .legend-list span{{font-size:9pt;color:{C['encre_douce']}}}
.logotype-demo{{width:62mm;margin:6mm 0 3mm}}
.cons{{width:118mm}} .hz-cons{{width:120mm;margin:2mm 0}}
.spec{{border-collapse:collapse;width:100%;font-size:9pt}}
.spec th,.spec td{{text-align:left;padding:1.6mm 2mm;border-top:1px solid {C['filet']}}}
.spec th{{color:{C['pompeien_fonce']};font-weight:600;width:32mm}}
.sizes th{{width:auto}}
/* tuiles */
.tile{{margin:0;display:flex;flex-direction:column;gap:3mm}}
.tile-art{{border-radius:10px;height:44mm;display:grid;place-items:center;padding:8mm}}
.tile-art svg{{max-height:26mm;width:auto;max-width:100%}}
.tile.tall .tile-art svg{{max-height:32mm}}
.tile.bordered .tile-art{{border:1px solid {C['filet']}}}
.tile figcaption strong{{display:block;font-size:10pt}} .tile figcaption span{{font-size:8.5pt;color:{C['encre_douce']}}}
.versions .tile-art{{height:62mm;background:{C['marbre']}!important;border:1px solid {C['filet']}}}
.decl{{gap:7mm 10mm}} .decl .tile-art{{height:40mm}} .decl .tile-art svg{{max-height:20mm}}
.fonds{{gap:6mm}} .fonds .tile-art{{height:36mm}} .fonds .tile-art svg{{max-height:16mm}}
.prot{{width:120mm;margin-top:4mm}}
.minis{{display:flex;align-items:center;gap:10mm;margin-top:6mm}}
.donts{{gap:6mm 6mm}}
.dont{{margin:0}} .dont .tile-art{{height:36mm;padding:6mm;overflow:hidden}} .dont .tile-art svg{{max-height:16mm}}
.dont .tile-art > div{{width:80%}}
.dont figcaption{{display:flex;gap:2mm;align-items:flex-start;font-size:8.5pt;margin-top:2.5mm}}
.dont .x{{color:{C['pompeien']};font-weight:700}}
.recompose{{display:flex!important;align-items:center;gap:10px;width:auto!important}}
/* couleurs */
.sw{{border-radius:10px;padding:5mm;height:88mm;display:flex;flex-direction:column;border:1px solid rgba(0,0,0,.06)}}
.sw strong{{font-family:'Fraunces';font-variation-settings:'wght' 620,'SOFT' 50;font-size:18pt;font-weight:600}}
.sw .role{{font-size:9pt;margin-top:1mm;opacity:.9}}
.sw .codes{{margin-top:auto;font-size:8.5pt;line-height:1.6}}
.prop{{display:flex;height:12mm;border-radius:8px;overflow:hidden;border:1px solid {C['filet']};font-size:8.5pt;font-weight:600}}
.prop span{{display:flex;align-items:center;padding-left:3mm}}
.nuances h3{{border-top:2px solid {C['encre']};padding-top:3mm}}
.chip{{display:grid;grid-template-columns:12mm 1fr;gap:3mm;margin-bottom:3mm}}
.chip .dot{{width:12mm;height:12mm;border-radius:8px;border:1px solid rgba(0,0,0,.08)}}
.chip strong{{display:block;font-size:9pt}} .chip span{{display:block;font-size:8pt;color:{C['encre_douce']}}} .chip small{{display:block;font-size:7pt;color:{C['encre_douce']};line-height:1.4}}
.rules{{padding-left:5mm;margin:0}} .rules li{{margin-bottom:3.5mm;font-size:9.5pt}}
.crs{{display:grid;gap:1.6mm}}
.cr{{display:grid;grid-template-columns:14mm 1fr 18mm 16mm;align-items:center;gap:3mm;font-size:8.5pt}}
.cr .aa{{font-family:'Fraunces';font-size:12pt;text-align:center;border-radius:6px;padding:1mm 0;border:1px solid rgba(0,0,0,.06)}}
.cr .ratio{{font-weight:700;text-align:right}}
.cr.bad .ok{{color:{C['pompeien']};font-weight:600}}
/* typo */
.aa-big{{font-size:64pt;line-height:1;margin-bottom:2mm}}
.fr{{font-family:'Fraunces';font-variation-settings:'wght' 620,'SOFT' 50}}
.hk{{font-family:'Hanken Grotesk'}}
.spec-fr{{font-family:'Fraunces';font-variation-settings:'wght' 620,'SOFT' 50;font-size:24pt;letter-spacing:-.02em;margin:3mm 0}}
.spec-hk{{font-size:12pt;margin:3mm 0}}
.chars{{font-size:10pt;line-height:1.5;color:{C['encre_douce']}}}
.hier{{width:100%;border-collapse:collapse;font-size:8.5pt}}
.hier th{{text-align:left;font-size:7.5pt;text-transform:uppercase;letter-spacing:.1em;color:{C['encre_douce']};padding:2mm}}
.hier td{{border-top:1px solid {C['filet']};padding:2.4mm 2mm;vertical-align:middle}}
.hier td:first-child{{font-weight:700;width:24mm}} .hier td:nth-child(2){{width:100mm}}
.ex-kicker{{display:inline-flex;align-items:center;gap:8px;font-size:8pt;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:{C['pompeien_fonce']}}}
.ex-kicker::before{{content:'';width:22px;height:1.5px;background:currentColor}}
.ex-h1{{font-family:'Fraunces';font-variation-settings:'wght' 620,'SOFT' 50;font-size:26pt;letter-spacing:-.03em;line-height:1}}
.ex-h2{{font-family:'Fraunces';font-variation-settings:'wght' 620,'SOFT' 50;font-size:18pt;letter-spacing:-.025em}}
.ex-h3{{font-weight:700;font-size:11pt}} .ex-lead{{font-size:11pt;color:{C['encre_douce']}}} .ex-body{{font-size:10pt}}
.ex-btn{{display:inline-block;background:{C['pompeien']};color:{C['marbre']};font-weight:600;padding:2.2mm 5mm;border-radius:8px;font-size:9.5pt}}
.ex-btn.ghost{{background:{C['marbre']};color:{C['encre']};border:1px solid {C['filet']};margin-left:2mm}}
.ex-btn.dark{{background:{C['pompeien_clair']};color:{C['encre']}}}
/* éléments */
.elements{{gap:7mm 9mm}}
.el-art{{height:28mm;background:{C['marbre']};border:1px solid {C['filet']};border-radius:10px;display:flex;align-items:center;justify-content:center;gap:5mm;margin-bottom:3mm;overflow:hidden;position:relative}}
.el-art.col{{flex-direction:column;align-items:flex-start;justify-content:center;padding:0 8mm;gap:2mm}}
.roman span{{font-family:'Fraunces';font-variation-settings:'wght' 620,'SOFT' 50;font-size:20pt;color:{C['pompeien']}}}
.tribune{{width:14mm;height:1.2mm;background:{C['pompeien']}}}
.tribune-txt{{font-family:'Fraunces';font-variation-settings:'wght' 620,'SOFT' 50;font-size:14pt;margin:0}}
.mini-card{{width:48mm;background:{C['marbre']};border:1px solid {C['filet']};border-radius:8px;padding:3mm;display:grid;gap:1.6mm;box-shadow:0 10px 20px -14px rgba(34,28,26,.5)}}
.mini-card span{{height:2mm;border-radius:2mm;background:{C['travertin_soutenu']}}} .mini-card span:nth-child(3){{width:60%}}
.filigrane{{background:{C['travertin']}}} .filigrane svg{{position:absolute;right:-6mm;bottom:-10mm;width:40mm}}
.elements p{{font-size:9pt;color:{C['encre_douce']}}}
.statuses{{display:grid;gap:3mm}}
.statuses div{{display:grid;grid-template-columns:30mm 1fr;align-items:center;font-size:8.5pt;color:{C['encre_douce']}}}
.st{{display:inline-block;font-weight:700;font-size:8.5pt;padding:1mm 3.5mm;border-radius:99px;justify-self:start}}
.marker{{background:#F3D98F;color:#4A3500;font-weight:600;padding:0 1mm;border-radius:3px}}
.dark-demo{{background:#1A1614;color:{C['travertin']};border-radius:10px;padding:7mm}}
.dark-demo .dd-logo{{width:50mm;margin-bottom:5mm}}
.dark-demo p{{font-size:9pt;color:{C['encre_brume']}}}
/* ton */
.tone > div{{border-top:2px solid {C['encre']};padding-top:3mm}} .tone p{{font-size:9pt;color:{C['encre_douce']}}}
.quote{{border-radius:10px;padding:5mm 6mm;font-size:10.5pt}}
.quote.good{{background:{C['marbre']};border:1px solid {C['filet']}}}
.quote.bad{{background:{C['travertin_soutenu']};color:{C['encre_douce']}}}
.quote.bad .kicker{{color:{C['encre_douce']}}}
.words{{display:flex;flex-wrap:wrap;gap:2mm}}
.words span{{border:1px solid {C['filet']};background:{C['marbre']};border-radius:99px;padding:.8mm 3mm;font-size:8.5pt}}
.small-list{{margin:0;padding-left:5mm;font-size:8.5pt}} .small-list li{{margin-bottom:1mm}}
/* exemples */
.site-ex{{display:grid;grid-template-columns:1.6fr .62fr 1.6fr;gap:6mm;align-items:start}}
.shot{{margin:0}} .shot img{{width:100%;display:block;border-radius:8px;border:1px solid {C['filet']};box-shadow:0 14px 28px -20px rgba(34,28,26,.55)}}
.shot figcaption{{font-size:8pt;color:{C['encre_douce']};margin-top:2mm}}
.shot.phone img{{border-radius:14px}}
.apps{{display:grid;grid-template-columns:1.25fr 1fr;grid-template-areas:'og mail' 'av mail';gap:8mm 12mm;align-items:start}}
.apps figure.f-og{{grid-area:og}} .apps figure.f-av{{grid-area:av}} .apps figure.f-mail{{grid-area:mail}}
.apps figure{{margin:0}} .apps figcaption{{font-size:8.5pt;color:{C['encre_douce']};margin-top:3mm}} .apps figcaption strong{{display:block;color:{C['encre']}}}
.apps img.og{{width:100%;border-radius:8px;border:1px solid {C['filet']}}}
.avatars{{display:flex;align-items:center;gap:8mm;height:44mm}}
.round{{width:38mm;height:38mm;border-radius:50%;overflow:hidden;border:1px solid {C['filet']}}}
.fav{{display:flex;flex-direction:column;align-items:center;gap:2mm;font-size:7.5pt;color:{C['encre_douce']}}}
.fav img{{width:16mm;border-radius:3.6mm}}
.mail{{background:#fff;border:1px solid {C['filet']};border-radius:8px;padding:8mm;font-family:Arial;font-size:10pt;min-height:96mm}}
.mail .ex-btn{{font-family:Arial}}
.mail hr{{border:none;border-top:1px solid {C['filet']};margin:3mm 0}}
.mail-sig{{display:flex;align-items:center;justify-content:space-between;font-family:Georgia;font-size:10pt;color:{C['encre_douce']};margin-top:6mm}}
/* fichiers */
.tree{{font-family:Consolas,monospace;font-size:9pt;background:{C['marbre']};border:1px solid {C['filet']};border-radius:8px;padding:5mm;margin:0 0 4mm}}
.formats{{display:grid;gap:4mm}}
.formats div{{border-top:2px solid {C['encre']};padding-top:2.5mm}}
.formats h3{{display:inline;margin-right:2mm}} .formats span{{font-size:8pt;color:{C['pompeien_fonce']}}} .formats p{{font-size:8.5pt;color:{C['encre_douce']};margin-top:1mm}}
.tip{{font-weight:600;margin-top:4mm}}
/* dos */
.p-back{{background:{C['encre']}}}
.back{{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;color:{C['travertin']}}}
.back-logo{{width:52mm;margin-bottom:12mm}}
.back .meta{{font-size:9pt;color:{C['encre_brume']}}}
'''


def nbsp(text):
    """Espaces fines insécables de la typographie française, dans le texte seulement."""
    def fix(m):
        t = m.group(1)
        t = re.sub(r' ([:;?!%»])', '\u202f\\1', t)
        t = t.replace('« ', '«\u202f')
        return '>' + t + '<'
    return re.sub(r'>([^<]+)<', fix, text)


def build():
    total = len(pages)
    out = []
    for i, (section, body, cls, bare) in enumerate(pages, start=1):
        chrome = '' if bare else (f'<div class="run"><span><strong>Rostra</strong> · Charte graphique</span><span>{html.escape(section)}</span></div>'
                                  f'<div class="foot"><span>{VERSION}</span><span>{i:02d} / {total}</span></div>')
        out.append(f'<section class="page {cls}">{chrome}{body}</section>')
    doc = f'<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Charte graphique Rostra</title><style>{CSS}</style></head><body>{nbsp("".join(out))}</body></html>'
    OUT.mkdir(parents=True, exist_ok=True)
    src = SORTIE / 'charte.html'
    src.write_text(doc, encoding='utf-8', newline='\n')
    pdf = OUT / 'Charte graphique Rostra.pdf'
    with sync_playwright() as p:
        b = p.chromium.launch(channel='chrome')
        pg = b.new_page()
        pg.goto(src.as_uri(), wait_until='load'); pg.wait_for_timeout(800)
        pg.pdf(path=str(pdf), prefer_css_page_size=True, print_background=True)
        # Aperçus PNG de chaque page, pour relecture.
        pg.set_viewport_size({'width': 1123, 'height': 794})
        prev = SORTIE / 'apercus'; prev.mkdir(exist_ok=True)
        for k in range(total):
            pg.locator('section.page').nth(k).screenshot(path=str(prev / f'page-{k + 1:02d}.png'))
        b.close()
    print(f'{total} pages -> {pdf}')


if __name__ == '__main__':
    build()
