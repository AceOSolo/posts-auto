"""Géométrie du logo Rostra : la bulle en tesselles (grille de 20) et le logotype vectorisé (Bagel Fat One)."""
import pathlib

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

HERE = pathlib.Path(__file__).parent
FONTS = HERE.parent / 'polices'
TRACKING = -0.01  # approche, en em

# --- Symbole : une bulle de parole faite de 4 × 3 tesselles et d'une queue inclinée.
# Pas de la grille 20, tesselle 17, joint 3. Les trois coins extérieurs de la bulle ont un rayon de 9,
# les autres angles un rayon de 3,2. La tesselle « soleil » (rangée 2, colonne 3) est la voix de chacun.
UNIT, TILE, R_SMALL, R_BIG = 20, 17, 3.2, 9
ACCENT = (1, 2)
OUTER = {(0, 0): 'tl', (0, 3): 'tr', (2, 3): 'br'}
TAIL = 'M8,57H30L2,79Z'
SYMBOL_BOX = (0, 0, 77, 79)  # x0, y0, x1, y1


def tile_path(row, col):
    x, y, t, r = col * UNIT, row * UNIT, TILE, R_SMALL
    tl = tr = br = bl = r
    corner = OUTER.get((row, col))
    if corner == 'tl':
        tl = R_BIG
    elif corner == 'tr':
        tr = R_BIG
    elif corner == 'br':
        br = R_BIG
    return (f'M{x + tl},{y}H{x + t - tr}A{tr},{tr} 0 0 1 {x + t},{y + tr}V{y + t - br}A{br},{br} 0 0 1 {x + t - br},{y + t}'
            f'H{x + bl}A{bl},{bl} 0 0 1 {x},{y + t - bl}V{y + tl}A{tl},{tl} 0 0 1 {x + tl},{y}Z')


def tiles():
    """Renvoie [(chemin, est_accent)] pour les 12 tesselles, puis la queue."""
    out = [(tile_path(r, c), (r, c) == ACCENT) for r in range(3) for c in range(4)]
    out.append((TAIL, False))
    return out


_font = None
def font():
    global _font
    if _font is None:
        _font = TTFont(FONTS / 'BagelFatOne.ttf')
    return _font


def _kern_table(f):
    """Paires de crénage GPOS (formats 1 et 2), en unités de police."""
    pairs = {}
    if 'GPOS' not in f:
        return pairs
    for lookup in f['GPOS'].table.LookupList.Lookup:
        for st in lookup.SubTable:
            if lookup.LookupType == 9:
                st = st.ExtSubTable
            if getattr(st, 'LookupType', lookup.LookupType) != 2:
                continue
            cov = st.Coverage.glyphs
            if st.Format == 1:
                for i, first in enumerate(cov):
                    for pvr in st.PairSet[i].PairValueRecord:
                        v = getattr(pvr.Value1, 'XAdvance', 0) if pvr.Value1 else 0
                        pairs.setdefault((first, pvr.SecondGlyph), v or 0)
            elif st.Format == 2:
                c1 = st.ClassDef1.classDefs; c2 = st.ClassDef2.classDefs
                for first in cov:
                    rec = st.Class1Record[c1.get(first, 0)]
                    for second, k2 in c2.items():
                        v = rec.Class2Record[k2].Value1
                        x = getattr(v, 'XAdvance', 0) if v else 0
                        if x:
                            pairs.setdefault((first, second), x)
    return pairs


_kern = None
def word_path(text='Rostra'):
    """Renvoie (d, (x0, y0, x1, y1), hauteur_capitale) en unités de police ; ligne de base à y=0, y vers le bas."""
    global _kern
    f = font(); gs = f.getGlyphSet(); cmap = f.getBestCmap(); hmtx = f['hmtx']
    if _kern is None:
        _kern = _kern_table(f)
    upm = f['head'].unitsPerEm
    names = [cmap[ord(ch)] for ch in text]
    x = 0; ds = []; bb = BoundsPen(gs)
    for i, g in enumerate(names):
        pen = SVGPathPen(gs)
        gs[g].draw(TransformPen(pen, (1, 0, 0, -1, x, 0)))
        gs[g].draw(TransformPen(bb, (1, 0, 0, 1, x, 0)))
        ds.append(pen.getCommands())
        x += hmtx[g][0] + TRACKING * upm
        if i + 1 < len(names):
            x += _kern.get((g, names[i + 1]), 0)
    cap = BoundsPen(gs); gs[cmap[ord('H')]].draw(cap)
    x0, y0, x1, y1 = bb.bounds
    return ' '.join(ds), (x0, -y1, x1, -y0), cap.bounds[3]
