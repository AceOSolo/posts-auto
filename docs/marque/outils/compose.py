"""Assemble les versions du logo Rostra en SVG (horizontal, vertical, symbole, logotype) et leurs 4 couleurs."""
from geom import SYMBOL_BOX, TILE, tiles, word_path

# tile : tesselles et queue ; accent : la tesselle soleil (None = tesselle évidée) ; name : le nom.
COLORS = {
    'couleur': {'tile': '#DF1C60', 'accent': '#FFC93C', 'name': '#1E1A45'},
    'negatif': {'tile': '#DF1C60', 'accent': '#FFC93C', 'name': '#FFF4E2'},
    'noir':    {'tile': '#000000', 'accent': None, 'name': '#000000'},
    'blanc':   {'tile': '#FFFFFF', 'accent': None, 'name': '#FFFFFF'},
}
SX0, SY0, SX1, SY1 = SYMBOL_BOX
SH = SY1 - SY0            # hauteur du symbole (79)
SW = SX1 - SX0            # largeur du symbole (77)


def symbol_paths(c, classes=False):
    """Tesselles du symbole, dans le repère de la grille. classes=True : couleurs en classes CSS."""
    out = []
    for d, accent in tiles():
        if accent and c.get('accent') is None:
            # Monochrome : la tesselle soleil est évidée (contour seul).
            out.append(f'<path {"class=\"logo-tile\"" if classes else f"fill=\"{c["tile"]}\""} fill-rule="evenodd" d="{d} {_inner(d)}"/>')
        elif accent:
            out.append(f'<path {"class=\"logo-accent\"" if classes else f"fill=\"{c["accent"]}\""} d="{d}"/>')
        else:
            out.append(f'<path {"class=\"logo-tile\"" if classes else f"fill=\"{c["tile"]}\""} d="{d}"/>')
    return ''.join(out)


def _inner(d):
    # Tesselle évidée : carré intérieur (trait de 3 unités), centré dans la tesselle d'accent (rangée 1, colonne 2).
    x, y, w = 40 + 3, 20 + 3, TILE - 6
    return f'M{x + 1.5},{y}H{x + w - 1.5}A1.5,1.5 0 0 1 {x + w},{y + 1.5}V{y + w - 1.5}A1.5,1.5 0 0 1 {x + w - 1.5},{y + w}H{x + 1.5}A1.5,1.5 0 0 1 {x},{y + w - 1.5}V{y + 1.5}A1.5,1.5 0 0 1 {x + 1.5},{y}Z'


def symbol_group(c, x, y, h, classes=False):
    s = h / SH
    return f'<g transform="translate({x:.3f} {y:.3f}) scale({s:.5f}) translate({-SX0} {-SY0})">{symbol_paths(c, classes)}</g>'


def name_group(c, x, baseline, cap_px, classes=False):
    d, (bx0, by0, bx1, by1), cap = word_path()
    s = cap_px / cap
    fill = 'class="logo-name"' if classes else f'fill="{c["name"]}"'
    return f'<g transform="translate({x - bx0 * s:.3f} {baseline:.3f}) scale({s:.6f})"><path {fill} d="{d}"/></g>', (bx1 - bx0) * s, -by0 * s, by1 * s


def svg(w, h, body, title='Rostra'):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:.2f} {h:.2f}" width="{w:.0f}" height="{h:.0f}" role="img" aria-label="{title}">'
            f'<title>{title}</title>{body}</svg>\n')


# Proportions (H = hauteur du symbole, L = largeur du symbole)
CAP = 0.52      # hauteur des capitales du nom, version horizontale
GAP_H = 0.22    # espace symbole-nom, version horizontale
V_WIDTH = 2.5   # largeur du nom, version verticale, en L
GAP_V = 0.16    # espace symbole-nom, version verticale, en L


def horizontal(color, H=200, classes=False):
    c = COLORS[color]
    cap_px = CAP * H
    tiles_h = 57 / SH * H                     # hauteur des tesselles, sans la queue
    baseline = tiles_h / 2 + cap_px / 2       # capitales centrées sur les tesselles
    sw = SW / SH * H
    g, nw, asc, desc = name_group(c, sw + GAP_H * H, baseline, cap_px, classes)
    top = min(0, baseline - asc); bottom = max(H, baseline + desc)
    w = sw + GAP_H * H + nw
    return svg(w, bottom - top, f'<g transform="translate(0 {-top:.3f})">{symbol_group(c, 0, 0, H, classes)}{g}</g>')


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


def symbol(color, H=200, classes=False):
    c = COLORS[color]
    return svg(SW / SH * H, H, symbol_group(c, 0, 0, H, classes))


def logotype(color, cap_px=200):
    c = COLORS[color]
    d, (bx0, by0, bx1, by1), cap = word_path()
    s = cap_px / cap
    g, nw, asc, desc = name_group(c, 0, -by0 * s, cap_px)
    return svg(nw, (by1 - by0) * s, g)


VERSIONS = {'horizontal': horizontal, 'vertical': vertical, 'symbole': symbol, 'logotype': logotype}
