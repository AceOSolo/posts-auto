"""Génère la charte graphique Rostra (PDF A4 paysage) dans docs/marque/sortie/Rostra/.

Usage : python charte.py
Prérequis : exporter_logos.py, exporter_illustrations.py, exporter_site.py, et des captures du site dans
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
from geom import R_BIG, R_SMALL, TILE, UNIT, tiles

HERE = pathlib.Path(__file__).parent
SORTIE = HERE.parent / 'sortie'
OUT = SORTIE / 'Rostra'
POLICES = HERE.parent / 'polices'
CAPTURES = SORTIE / 'captures'
ILLUS = OUT / 'Illustrations'
APP = HERE.parents[2] / 'apps' / 'web' / 'src' / 'app'
VERSION = 'Version 1.0 · novembre 2026'
FOGRA39 = pathlib.Path(r'C:\Windows\System32\spool\drivers\color\CoatedFOGRA39.icc')

C = dict(
    rose='#DF1C60', soleil='#FFC93C', vert='#2BB59A', nuit='#1E1A45', marbre='#FFF4E2', blanc='#FFFFFF',
    rose_fonce='#B0154C', rose_clair='#FF7FA6', rose_brume='#FFE0EA',
    soleil_brume='#FFF0C7', vert_fonce='#13715F', vert_brume='#D7F2EA',
    nuit_douce='#4D4870', joint='#3A3560', lavande='#E7E4F7', marbre_soutenu='#FBEBD0', filet='#EADCC3',
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
    h = hexa.lstrip('#'); rgb_ = tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
    px = ImageCms.applyTransform(Image.new('RGB', (1, 1), rgb_), _transform).getpixel((0, 0))
    return ' · '.join(str(round(v / 255 * 100)) for v in px)


def rgb(hexa):
    h = hexa.lstrip('#'); return ' · '.join(str(int(h[i:i + 2], 16)) for i in (0, 2, 4))


def fmt(x):
    return f'{x:.1f}'.replace('.', ',')


def uri(path):
    return path.as_uri()


def ill(name):
    return (ILLUS / f'{name}.svg').read_text(encoding='utf-8')


def svg_inner(svg_text):
    return re.sub(r'^.*?</title>', '', svg_text, flags=re.S).replace('</svg>\n', '')


def svg_width(svg_text):
    return float(re.search(r'viewBox="0 0 ([\d.]+)', svg_text).group(1))


# --- Pages ----------------------------------------------------------------------------------
pages = []


def page(section, body, cls='', bare=False):
    pages.append((section, body, cls, bare))


def title(t, intro=''):
    return f'<h1>{t}</h1>' + (f'<p class="intro">{intro}</p>' if intro else '')


def divider(num, name, sub, bg, fg, picto):
    page('', f'''<div class="div-wrap" style="background:{bg};color:{fg}">
  <div class="div-num">{num}</div><div class="div-name">{name}</div><p class="div-sub">{sub}</p>
  <div class="div-picto">{ill(picto)}</div></div>''', cls='p-div', bare=True)


def card(svg_text, bg, label, sub='', cls=''):
    return f'<figure class="card {cls}"><div class="art" style="background:{bg}">{svg_text}</div><figcaption><strong>{label}</strong>{f"<span>{sub}</span>" if sub else ""}</figcaption></figure>'


def frise(colors, angles, cls):
    return f'<div class="{cls}">' + ''.join(f'<span style="background:{c};transform:rotate({a}deg)"></span>' for c, a in zip(colors, angles)) + '</div>'


ANGLES = [3, -4, 2, -2, 5, -3, 1, 4, -5, 2, -1, 3, -3, 4, -2, 1, 2, -3, 4, -1, 3, -4, 2, -2]

# 1. Couverture -------------------------------------------------------------------------------
page('', f'''<div class="cover">
  <div class="cover-logo">{horizontal('negatif')}</div>
  <h1 class="cover-title">Charte<br>graphique</h1>
  <p class="cover-sub">Logo, couleurs, lettres, mosaïque et ton de la marque Rostra.</p>
  <p class="hand cover-note">version 1.0 · novembre 2026</p>
  <div class="cover-bust">{ill('buste-mosaique')}</div>
  <p class="cover-meta">Rostra, un service édité par SimplX</p>
</div>''', cls='p-cover', bare=True)

# 2. Au programme -----------------------------------------------------------------------------
PROG = [
    ('01', 'L’histoire', 'D’où vient le nom, notre caractère', C['rose'], C['blanc'], 3),
    ('02', 'Le logo', 'La bulle en tesselles, versions, règles', C['soleil'], C['nuit'], 6),
    ('03', 'Les couleurs', 'Cinq couleurs de mosaïque, contrastes', C['vert'], C['nuit'], 14),
    ('04', 'Les lettres', 'Bagel Fat One, Schibsted Grotesk, Caveat', C['nuit'], C['marbre'], 18),
    ('05', 'La mosaïque', 'Notre matière, ses règles, son outil', C['rose'], C['blanc'], 21),
    ('06', 'Le ton', 'Écrire comme Rostra', C['soleil'], C['nuit'], 26),
    ('07', 'En situation', 'Site, partages, réseaux, e-mail', C['vert'], C['nuit'], 28),
    ('08', 'Les fichiers', 'Où trouver quoi, quel format choisir', C['blanc'], C['nuit'], 31),
]
page('Au programme', title('Au programme', 'Cette charte fixe les règles de l’identité Rostra. Elle s’adresse à toute personne qui crée un support : équipe, prestataire, imprimeur, partenaire, agence cliente.') +
     '<div class="prog">' + ''.join(f'<div class="prog-tile" style="background:{bg};color:{fg};transform:rotate({rot}deg)"><span class="pn">{n}</span><strong>{t}</strong><span class="pd">{d}</span><span class="pp">page {p}</span></div>'
                                   for (n, t, d, bg, fg, p), rot in zip(PROG, [-1.2, 0.8, -0.6, 1.1, -0.9, 0.7, -1, 0.9])) + '</div>')

# 01 L'histoire -------------------------------------------------------------------------------
divider('01', 'L’histoire', 'D’où vient Rostra, et comment la marque se tient.', C['rose'], C['blanc'], 'etape-redaction')

page('01 · L’histoire', title('D’où vient Rostra') + f'''
<div class="cols-2">
  <div>
    <p class="lead">En 338 av. J.-C., après la bataille d’Antium, les Romains fixent les éperons de bronze des navires pris à l’ennemi sur la tribune du Forum. Ces éperons s’appellent <em>rostra</em>, et la tribune prend leur nom.</p>
    <p>Du haut des Rostres, on prenait la parole devant le peuple. Aujourd’hui, le forum s’appelle LinkedIn. Rostra y donne la parole à toute l’équipe : l’IA rédige les posts de chacun dans son ton, chacun les valide en un geste, ils partent à l’heure.</p>
    <div class="quote-card"><p class="hand">notre signature</p><p class="sig">Prenez la parole.</p></div>
  </div>
  <div class="tessera">
    <div class="tessera-art">{symbol('couleur')}</div>
    <h3>Chaque collaborateur est une tesselle</h3>
    <p>Une mosaïque romaine, ce sont des milliers de petites pierres qui, posées ensemble, font une image. Une entreprise sur LinkedIn, c’est pareil : chaque dirigeant, chaque expert apporte sa voix, et l’ensemble forme la parole de l’entreprise. C’est l’idée de notre logo et de toutes nos illustrations.</p>
  </div>
</div>''')

page('01 · L’histoire', title('Notre caractère', 'Nous parlons à des dirigeants, à des experts et à des équipes de communication. Nous leur faisons gagner du temps sans jamais parler à leur place.') + f'''
<div class="cols-3 traits">
  <div class="trait" style="background:{C['rose_brume']};transform:rotate(-1deg)"><h2>Joyeuse</h2><p>LinkedIn peut être une corvée. Rostra le rend léger : des couleurs franches, des formes rondes, de l’humour dans les détails.</p></div>
  <div class="trait" style="background:{C['soleil_brume']};transform:rotate(.8deg)"><h2>Directe</h2><p>Une idée par phrase, le verbe d’action en premier. On écrit pour être lu sur un téléphone, entre deux rendez-vous.</p></div>
  <div class="trait" style="background:{C['vert_brume']};transform:rotate(-.6deg)"><h2>Faite main</h2><p>Des tesselles posées une à une, des notes écrites à la main : l’IA travaille, mais la marque garde la trace de la main.</p></div>
</div>
<div class="avoid">
  <p class="hand">ce qu’on évite</p>
  <ul>
    <li>Les codes « IA » : robots, étincelles, cerveaux lumineux, dégradés violets</li>
    <li>Les codes « SaaS » génériques : ombres décalées, étiquettes en machine à écrire, barres grises à la place d’un vrai texte</li>
    <li>Le décor péplum : lauriers dorés, colonnes doriques, polices gravées type Trajan</li>
    <li>Le bleu et le logo de LinkedIn : la marque ne doit pas s’y confondre</li>
    <li>Les chiffres, témoignages ou références non vérifiés</li>
  </ul>
</div>''')

# 02 Le logo ----------------------------------------------------------------------------------
divider('02', 'Le logo', 'Une bulle de parole faite de tesselles, et un nom bien rond.', C['soleil'], C['nuit'], 'etape-redaction')

g = 6.0
grid_lines = ''.join(f'<line x1="{x * g}" y1="0" x2="{x * g}" y2="{80 * g}"/>' for x in range(0, 81, 20)) + ''.join(f'<line x1="0" y1="{y * g}" x2="{80 * g}" y2="{y * g}"/>' for y in range(0, 81, 20))
tile_paths = ''.join(f'<path d="{d}" fill="{C["soleil"] if acc else C["rose"]}"/>' for d, acc in tiles())
cons = f'''<svg viewBox="-30 -36 {80 * g + 60} {80 * g + 100}" class="cons">
<g stroke="{C['nuit']}" stroke-opacity=".2" stroke-width="1.5" stroke-dasharray="5 5">{grid_lines}</g>
<g transform="scale({g})">{tile_paths}</g>
<g font-family="Schibsted Grotesk" font-weight="700" font-size="17" fill="{C['nuit']}">
<text x="-4" y="-12">0</text><text x="{20 * g - 9}" y="-12">20</text><text x="{40 * g - 9}" y="-12">40</text><text x="{60 * g - 9}" y="-12">60</text><text x="{80 * g - 10}" y="-12">80</text>
</g>
<g stroke="{C['rose_fonce']}" stroke-width="2.5" fill="none">
<line x1="{40 * g}" y1="{80 * g + 22}" x2="{57 * g}" y2="{80 * g + 22}"/><line x1="{40 * g}" y1="{80 * g + 14}" x2="{40 * g}" y2="{80 * g + 30}"/><line x1="{57 * g}" y1="{80 * g + 14}" x2="{57 * g}" y2="{80 * g + 30}"/>
</g>
<text x="{40 * g}" y="{80 * g + 54}" font-family="Schibsted Grotesk" font-weight="700" font-size="17" fill="{C['rose_fonce']}">tesselle {TILE} · joint {UNIT - TILE}</text>
</svg>'''
page('02 · Le logo', title('La bulle en tesselles') + f'''
<div class="cols-2">
  <div class="cons-box">{cons}</div>
  <div>
    <p>Le symbole est une bulle de parole faite de douze tesselles et d’une queue inclinée. Il est dessiné sur une grille de pas {UNIT}.</p>
    <table class="spec">
      <tr><th>Grille</th><td>4 colonnes × 3 rangées, pas de {UNIT}</td></tr>
      <tr><th>Tesselle</th><td>{TILE} × {TILE}, joint de {UNIT - TILE}</td></tr>
      <tr><th>Angles</th><td>rayon {fmt(R_SMALL)} ; rayon {R_BIG} aux trois coins extérieurs de la bulle</td></tr>
      <tr><th>Queue</th><td>triangle sous la première tesselle, pointe en (2 ; 79)</td></tr>
      <tr><th>Encombrement</th><td>{SW} × {SH}</td></tr>
    </table>
    <div class="sun-note"><div class="sun-tile"></div><div><strong>La tesselle soleil</strong><span>Une seule tesselle est jaune : c’est la voix de chacun, celle qui attend sa validation. Elle est toujours à la même place, rangée 2, colonne 3.</span></div></div>
    <p class="hand">en noir ou en blanc, elle devient une tesselle évidée</p>
  </div>
</div>''')

hz = horizontal('couleur'); hz_inner = svg_inner(hz); hw = svg_width(hz)
sw_px = SW / SH * 200
tiles_h = 57 / SH * 200
ann = f'''<svg viewBox="-70 -24 {hw + 200:.0f} 320" class="hz-cons">{hz_inner}
<g stroke="{C['rose_fonce']}" stroke-width="3" fill="none">
<line x1="-34" y1="0" x2="-34" y2="200"/><line x1="-44" y1="0" x2="-24" y2="0"/><line x1="-44" y1="200" x2="-24" y2="200"/>
<line x1="{sw_px:.1f}" y1="236" x2="{sw_px + GAP_H * 200:.1f}" y2="236"/><line x1="{sw_px:.1f}" y1="226" x2="{sw_px:.1f}" y2="246"/><line x1="{sw_px + GAP_H * 200:.1f}" y1="226" x2="{sw_px + GAP_H * 200:.1f}" y2="246"/>
<line x1="{hw + 24:.1f}" y1="{tiles_h / 2 - CAP * 100:.1f}" x2="{hw + 24:.1f}" y2="{tiles_h / 2 + CAP * 100:.1f}"/>
</g>
<line x1="-10" y1="{tiles_h / 2:.1f}" x2="{hw + 34:.1f}" y2="{tiles_h / 2:.1f}" stroke="{C['rose_fonce']}" stroke-dasharray="8 6" stroke-width="2"/>
<g font-family="Schibsted Grotesk" font-size="26" font-weight="700" fill="{C['rose_fonce']}">
<text x="-66" y="108">H</text><text x="{sw_px + 2:.1f}" y="280">0,22 H</text><text x="{hw + 34:.1f}" y="{tiles_h / 2 + 9:.0f}">0,52 H</text>
</g></svg>'''
page('02 · Le logo', title('Un nom bien rond') + f'''
<div class="logotype-hero">{logotype('couleur')}</div>
<div class="cols-2">
  <div><p>Le logotype est « Rostra » en Bagel Fat One : une lettre ronde, épaisse et gaie, avec une approche resserrée de 1 %. Il est vectorisé dans les fichiers : il ne dépend d’aucune police installée.</p>
  <p class="small">Version verticale : le nom fait {fmt(V_WIDTH)} fois la largeur du symbole, centré dessous, à {fmt(GAP_V)} fois cette largeur.</p></div>
  <div>{ann}<p class="small">H : hauteur du symbole · 0,22 H : espace entre le symbole et le nom · 0,52 H : hauteur des capitales, centrées sur les tesselles (sans la queue).</p></div>
</div>''')

page('02 · Le logo', title('Quatre versions', 'Choisissez la version selon la place disponible. Ne recomposez jamais le logo vous-même : utilisez les fichiers fournis.') + f'''
<div class="cols-4 versions">
  {card(horizontal('couleur'), C['blanc'], 'Horizontal', 'La version principale : en-têtes, signatures, présentations, partout où la place est en largeur.')}
  {card(vertical('couleur'), C['blanc'], 'Vertical', 'Formats carrés ou en hauteur : couvertures, affiches, objets.', 'tall')}
  {card(symbol('couleur'), C['blanc'], 'Symbole seul', 'Favicon, icône d’application, avatar, tampon. Là où le nom est déjà connu.', 'tall')}
  {card(logotype('couleur'), C['blanc'], 'Logotype seul', 'Quand le symbole figure déjà ailleurs, ou dans un espace très bas.')}
</div>''')

page('02 · Le logo', title('Quatre couleurs') + f'''
<div class="cols-2 decl">
  {card(horizontal('couleur'), C['marbre'], 'Couleur', 'Version de référence, sur fond clair. Tesselles Rose #DF1C60, tesselle Soleil #FFC93C, nom Nuit #1E1A45.', 'bordered')}
  {card(horizontal('negatif'), C['nuit'], 'Négatif', 'Sur fond sombre : nuit, joint. Tesselles rose et soleil, nom Marbre #FFF4E2. C’est le pied de page du site et le mode sombre.')}
  {card(horizontal('noir'), C['blanc'], 'Noir', 'Impression en une couleur : tampon, presse, photocopie. Noir 100 %, tesselle soleil évidée.', 'bordered')}
  {card(horizontal('blanc'), C['rose'], 'Blanc', 'En réserve sur un aplat de couleur ou une photo sombre : textile, objets, vitrophanie. Blanc 100 %.')}
</div>''')

x_h = UNIT / SH * 200
prot = f'''<svg viewBox="{-x_h - 6:.1f} {-x_h - 6:.1f} {hw + 2 * x_h + 12:.1f} {200 + 2 * x_h + 12:.1f}" class="prot">
<rect x="{-x_h:.1f}" y="{-x_h:.1f}" width="{hw + 2 * x_h:.1f}" height="{200 + 2 * x_h:.1f}" rx="18" fill="{C['soleil_brume']}" stroke="{C['nuit']}" stroke-dasharray="8 6" stroke-width="3"/>
<rect x="0" y="0" width="{hw:.1f}" height="200" fill="{C['marbre']}"/>{hz_inner}
<g font-family="Caveat" font-weight="600" font-size="44" fill="{C['rose_fonce']}"><text x="{hw / 2:.0f}" y="{-x_h / 2 + 12:.0f}">x</text><text x="{-x_h / 2 - 9:.0f}" y="112">x</text><text x="{hw + x_h / 2 - 9:.0f}" y="112">x</text><text x="{hw / 2:.0f}" y="{200 + x_h / 2 + 12:.0f}">x</text></g>
</svg>'''
page('02 · Le logo', title('Laissez-le respirer') + f'''
<div class="cols-2">
  <div><p>Autour du logo, gardez une zone libre au moins égale à <strong>x</strong>, le pas d’une tesselle. Aucun texte, aucune image, aucun bord de page n’y entre. Pour le logotype seul, x est la hauteur du « o ».</p>{prot}</div>
  <div>
    <h2>Jamais trop petit</h2>
    <p>En dessous de ces tailles, les joints se bouchent et le nom devient illisible : passez à une autre version.</p>
    <table class="spec sizes">
      <tr><th>Version</th><th>Impression</th><th>Écran</th></tr>
      <tr><td>Horizontal</td><td>28 mm de large</td><td>100 px</td></tr>
      <tr><td>Vertical</td><td>18 mm de large</td><td>70 px</td></tr>
      <tr><td>Symbole seul</td><td>5 mm de côté</td><td>16 px</td></tr>
      <tr><td>Logotype seul</td><td>18 mm de large</td><td>64 px</td></tr>
    </table>
    <div class="minis"><div style="width:100px">{horizontal('couleur')}</div><div style="width:16px">{symbol('couleur')}</div><div style="width:24px">{symbol('couleur')}</div><div style="width:64px">{logotype('couleur')}</div></div>
  </div>
</div>''')

page('02 · Le logo', title('Sur quel fond ?', 'Le logo se pose sur un aplat de la palette. Sur une photo, choisissez une zone calme et la version blanche ou négative.') + f'''
<div class="cols-3 fonds">
  {card(horizontal('couleur'), C['marbre'], 'Marbre #FFF4E2', 'version couleur', 'bordered')}
  {card(horizontal('couleur'), C['blanc'], 'Blanc #FFFFFF', 'version couleur', 'bordered')}
  {card(horizontal('couleur'), C['soleil_brume'], 'Soleil brume #FFF0C7', 'version couleur', 'bordered')}
  {card(horizontal('negatif'), C['nuit'], 'Nuit #1E1A45', 'version négative')}
  {card(horizontal('negatif'), C['joint'], 'Joint #3A3560', 'version négative')}
  {card(horizontal('blanc'), C['rose'], 'Rose #DF1C60', 'version blanche')}
</div>''')

H = horizontal('couleur')
sym = symbol('couleur')
donts = [
    (f'<div style="transform:scaleX(1.5)">{H}</div>', 'Déformer, étirer, écraser'),
    (f'<div style="transform:rotate(-14deg)">{H}</div>', 'Faire pivoter'),
    (H.replace(C['rose'], '#0A66C2'), 'Changer les couleurs (surtout pas en bleu LinkedIn)'),
    (H.replace(C['soleil'], C['rose']), 'Supprimer ou déplacer la tesselle soleil'),
    (f'<div style="filter:drop-shadow(7px 7px 0 #1E1A45)">{H}</div>', 'Ajouter une ombre, un contour, un dégradé'),
    (f'<div class="recompose"><span style="font-family:Bagel;font-size:34px;color:#1E1A45">Rostra</span><div style="width:58px">{sym}</div></div>', 'Recomposer ou changer les proportions'),
    (f'<div class="recompose"><div style="width:46px">{sym}</div><span style="font-family:Georgia;font-weight:700;font-size:34px;color:#1E1A45">Rostra</span></div>', 'Réécrire le nom dans une autre police'),
    (f'<div class="busy">{H}</div>', 'Poser sur un fond chargé ou sans contraste'),
]
page('02 · Le logo', title('Ce qu’on ne fait pas au logo') + '<div class="cols-4 donts">' + ''.join(
    f'<figure class="dont"><div class="art">{art}</div><figcaption><span class="x">✕</span>{label}</figcaption></figure>' for art, label in donts) + '</div>')

# 03 Les couleurs -----------------------------------------------------------------------------
divider('03', 'Les couleurs', 'Cinq couleurs de mosaïque, chacune avec un rôle.', C['vert'], C['nuit'], 'etape-validation')


def sw(name, hexa, verb, role, fg):
    return (f'<div class="sw" style="background:{hexa};color:{fg}"><span class="verb">{verb}</span><strong>{name}</strong><span class="role">{role}</span>'
            f'<span class="codes">HEX {hexa}<br>RVB {rgb(hexa)}<br>CMJN {cmyk(hexa)}</span></div>')


page('03 · Les couleurs', title('Cinq couleurs, cinq rôles') + f'''
<div class="palette">
  {sw('Rose', C['rose'], 'on agit', 'Boutons d’action, tesselles du logo, mot clé d’un titre', C['blanc'])}
  {sw('Soleil', C['soleil'], 'ça attend', 'La tesselle du logo, « à valider », soulignements', C['nuit'])}
  {sw('Vert-de-gris', C['vert'], 'c’est parti', '« Publié », réussites, notes manuscrites', C['nuit'])}
  {sw('Nuit', C['nuit'], 'on lit', 'Textes, contours, fonds sombres', C['marbre'])}
  {sw('Marbre', C['marbre'], 'on respire', 'Le fond de tous les supports', C['nuit'])}
</div>
<p class="hand">des couleurs de mosaïque et de fresque : le vert-de-gris est la patine du bronze</p>''')


def chip(name, hexa, role):
    return (f'<div class="chip"><span class="dot" style="background:{hexa}"></span><div><strong>{name}</strong><span>{role}</span>'
            f'<small>{hexa} · RVB {rgb(hexa)} · CMJN {cmyk(hexa)}</small></div></div>')


page('03 · Les couleurs', title('Les nuances') + f'''
<div class="cols-3 nuances">
  <div><h3>Rose</h3>{chip('Rose foncé', C['rose_fonce'], 'Liens et texte rose sur fond clair, survols')}{chip('Rose clair', C['rose_clair'], 'Actions du mode sombre')}{chip('Rose brume', C['rose_brume'], 'Aplats légers, statut « erreur »')}</div>
  <div><h3>Soleil et vert</h3>{chip('Soleil brume', C['soleil_brume'], 'Statut « à valider », encadrés')}{chip('Vert foncé', C['vert_fonce'], 'Texte vert sur fond clair, notes manuscrites')}{chip('Vert brume', C['vert_brume'], 'Statut « publié »')}</div>
  <div><h3>Nuit et marbre</h3>{chip('Nuit douce', C['nuit_douce'], 'Texte secondaire')}{chip('Joint', C['joint'], 'Joints des mosaïques, surfaces sombres')}{chip('Lavande', C['lavande'], 'Statut « validé »')}{chip('Marbre soutenu', C['marbre_soutenu'], 'Sections, fonds soutenus')}{chip('Filet', C['filet'], 'Filets légers, champs de saisie')}</div>
</div>
<p class="small">CMJN calculés depuis le sRGB avec le profil ICC Coated FOGRA39 (papier couché), intention colorimétrique relative. Valeurs indicatives : validez-les sur épreuve avec votre imprimeur. Le rose et le soleil perdent de l’éclat en quadrichromie : pour un objet ou une affiche, demandez un ton direct (Pantone) à l’imprimeur, sur nuancier.</p>''')

pairs = [
    ('Nuit sur marbre', C['nuit'], C['marbre']), ('Nuit douce sur marbre', C['nuit_douce'], C['marbre']),
    ('Blanc sur rose', C['blanc'], C['rose']), ('Rose foncé sur marbre', C['rose_fonce'], C['marbre']),
    ('Nuit sur soleil', C['nuit'], C['soleil']), ('Nuit sur vert-de-gris', C['nuit'], C['vert']),
    ('Vert foncé sur vert brume', C['vert_fonce'], C['vert_brume']), ('Marbre sur nuit', C['marbre'], C['nuit']),
    ('Nuit sur rose clair', C['nuit'], C['rose_clair']),
    ('Rose sur marbre', C['rose'], C['marbre']), ('Blanc sur vert-de-gris', C['blanc'], C['vert']), ('Soleil sur marbre', C['soleil'], C['marbre']),
]


def verdict(r):
    return 'Texte' if r >= 4.5 else ('Grands titres' if r >= 3 else 'À éviter')


rows = ''.join(f'<div class="cr {"bad" if contrast(f, b) < 3 else ("mid" if contrast(f, b) < 4.5 else "")}"><span class="aa" style="color:{f};background:{b}">Aa</span><span class="lbl">{l}</span><span class="ratio">{fmt(contrast(f, b))}:1</span><span class="ok">{verdict(contrast(f, b))}</span></div>' for l, f, b in pairs)
page('03 · Les couleurs', title('Accords et contrastes') + f'''
<div class="cols-2">
  <ol class="rules">
    <li><strong>Une seule action rose par écran.</strong> Le rose attire l’œil : il désigne ce qu’on attend de la personne.</li>
    <li><strong>Le soleil ne porte jamais de texte clair.</strong> Toujours du nuit dessus.</li>
    <li><strong>Le texte courant est nuit.</strong> Le rose et le vert en texte passent à leur version foncée.</li>
    <li><strong>Trois couleurs vives au plus par support.</strong> Le marbre et le nuit font le reste.</li>
    <li><strong>Jamais de dégradé.</strong> Une mosaïque, ce sont des aplats.</li>
  </ol>
  <div><p class="small">Texte courant : contraste d’au moins 4,5:1 (WCAG niveau AA). Grands titres (24 px et plus) : 3:1.</p><div class="crs">{rows}</div></div>
</div>''')

# 04 Les lettres ------------------------------------------------------------------------------
divider('04', 'Les lettres', 'Une ronde pour annoncer, une sobre pour lire, une manuscrite pour sourire.', C['nuit'], C['marbre'], 'etape-planning')

CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ<br>abcdefghijklmnopqrstuvwxyz<br>0123456789 àâçéèêëîïôœùûü « » & € ? !'
page('04 · Les lettres', title('Trois polices libres') + f'''
<div class="cols-3 fonts">
  <div class="font-card"><div class="aa bagel">Aa</div><h3>Bagel Fat One</h3><p class="small">Titres, logotype, prix, mots mis en avant. Une seule graisse : on ne la met jamais en gras.</p><p class="spec-b">Prenez la parole.</p><p class="chars bagel">{CHARS}</p></div>
  <div class="font-card"><div class="aa schib">Aa</div><h3>Schibsted Grotesk</h3><p class="small">Textes, boutons, menus, légendes. Regular (400) pour lire, SemiBold (600) et Bold (700) pour les boutons et les libellés.</p><p class="spec-s">Chaque titulaire valide ses posts en quelques secondes, sur son téléphone.</p><p class="chars schib">{CHARS}</p></div>
  <div class="font-card"><div class="aa hand-f">Aa</div><h3>Caveat</h3><p class="small">Les notes à la main, comme dans une marge : une par écran ou par page, dix mots au plus, en vert foncé ou en rose foncé.</p><p class="spec-c">rien ne part sans leur accord</p><p class="chars hand-f">{CHARS}</p></div>
</div>
<p class="small">Les trois polices sont sous licence SIL Open Font License 1.1 : gratuites, y compris pour un usage commercial, sur fonts.google.com. En bureautique et dans les e-mails, si elles ne sont pas installées : Arial Rounded MT Bold ou Trebuchet MS pour les titres, Arial ou Segoe UI pour le texte, et pas de manuscrite.</p>''')

page('04 · Les lettres', title('Du titre à la note') + '''
<table class="hier">
<tr><th>Niveau</th><th>Exemple</th><th>Règle</th><th>Impression</th><th>Écran</th></tr>
<tr><td>Titre 1</td><td><span class="ex-h1">Toute l’équipe prend la <span class="said">parole.</span></span></td><td>Bagel Fat One, interligne 1, un mot clé en rose souligné de soleil</td><td>36–72 pt</td><td>40–74 px</td></tr>
<tr><td>Titre 2</td><td><span class="ex-h2">Comment ça marche</span></td><td>Bagel Fat One, interligne 1,05</td><td>22–32 pt</td><td>29–45 px</td></tr>
<tr><td>Titre 3</td><td><span class="ex-h3">Validation en un clic</span></td><td>Schibsted Grotesk Bold, interligne 1,3</td><td>11–13 pt</td><td>17 px</td></tr>
<tr><td>Chapô</td><td><span class="ex-lead">L’IA rédige, chacun valide, tout part à l’heure.</span></td><td>Schibsted Grotesk Regular, nuit douce, interligne 1,6</td><td>12–14 pt</td><td>19 px</td></tr>
<tr><td>Texte</td><td><span class="ex-body">Rien ne part sans l’accord du titulaire.</span></td><td>Schibsted Grotesk Regular, nuit, interligne 1,55</td><td>9,5–11 pt</td><td>16 px</td></tr>
<tr><td>Bouton</td><td><span class="ex-btn">Essai gratuit</span></td><td>Schibsted Grotesk Bold, pilule rose, texte blanc</td><td>10 pt</td><td>16–17 px</td></tr>
<tr><td>Note</td><td><span class="ex-note">↳ rien ne part sans leur accord</span></td><td>Caveat SemiBold, vert foncé, inclinée de −3°</td><td>14–18 pt</td><td>24–28 px</td></tr>
</table>''')

# 05 La mosaïque ------------------------------------------------------------------------------
divider('05', 'La mosaïque', 'Notre matière : des tesselles posées à la main.', C['rose'], C['blanc'], 'etape-planning')

page('05 · La mosaïque', title('Comment on fait une mosaïque Rostra') + f'''
<div class="cols-2 mosa">
  <div class="mosa-art">{ill('buste-mosaique')}</div>
  <div>
    <ol class="rules">
      <li><strong>On part d’un dessin en aplats.</strong> Formes simples, contours nuit épais, cinq couleurs de la palette au plus.</li>
      <li><strong>On le pose sur une grille.</strong> Chaque case devient une tesselle de la couleur majoritaire du dessin.</li>
      <li><strong>On pose chaque tesselle à la main.</strong> Légèrement décalée (±6 %), tournée (±7°) et nuancée (±4,5 % de luminosité). Jamais deux pareilles.</li>
      <li><strong>On garde des joints.</strong> Couleur joint #3A3560 ; ils suivent la silhouette, sans cadre.</li>
      <li><strong>Assez de tesselles pour lire, pas plus.</strong> 12 × 12 pour un pictogramme, 50 × 50 pour une illustration.</li>
    </ol>
    <p class="hand">l’outil est fourni : docs/marque/outils/mosaique.py</p>
    <p class="small">Jamais de photo transformée en mosaïque, jamais de mosaïque d’un logo ou d’une personne réelle.</p>
  </div>
</div>''')

page('05 · La mosaïque', title('Nos illustrations') + f'''
<div class="illus">
  <figure class="big">{ill('buste-mosaique')}<figcaption><strong>Le buste qui prend la parole</strong><span>Notre personnage : un orateur romain couronné de laurier, sa bulle au-dessus de la tête. Il ouvre le site et l’image de partage.</span></figcaption></figure>
  <div class="pictos">
    <figure>{ill('etape-planning')}<figcaption><strong>I · Planning</strong></figcaption></figure>
    <figure>{ill('etape-redaction')}<figcaption><strong>II · Rédaction</strong></figcaption></figure>
    <figure>{ill('etape-validation')}<figcaption><strong>III · Validation</strong></figcaption></figure>
    <figure>{ill('etape-publication')}<figcaption><strong>IV · Publication</strong></figcaption></figure>
    <p class="small span">Pictogrammes en 12 × 12 tesselles, affichés à 64 px au moins. Les étapes se numérotent en chiffres romains.</p>
  </div>
</div>''')

page('05 · La mosaïque', title('Les petits plus') + f'''
<div class="cols-3 extras">
  <div><div class="ex-art"><span class="ex-h2">la <span class="said">parole.</span></span></div><h3>Le soulignement soleil</h3><p>Un trait à main levée, épais, sous un seul mot clé. Une fois par page ou par écran.</p></div>
  <div><div class="ex-art"><span class="ex-note">↳ rien ne part sans leur accord</span></div><h3>La note dans la marge</h3><p>Une phrase en Caveat, inclinée, qui commente. Elle n’apporte jamais une information indispensable.</p></div>
  <div><div class="ex-art"><div class="mini-post"><strong>Claire M.</strong><span class="st">À valider</span><p>Ce que trois ans de formations m’ont appris…</p></div></div><h3>Les cartes posées</h3><p>Contour nuit de 2 à 3 px, rayon 22 px, inclinées de 1 à 3°. Toujours un vrai texte dedans, jamais de barres grises.</p></div>
  <div><div class="ex-art"><span class="ex-btn">Valider</span><span class="ex-btn ghost">Corriger</span></div><h3>Les boutons pilules</h3><p>Rose plein pour l’action principale, contour nuit pour les autres. 44 px de haut au moins.</p></div>
  <div><div class="ex-art bullets"><span style="background:{C['rose']}"></span>Planning<span style="background:{C['soleil']}"></span>Rédaction<span style="background:{C['vert']}"></span>Validation</div><h3>Les puces tesselles</h3><p>De petites tesselles légèrement tournées, en rose, soleil et vert, à la place des puces rondes.</p></div>
  <div><div class="ex-art">{frise([C['rose'], C['soleil'], C['vert'], C['nuit']] * 4, ANGLES, 'frise')}</div><h3>La frise</h3><p>Une rangée de tesselles pour séparer deux parties d’un document imprimé. Pas à l’écran.</p></div>
</div>''')

page('05 · L’interface', title('Les couleurs au travail', 'Dans l’application, chaque statut d’un post a sa couleur. Le libellé est toujours écrit : la couleur aide, elle ne remplace pas le mot.') + f'''
<div class="cols-2">
  <div>
    <div class="statuses">
      <div><span class="st" style="background:{C['soleil_brume']};color:#6B4A00">À valider</span><span>Soleil brume · texte #6B4A00</span></div>
      <div><span class="st" style="background:{C['lavande']};color:{C['nuit']}">Validé</span><span>Lavande #E7E4F7 · texte nuit</span></div>
      <div><span class="st" style="background:{C['vert_brume']};color:{C['vert_fonce']}">Publié</span><span>Vert brume · texte vert foncé</span></div>
      <div><span class="st" style="background:{C['rose_brume']};color:#9E1240">Erreur</span><span>Rose brume · texte #9E1240</span></div>
    </div>
    <p class="gap-top">Le marqueur <span class="marker">[À COMPLÉTER : chiffre]</span> surligne en soleil une information que l’IA n’a pas inventée et qui bloque la publication.</p>
  </div>
  <div class="dark-demo">
    <div class="dd-logo">{horizontal('negatif')}</div>
    <p>Mode sombre : fond #17142F, cartes #221E45, texte marbre, actions rose clair #FF7FA6 avec texte nuit ({fmt(contrast(C['nuit'], C['rose_clair']))}:1). Les tesselles du logo gardent leurs couleurs.</p>
    <span class="ex-btn dark">Valider</span>
  </div>
</div>''')

# 06 Le ton -----------------------------------------------------------------------------------
divider('06', 'Le ton', 'Parler comme une collègue qui vous fait gagner du temps.', C['soleil'], C['nuit'], 'etape-redaction')

page('06 · Le ton', title('Écrire comme Rostra') + '''
<div class="cols-4 tone">
  <div><h3>Vouvoyer</h3><p>On s’adresse à des dirigeants et à des experts : avec respect, sans distance.</p></div>
  <div><h3>Aller droit au but</h3><p>Phrases courtes, une idée par phrase, le verbe d’action en premier.</p></div>
  <div><h3>Rendre la main</h3><p>L’IA propose, la personne décide. On ne promet jamais de « parler à sa place ».</p></div>
  <div><h3>Sourire, pas rigoler</h3><p>Une touche d’humour dans une note ou un clin d’œil romain, jamais dans une erreur ou un prix.</p></div>
</div>
<div class="cols-2 gap-top">
  <div class="quote good"><p class="hand">plutôt</p><p>« Lundi, vos posts de la semaine vous attendent. Vous les validez en un clic ; ils partent à l’heure prévue. »</p></div>
  <div class="quote bad"><p class="hand">plutôt que</p><p>« Boostez votre personal branding grâce à notre IA révolutionnaire qui génère du contenu viral à votre place ! »</p></div>
</div>
<div class="cols-2 gap-top">
  <div><h3>Nos mots</h3><p class="words"><span>prendre la parole</span><span>toute l’équipe</span><span>titulaire</span><span>valider</span><span>publier à l’heure</span><span>dans le ton de chacun</span><span>rien ne part sans accord</span></p></div>
  <div><h3>Règles d’écriture</h3><ul class="small-list">
    <li>« Rostra » avec une majuscule, sans article : « Rostra rédige », pas « le Rostra ».</li>
    <li>« LinkedIn » tel quel ; jamais « Linked » ou « In » dans un nom de produit.</li>
    <li>Majuscules accentuées : À, É. Chiffres en chiffres : 2 semaines, 14 jours.</li>
    <li>Espace insécable avant : ; ? ! % et dans les guillemets « ».</li>
    <li>La signature garde son point final : Prenez la parole.</li>
  </ul></div>
</div>''')

# 07 En situation -----------------------------------------------------------------------------
divider('07', 'En situation', 'La marque sur le site, dans les partages et dans les e-mails.', C['vert'], C['nuit'], 'etape-publication')

page('07 · En situation', title('Le site') + f'''
<div class="site-ex">
  <figure class="shot"><img src="{uri(CAPTURES / 'site-ordinateur.png')}"><figcaption>Accueil sur ordinateur : le buste prend la parole, un vrai post attend sa validation.</figcaption></figure>
  <figure class="shot phone"><img src="{uri(CAPTURES / 'site-telephone.png')}"><figcaption>Sur téléphone</figcaption></figure>
  <figure class="shot"><img src="{uri(CAPTURES / 'site-sombre.png')}"><figcaption>Mode sombre : logo négatif, actions rose clair.</figcaption></figure>
</div>''')

av_h = 150
avatar = svg(300, 300, f'<rect width="300" height="300" fill="{C["marbre"]}"/>' + symbol_group(COLORS['couleur'], (300 - av_h * SW / SH) / 2, (300 - av_h) / 2 + 5, av_h))
page('07 · En situation', title('Partages, réseaux et e-mails') + f'''
<div class="apps">
  <figure class="f-og"><img class="og" src="{uri(APP / 'opengraph-image.png')}"><figcaption><strong>Image de partage</strong> 1200 × 630 px, affichée quand un lien du site est partagé sur LinkedIn ou dans une messagerie.</figcaption></figure>
  <figure class="f-av"><div class="avatars"><div class="round">{avatar}</div><div class="fav"><img src="{uri(APP / 'apple-icon.png')}"><span>icône d’écran d’accueil</span></div><div class="fav"><div style="width:32px">{symbol('couleur')}</div><span>favicon</span></div></div><figcaption><strong>Page LinkedIn et icônes</strong> Avatar 1080 px recadré en rond, sur fond marbre.</figcaption></figure>
  <figure class="f-mail"><div class="mail">
      <div style="width:130px;margin-bottom:6mm">{horizontal('couleur')}</div>
      <p>Bonjour Claire,</p><p>Votre post de mardi vous attend. Il part à 8 h 30 si vous le validez.</p>
      <p><span class="mail-btn">Voir le post</span></p>
      <hr><p class="mail-foot">Rostra · Prenez la parole.</p>
    </div><figcaption><strong>E-mail</strong> Arial dans les messageries, bouton pilule rose, logo en PNG 320 px affiché à 160 px.</figcaption></figure>
</div>''')

# 08 Fichiers ---------------------------------------------------------------------------------
page('08 · Les fichiers', title('Où trouver quoi') + '''
<div class="cols-2">
  <div>
<pre class="tree">Rostra/
├─ Charte graphique Rostra.pdf
├─ Logos/
│  ├─ 1. Horizontal/
│  ├─ 2. Vertical/
│  ├─ 3. Symbole seul (sans texte)/
│  ├─ 4. Logotype seul (texte seul)/
│  │     chacun avec PNG/ · JPEG/ · SVG/
│  └─ 5. Réseaux sociaux/   avatars 1080 px
└─ Illustrations/   buste et pictogrammes, SVG et PNG 2000 px</pre>
    <p class="small">Nom des fichiers : <strong>rostra_version_couleur_largeur.ext</strong>, par exemple rostra_horizontal_couleur_3000px.png. Couleurs : couleur, negatif (fond sombre), noir, blanc.</p>
    <h3 class="gap-top">Les polices</h3><p class="small">Bagel Fat One, Schibsted Grotesk et Caveat ne sont pas dans ce dossier : téléchargez-les gratuitement sur fonts.google.com.</p>
    <h3 class="gap-top">Pour l’équipe technique</h3><p class="small">Le composant du logo, le favicon, l’image de partage, les polices du site et les couleurs en variables CSS sont dans le dépôt de l’application. Les outils qui produisent le logo, les mosaïques et cette charte sont dans docs/marque.</p>
  </div>
  <div class="formats">
    <div><h3>PNG</h3><span>fond transparent</span><p>Site, présentations, Canva, réseaux sociaux. HD (2000 à 3000 px) pour l’impression bureautique, web (512 à 800 px) pour les e-mails et les pages.</p></div>
    <div><h3>JPEG</h3><span>fond plein</span><p>Word, envoi rapide, outils qui gèrent mal la transparence. Fond blanc pour les versions couleur et noire, nuit pour la négative, rose pour la blanche. Zone de protection incluse.</p></div>
    <div><h3>SVG</h3><span>vectoriel</span><p>Imprimeur, signalétique, grands formats, intégration web. Se redimensionne sans perte.</p></div>
    <p class="hand">dans le doute : le PNG HD de la version horizontale couleur</p>
  </div>
</div>''')

# Dos -----------------------------------------------------------------------------------------
page('', f'''<div class="back"><div class="back-logo">{vertical('negatif')}</div><p class="back-sig">Prenez la parole.</p><p class="back-meta">Rostra · un service édité par SimplX</p>{frise([C['rose'], C['soleil'], C['vert'], C['marbre']] * 6, ANGLES, 'back-frise')}</div>''', cls='p-back', bare=True)


# --- Rendu ---------------------------------------------------------------------------------
N, M, R, S_, V = C['nuit'], C['marbre'], C['rose'], C['soleil'], C['vert']
CSS = f'''
@font-face{{font-family:Bagel;src:url({uri(POLICES / 'BagelFatOne.ttf')})}}
@font-face{{font-family:'Schibsted Grotesk';src:url({uri(POLICES / 'SchibstedGrotesk.ttf')})}}
@font-face{{font-family:Caveat;src:url({uri(POLICES / 'Caveat.ttf')})}}
@page{{size:297mm 210mm;margin:0}}
*{{box-sizing:border-box}}
html,body{{margin:0;background:#888}}
body{{font-family:'Schibsted Grotesk';color:{N};font-size:10.5pt;line-height:1.5}}
.page{{width:297mm;height:210mm;background:{M};position:relative;overflow:hidden;padding:22mm 18mm 16mm;page-break-after:always;break-after:page}}
.run{{position:absolute;left:18mm;right:18mm;top:8mm;display:flex;justify-content:space-between;align-items:center;font-size:8pt;font-weight:600;color:{C['nuit_douce']}}}
.run .rl{{display:flex;align-items:center;gap:2.5mm}} .run .rl svg{{width:5mm;height:auto}}
.foot{{position:absolute;left:18mm;right:18mm;bottom:7mm;display:flex;justify-content:space-between;align-items:baseline;font-size:8pt;color:{C['nuit_douce']}}}
.foot .pn{{font-family:Bagel;font-size:12pt;color:{N}}}
h1,h2{{font-family:Bagel;font-weight:400;margin:0 0 4mm;line-height:1.02}}
h1{{font-size:32pt}} h2{{font-size:19pt}}
h3{{font-size:10.5pt;margin:0 0 1.5mm;font-weight:700}}
p{{margin:0 0 3mm}}
.intro{{font-size:11.5pt;color:{C['nuit_douce']};max-width:175mm;margin-bottom:7mm}}
.lead{{font-size:13pt;line-height:1.5}}
.small{{font-size:8.5pt;color:{C['nuit_douce']}}}
.hand{{font-family:Caveat;font-weight:600;font-size:17pt;color:{C['vert_fonce']};transform:rotate(-2deg);transform-origin:left;line-height:1.1}}
.gap-top{{margin-top:6mm}}
svg{{display:block;max-width:100%;height:auto}}
.cols-2{{display:grid;grid-template-columns:1fr 1fr;gap:12mm}}
.cols-3{{display:grid;grid-template-columns:repeat(3,1fr);gap:8mm}}
.cols-4{{display:grid;grid-template-columns:repeat(4,1fr);gap:6mm}}
.said{{color:{R};position:relative;white-space:nowrap}}
.said::after{{content:'';position:absolute;left:-2%;right:-2%;bottom:-.12em;height:.14em;border-radius:99px;background:{S_};transform:rotate(-1.2deg);z-index:-1}}
/* couverture */
.p-cover{{background:{N};color:{M};padding:0}}
.cover{{position:absolute;inset:0}}
.cover-logo{{position:absolute;left:20mm;top:18mm;width:62mm}}
.cover-title{{position:absolute;left:20mm;top:56mm;font-size:66pt;line-height:.98;color:{M}}}
.cover-sub{{position:absolute;left:21mm;top:124mm;width:115mm;font-size:13pt;color:#C9C3E6}}
.cover-note{{position:absolute;left:21mm;top:146mm;color:{S_};font-size:21pt}}
.cover-meta{{position:absolute;left:21mm;bottom:12mm;font-size:9pt;color:#C9C3E6}}
.cover-bust{{position:absolute;right:-4mm;bottom:-6mm;width:150mm}}
/* intercalaires */
.p-div{{padding:0}}
.div-wrap{{position:absolute;inset:0;padding:24mm 22mm}}
.div-num{{font-family:Bagel;font-size:150pt;line-height:.85}}
.div-name{{font-family:Bagel;font-size:52pt;line-height:1;margin-top:6mm}}
.div-sub{{font-size:14pt;margin-top:5mm;max-width:130mm;opacity:.92}}
.div-picto{{position:absolute;right:24mm;bottom:24mm;width:64mm;transform:rotate(-4deg)}}
/* programme */
.prog{{display:grid;grid-template-columns:repeat(4,1fr);gap:7mm 6mm}}
.prog-tile{{border:2.5px solid {N};border-radius:20px;padding:5mm;height:46mm;display:flex;flex-direction:column}}
.prog-tile .pn{{font-family:Bagel;font-size:22pt;line-height:1}}
.prog-tile strong{{font-family:Bagel;font-weight:400;font-size:15pt;margin-top:2mm}}
.prog-tile .pd{{font-size:8.5pt;margin-top:1mm}}
.prog-tile .pp{{margin-top:auto;font-size:8.5pt;font-weight:700}}
/* histoire */
.quote-card{{border:2.5px solid {N};border-radius:20px;background:#fff;padding:5mm 7mm;margin-top:6mm;transform:rotate(-1deg);width:85%}}
.sig{{font-family:Bagel;font-size:24pt;margin:0}}
.tessera{{background:#fff;border:2.5px solid {N};border-radius:22px;padding:8mm;transform:rotate(1deg)}}
.tessera-art{{width:30mm;margin-bottom:5mm}}
.tessera p{{font-size:10pt;color:{C['nuit_douce']}}}
.trait{{border:2.5px solid {N};border-radius:22px;padding:6mm}}
.trait h2{{font-size:22pt}} .trait p{{font-size:10pt}}
.avoid{{margin-top:8mm;border:2.5px dashed {N};border-radius:22px;padding:5mm 7mm}}
.avoid .hand{{color:{C['rose_fonce']};margin-bottom:2mm}}
.avoid ul{{margin:0;padding-left:5mm;font-size:9.5pt;columns:2;column-gap:10mm}} .avoid li{{margin-bottom:1.2mm;break-inside:avoid}}
/* logo */
.cons-box{{background:#fff;border:2.5px solid {N};border-radius:22px;padding:6mm;display:grid;place-items:center}}
.cons{{width:96mm}}
.spec{{border-collapse:collapse;width:100%;font-size:9.5pt;margin-bottom:4mm}}
.spec th,.spec td{{text-align:left;padding:1.8mm 2mm;border-top:1.5px solid {C['filet']}}}
.spec th{{font-weight:700;width:30mm}}
.sizes th{{width:auto}}
.sun-note{{display:grid;grid-template-columns:14mm 1fr;gap:3mm;align-items:start;background:{C['soleil_brume']};border-radius:16px;padding:4mm;margin-bottom:3mm}}
.sun-tile{{width:12mm;height:12mm;border-radius:3px;background:{S_};transform:rotate(-6deg)}}
.sun-note strong{{display:block}} .sun-note span{{font-size:9pt}}
.logotype-hero{{width:140mm;margin:2mm 0 8mm}}
.hz-cons{{width:125mm}}
.card{{margin:0;display:flex;flex-direction:column;gap:3mm}}
.card .art{{border-radius:20px;height:44mm;display:grid;place-items:center;padding:8mm}}
.card .art svg{{max-height:24mm;width:auto;max-width:100%}}
.card.tall .art svg{{max-height:32mm}}
.card.bordered .art{{border:2px solid {N}}}
.card figcaption strong{{display:block;font-size:10.5pt}} .card figcaption span{{font-size:8.5pt;color:{C['nuit_douce']}}}
.versions .art{{height:64mm;border:2.5px solid {N}}}
.versions .card:nth-child(odd) .art{{transform:rotate(-1deg)}} .versions .card:nth-child(even) .art{{transform:rotate(1deg)}}
.decl{{gap:7mm 10mm}} .decl .art{{height:40mm}} .decl .art svg{{max-height:19mm}}
.prot{{width:115mm;margin-top:4mm}}
.minis{{display:flex;align-items:center;gap:8mm;margin-top:6mm}}
.fonds .art{{height:36mm}} .fonds .art svg{{max-height:15mm}}
.donts{{gap:7mm 6mm}}
.dont{{margin:0}} .dont .art{{height:38mm;padding:6mm;overflow:hidden;background:#fff;border:2px solid {N};border-radius:20px;display:grid;place-items:center}}
.dont .art svg{{max-height:15mm;width:auto}} .dont .art > div{{width:82%}}
.dont figcaption{{display:flex;gap:2mm;align-items:flex-start;font-size:9pt;margin-top:2.5mm;font-weight:600}}
.dont .x{{color:{R};font-weight:800}}
.recompose{{display:flex!important;align-items:center;gap:10px;width:auto!important}}
.busy{{width:100%!important;height:100%;display:grid;place-items:center;background:repeating-linear-gradient(45deg,{R} 0 10px,{S_} 10px 20px,{V} 20px 30px);border-radius:12px;padding:4mm}}
.busy svg{{max-height:13mm}}
/* couleurs */
.palette{{display:grid;grid-template-columns:repeat(5,1fr);gap:5mm;margin-bottom:6mm}}
.sw{{border-radius:22px;padding:6mm 5mm;height:112mm;display:flex;flex-direction:column;border:2.5px solid {N}}}
.sw:nth-child(odd){{transform:rotate(-1deg)}} .sw:nth-child(even){{transform:rotate(1deg)}}
.sw .verb{{font-family:Caveat;font-weight:600;font-size:18pt;line-height:1}}
.sw strong{{font-family:Bagel;font-weight:400;font-size:19pt;margin-top:2mm;line-height:1.05}}
.sw .role{{font-size:9pt;margin-top:2mm}}
.sw .codes{{margin-top:auto;font-size:8pt;line-height:1.6}}
.nuances h3{{font-family:Bagel;font-weight:400;font-size:15pt;margin-bottom:3mm}}
.chip{{display:grid;grid-template-columns:12mm 1fr;gap:3mm;margin-bottom:3.2mm}}
.chip .dot{{width:12mm;height:12mm;border-radius:4px;border:2px solid {N};transform:rotate(-4deg)}}
.chip strong{{display:block;font-size:9.5pt}} .chip span{{display:block;font-size:8.5pt;color:{C['nuit_douce']}}} .chip small{{display:block;font-size:7pt;color:{C['nuit_douce']}}}
.rules{{padding-left:5mm;margin:0}} .rules li{{margin-bottom:3.5mm;font-size:10pt}}
.crs{{display:grid;gap:1.5mm}}
.cr{{display:grid;grid-template-columns:14mm 1fr 18mm 24mm;align-items:center;gap:3mm;font-size:8.5pt}}
.cr .aa{{font-family:Bagel;font-size:12pt;text-align:center;border-radius:8px;padding:.6mm 0;border:1.5px solid {N}}}
.cr .ratio{{font-weight:700;text-align:right}}
.cr.mid .ok{{color:{C['nuit_douce']}}} .cr.bad .ok{{color:{C['rose_fonce']};font-weight:700}}
/* lettres */
.font-card{{background:#fff;border:2.5px solid {N};border-radius:22px;padding:6mm}}
.font-card:nth-child(2){{transform:rotate(.8deg)}} .font-card:nth-child(1),.font-card:nth-child(3){{transform:rotate(-.6deg)}}
.aa{{font-size:52pt;line-height:1;margin-bottom:2mm}}
.bagel{{font-family:Bagel}} .schib{{font-family:'Schibsted Grotesk';font-weight:700}} .hand-f{{font-family:Caveat;font-weight:600}}
.spec-b{{font-family:Bagel;font-size:21pt;margin:3mm 0}} .spec-s{{font-size:11.5pt;margin:3mm 0}} .spec-c{{font-family:Caveat;font-weight:600;font-size:21pt;color:{C['vert_fonce']};margin:3mm 0}}
.chars{{font-size:8.5pt;line-height:1.5;color:{C['nuit_douce']}}} .chars.hand-f{{font-size:12pt}}
.fonts .small{{min-height:15mm}}
.hier{{width:100%;border-collapse:collapse;font-size:9pt}}
.hier th{{text-align:left;font-size:8pt;font-weight:700;color:{C['nuit_douce']};padding:2mm}}
.hier td{{border-top:1.5px solid {C['filet']};padding:2.6mm 2mm;vertical-align:middle}}
.hier td:first-child{{font-weight:700;width:22mm}} .hier td:nth-child(2){{width:108mm}}
.ex-h1{{font-family:Bagel;font-size:24pt;line-height:1;position:relative;z-index:0}} .ex-h2{{font-family:Bagel;font-size:17pt;position:relative;z-index:0}}
.ex-h3{{font-weight:700;font-size:11pt}} .ex-lead{{font-size:12pt;color:{C['nuit_douce']}}} .ex-body{{font-size:10.5pt}}
.ex-note{{font-family:Caveat;font-weight:600;font-size:17pt;color:{C['vert_fonce']};display:inline-block;transform:rotate(-3deg)}}
.ex-btn{{display:inline-block;background:{R};color:#fff;font-weight:700;padding:2.2mm 6mm;border-radius:99px;font-size:10pt;border:2px solid {R}}}
.ex-btn.ghost{{background:#fff;color:{N};border-color:{N};margin-left:2mm}}
.ex-btn.dark{{background:{C['rose_clair']};border-color:{C['rose_clair']};color:{N}}}
/* mosaïque */
.mosa-art{{width:112mm;justify-self:center}}
.illus{{display:grid;grid-template-columns:1fr 1.2fr;gap:12mm;align-items:start}}
.illus figure{{margin:0}} .illus figcaption strong{{display:block;margin-top:2mm}} .illus figcaption span{{font-size:9pt;color:{C['nuit_douce']}}}
.illus .big svg{{width:92mm}}
.pictos{{display:grid;grid-template-columns:1fr 1fr;gap:6mm}}
.pictos figure{{background:#fff;border:2.5px solid {N};border-radius:20px;padding:5mm;display:flex;flex-direction:column;align-items:center}}
.pictos figure:nth-child(odd){{transform:rotate(-1.2deg)}} .pictos figure:nth-child(even){{transform:rotate(1deg)}}
.pictos svg{{width:26mm}} .pictos .span{{grid-column:span 2}}
.extras{{gap:7mm 9mm}}
.ex-art{{height:30mm;background:#fff;border:2.5px solid {N};border-radius:20px;display:flex;align-items:center;justify-content:center;gap:3mm;margin-bottom:3mm;overflow:hidden}}
.extras p{{font-size:9pt;color:{C['nuit_douce']}}}
.mini-post{{width:56mm;border:2px solid {N};border-radius:14px;padding:2.5mm 3.5mm;transform:rotate(-2.5deg);font-size:8pt;background:#fff}}
.mini-post .st{{float:right;background:{C['soleil_brume']};border-radius:99px;padding:0 2mm;font-weight:700;font-size:7pt}}
.mini-post p{{margin:1.5mm 0 0;font-size:7.5pt}}
.bullets{{gap:2mm;font-size:9pt;font-weight:600}} .bullets span{{width:3mm;height:3mm;border-radius:1px;display:inline-block;margin-left:3mm}}
.bullets span:nth-of-type(1){{transform:rotate(6deg)}} .bullets span:nth-of-type(2){{transform:rotate(-5deg)}} .bullets span:nth-of-type(3){{transform:rotate(3deg)}}
.frise{{display:flex;gap:1.2mm}} .frise span{{width:4mm;height:4mm;border-radius:1px;display:block}}
.statuses{{display:grid;gap:3.5mm}}
.statuses div{{display:grid;grid-template-columns:30mm 1fr;align-items:center;font-size:9pt;color:{C['nuit_douce']}}}
.st{{display:inline-block;font-weight:700;font-size:9pt;padding:1mm 4mm;border-radius:99px;justify-self:start}}
.marker{{background:{S_};font-weight:600;padding:0 1mm;border-radius:3px}}
.dark-demo{{background:#17142F;color:{M};border-radius:22px;padding:8mm;border:2.5px solid {N}}}
.dark-demo .dd-logo{{width:55mm;margin-bottom:5mm}}
.dark-demo p{{font-size:9.5pt;color:#C9C3E6}}
/* ton */
.tone > div{{background:#fff;border:2.5px solid {N};border-radius:20px;padding:5mm}} .tone p{{font-size:9pt;color:{C['nuit_douce']}}}
.tone > div:nth-child(odd){{transform:rotate(-1deg)}} .tone > div:nth-child(even){{transform:rotate(.8deg)}}
.quote{{border-radius:20px;padding:5mm 7mm;font-size:11pt}}
.quote.good{{background:{C['vert_brume']};border:2.5px solid {N}}}
.quote.bad{{background:{C['rose_brume']};border:2.5px dashed {N};color:{C['nuit_douce']}}}
.quote.bad .hand{{color:{C['rose_fonce']}}}
.words{{display:flex;flex-wrap:wrap;gap:2mm}}
.words span{{border:2px solid {N};background:#fff;border-radius:99px;padding:.6mm 3.5mm;font-size:9pt;font-weight:600}}
.small-list{{margin:0;padding-left:5mm;font-size:9pt}} .small-list li{{margin-bottom:1mm}}
/* situation */
.site-ex{{display:grid;grid-template-columns:1.6fr .6fr 1.6fr;gap:6mm;align-items:start}}
.shot{{margin:0}} .shot img{{width:100%;display:block;border-radius:12px;border:2.5px solid {N}}}
.shot:nth-child(1){{transform:rotate(-1deg)}} .shot:nth-child(3){{transform:rotate(1deg)}}
.shot figcaption{{font-size:8.5pt;color:{C['nuit_douce']};margin-top:3mm}}
.shot.phone img{{border-radius:18px}}
.apps{{display:grid;grid-template-columns:1.25fr 1fr;grid-template-areas:'og mail' 'av mail';gap:8mm 12mm;align-items:start}}
.apps figure{{margin:0}} .apps .f-og{{grid-area:og}} .apps .f-av{{grid-area:av}} .apps .f-mail{{grid-area:mail}}
.apps figcaption{{font-size:8.5pt;color:{C['nuit_douce']};margin-top:3mm}} .apps figcaption strong{{display:block;color:{N}}}
.apps img.og{{width:100%;border-radius:12px;border:2.5px solid {N}}}
.avatars{{display:flex;align-items:center;gap:8mm}}
.round{{width:34mm;height:34mm;border-radius:50%;overflow:hidden;border:2.5px solid {N}}}
.fav{{display:flex;flex-direction:column;align-items:center;gap:2mm;font-size:8pt;color:{C['nuit_douce']}}}
.fav img{{width:16mm;border-radius:3.6mm;border:1.5px solid {C['filet']}}}
.mail{{background:#fff;border:2.5px solid {N};border-radius:16px;padding:8mm;font-family:Arial;font-size:10pt;min-height:100mm;transform:rotate(.8deg)}}
.mail-btn{{display:inline-block;background:{R};color:#fff;font-weight:700;border-radius:99px;padding:2.4mm 6mm}}
.mail hr{{border:none;border-top:1px solid {C['filet']};margin:5mm 0 3mm}} .mail-foot{{font-size:8.5pt;color:{C['nuit_douce']}}}
/* fichiers */
.formats .hand{{font-size:17pt;color:{C['vert_fonce']};margin-top:2mm}}
.tree{{font-family:Consolas,monospace;font-size:9pt;background:#fff;border:2.5px solid {N};border-radius:16px;padding:5mm;margin:0 0 4mm}}
.formats{{display:grid;gap:4mm;align-content:start}}
.formats > div{{background:#fff;border:2.5px solid {N};border-radius:18px;padding:4mm 5mm}}
.formats h3{{display:inline;margin-right:2mm;font-family:Bagel;font-weight:400;font-size:14pt}} .formats span{{font-size:8.5pt;color:{C['rose_fonce']};font-weight:700}} .formats p{{font-size:9pt;color:{C['nuit_douce']};margin:1mm 0 0}}
/* dos */
.p-back{{background:{N};padding:0}}
.back{{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;color:{M}}}
.back-logo{{width:56mm;margin-bottom:10mm}}
.back-sig{{font-family:Bagel;font-size:24pt}}
.back-meta{{font-size:9pt;color:#C9C3E6}}
.back-frise{{position:absolute;bottom:14mm;display:flex;gap:2mm}} .back-frise span{{width:6mm;height:6mm;border-radius:1.5px;display:block}}
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
    mini = symbol('couleur', H=40)
    out = []
    for i, (section, body, cls, bare) in enumerate(pages, start=1):
        chrome = '' if bare else (f'<div class="run"><span class="rl">{mini}Rostra · charte graphique</span><span>{html.escape(section)}</span></div>'
                                  f'<div class="foot"><span>{VERSION}</span><span class="pn">{i:02d}</span></div>')
        out.append(f'<section class="page {cls}">{chrome}{body}</section>')
    doc = f'<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Charte graphique Rostra</title><style>{CSS}</style></head><body>{nbsp("".join(out))}</body></html>'
    OUT.mkdir(parents=True, exist_ok=True)
    src = SORTIE / 'charte.html'
    src.write_text(doc, encoding='utf-8', newline='\n')
    pdf = OUT / 'Charte graphique Rostra.pdf'
    with sync_playwright() as p:
        b = p.chromium.launch(channel='chrome')
        pg = b.new_page()
        pg.goto(src.as_uri(), wait_until='load'); pg.wait_for_timeout(1000)
        pg.pdf(path=str(pdf), prefer_css_page_size=True, print_background=True)
        # Aperçus PNG de chaque page, pour relecture.
        pg.set_viewport_size({'width': 1123, 'height': 794})
        prev = SORTIE / 'apercus'
        prev.mkdir(exist_ok=True)
        for f in prev.glob('*.png'):
            f.unlink()
        for k in range(total):
            pg.locator('section.page').nth(k).screenshot(path=str(prev / f'page-{k + 1:02d}.png'))
        b.close()
    print(f'{total} pages -> {pdf}')


if __name__ == '__main__':
    build()
