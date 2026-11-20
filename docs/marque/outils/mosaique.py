"""Mosaïque Rostra : transforme une illustration en aplats (SVG) en tesselles posées « à la main ».

Règles (charte, partie « La mosaïque ») :
- une grille régulière ; chaque case prend la couleur majoritaire de l'illustration ;
- chaque tesselle est légèrement décalée (±6 %), tournée (±7°) et nuancée (±4,5 % de luminosité) ;
- les joints, en option, ne couvrent que la surface carrelée : ils suivent la silhouette.
Le tirage est déterminé par une graine : la même graine redonne la même mosaïque.

Usage en module : mosaic(svg_text, size, cell, seed=7, grout=None) -> texte SVG.
"""
import colorsys
import io
import random
from collections import Counter

from PIL import Image
from playwright.sync_api import sync_playwright


def _rasterize(svg_text, size):
    with sync_playwright() as p:
        b = p.chromium.launch(channel='chrome')
        pg = b.new_page(viewport={'width': size, 'height': size})
        pg.set_content(f'<style>html,body{{margin:0;background:transparent}}svg{{display:block;width:{size}px;height:{size}px}}</style>{svg_text}')
        png = pg.screenshot(omit_background=True)
        b.close()
    return Image.open(io.BytesIO(png)).convert('RGBA')


def _shade(rgb, k):
    h, l, s = colorsys.rgb_to_hls(*[v / 255 for v in rgb])
    l = max(0, min(1, l + k))
    return '#%02x%02x%02x' % tuple(round(v * 255) for v in colorsys.hls_to_rgb(h, l, s))


def mosaic(svg_text, size, cell, seed=7, grout=None, title=None):
    rng = random.Random(seed)
    img = _rasterize(svg_text, size)
    joints, tiles = [], []
    n = int(size / cell)
    for gy in range(n):
        for gx in range(n):
            x0, y0 = gx * cell, gy * cell
            samples = []
            for sx in (0.3, 0.5, 0.7):
                for sy in (0.3, 0.5, 0.7):
                    px = img.getpixel((min(size - 1, int(x0 + sx * cell)), min(size - 1, int(y0 + sy * cell))))
                    if px[3] >= 128:
                        samples.append(px[:3])
            if len(samples) < 5:
                continue
            rgb = Counter(samples).most_common(1)[0][0]
            if grout:
                joints.append(f'<rect x="{x0:.1f}" y="{y0:.1f}" width="{cell:.1f}" height="{cell:.1f}"/>')
            s = cell * rng.uniform(0.80, 0.90)
            cx = x0 + cell / 2 + rng.uniform(-0.06, 0.06) * cell
            cy = y0 + cell / 2 + rng.uniform(-0.06, 0.06) * cell
            a = rng.uniform(-7, 7)
            tiles.append(f'<rect x="{cx - s / 2:.1f}" y="{cy - s / 2:.1f}" width="{s:.1f}" height="{s:.1f}" rx="{cell * 0.12:.1f}" '
                         f'transform="rotate({a:.0f} {cx:.1f} {cy:.1f})" fill="{_shade(rgb, rng.uniform(-0.045, 0.045))}"/>')
    head = f'<title>{title}</title>' if title else ''
    role = 'role="img"' if title else 'aria-hidden="true"'
    grout_layer = f'<g fill="{grout}">{"".join(joints)}</g>' if grout else ''
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" {role}>{head}{grout_layer}{"".join(tiles)}</svg>\n'
