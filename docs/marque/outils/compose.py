"""Assemble les versions du logo Rostra en SVG."""
from geom import COLUMN, BUBBLE, RAM, SYMBOL_BOX, word_path

COLORS = {
    'couleur': {'column': '#221C1A', 'speech': '#A8372A', 'name': '#221C1A'},
    'negatif': {'column': '#F5EFE4', 'speech': '#E98B72', 'name': '#F5EFE4'},
    'noir':    {'column': '#000000', 'speech': '#000000', 'name': '#000000'},
    'blanc':   {'column': '#FFFFFF', 'speech': '#FFFFFF', 'name': '#FFFFFF'},
}
SX0, SY0, SX1, SY1 = SYMBOL_BOX
SH = SY1 - SY0            # hauteur du symbole (96)
SW = SX1 - SX0            # largeur du symbole (102)

def symbol_group(c, x, y, h):
    s = h / SH
    return (f'<g transform="translate({x:.3f} {y:.3f}) scale({s:.5f}) translate({-SX0} {-SY0})">'
            f'<path fill="{c["column"]}" d="{COLUMN}"/>'
            f'<path fill="{c["speech"]}" fill-rule="evenodd" d="{BUBBLE}"/>'
            f'<path fill="{c["speech"]}" d="{RAM}"/></g>')

def name_group(c, x, baseline, cap_px):
    d, (bx0, by0, bx1, by1), cap = word_path()
    s = cap_px / cap
    return f'<g transform="translate({x - bx0 * s:.3f} {baseline:.3f}) scale({s:.6f})"><path fill="{c["name"]}" d="{d}"/></g>', (bx1 - bx0) * s, -by0 * s, by1 * s

def svg(w, h, body, title='Rostra'):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:.2f} {h:.2f}" width="{w:.0f}" height="{h:.0f}" role="img" aria-label="{title}">'
            f'<title>{title}</title>{body}</svg>\n')

# Proportions (H = hauteur du symbole)
CAP = 0.56      # hauteur des capitales du nom
GAP_H = 0.34    # espace symbole-nom, version horizontale
V_WIDTH = 2.3   # largeur du nom en L (largeur du symbole), version verticale
GAP_V = 0.30    # espace symbole-nom, version verticale, en L

def horizontal(color, H=200):
    c = COLORS[color]
    cap_px = CAP * H
    # nom : capitales centrées sur le symbole
    baseline = H / 2 + cap_px / 2
    sw = SW / SH * H
    g, nw, asc, desc = name_group(c, sw + GAP_H * H, baseline, cap_px)
    top = min(0, baseline - asc); bottom = max(H, baseline + desc)
    w = sw + GAP_H * H + nw
    return svg(w, bottom - top, f'<g transform="translate(0 {-top:.3f})">{symbol_group(c, 0, 0, H)}{g}</g>')

def vertical(color, L=200):
    c = COLORS[color]
    H = L * SH / SW
    d, (bx0, by0, bx1, by1), cap = word_path()
    nw = V_WIDTH * L; s = nw / (bx1 - bx0); cap_px = cap * s
    asc, desc = -by0 * s, by1 * s
    W = max(nw, L)
    baseline = H + GAP_V * L + asc
    g, _, _, _ = name_group(c, (W - nw) / 2, baseline, cap_px)
    return svg(W, baseline + desc, symbol_group(c, (W - L) / 2, 0, H) + g)

def symbol(color, H=200):
    c = COLORS[color]
    return svg(SW / SH * H, H, symbol_group(c, 0, 0, H))

def logotype(color, cap_px=200):
    c = COLORS[color]
    d, (bx0, by0, bx1, by1), cap = word_path()
    s = cap_px / cap
    g, nw, asc, desc = name_group(c, 0, -by0 * s, cap_px)
    return svg(nw, (by1 - by0) * s, g)

VERSIONS = {'horizontal': horizontal, 'vertical': vertical, 'symbole': symbol, 'logotype': logotype}
