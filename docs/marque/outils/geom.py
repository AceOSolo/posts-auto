"""Géométrie du logo Rostra : symbole (grille 120) et logotype vectorisé (Fraunces instanciée)."""
import pathlib
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen

HERE = pathlib.Path(__file__).parent
FONTS = HERE.parent / 'fonts'
AXES = {'wght': 650, 'opsz': 144, 'SOFT': 50, 'WONK': 0}
TRACKING = -0.012  # approche, en em

# --- Symbole : colonne (tribune), bulle (parole), éperon (proue). Grille 120, colonne soudée à la bulle.
COLUMN = 'M12,12H41V108H12Z'
BUBBLE = 'M40,12H78A30,30 0 0 1 78,72H40Z M74,30A12,12 0 1 0 74.001,30Z'
RAM = 'M62,66H94L114,108Z'
SYMBOL_BOX = (12, 12, 114, 108)  # x0, y0, x1, y1

_font = None
def font():
    global _font
    if _font is None:
        f = TTFont(FONTS / 'Fraunces.ttf')
        _font = instantiateVariableFont(f, AXES)
    return _font

def _kern_table(f):
    """Paires de crénage GPOS (formats 1 et 2), en unités de police."""
    pairs = {}
    gpos = f['GPOS'].table
    for lookup in gpos.LookupList.Lookup:
        subs = lookup.SubTable
        for st in subs:
            if lookup.LookupType == 9:
                st = st.ExtSubTable
            if getattr(st, 'LookupType', lookup.LookupType) != 2:
                continue
            cov = st.Coverage.glyphs
            if st.Format == 1:
                for i, first in enumerate(cov):
                    for pvr in st.PairSet[i].PairValueRecord:
                        v = pvr.Value1.XAdvance if pvr.Value1 and hasattr(pvr.Value1, 'XAdvance') else 0
                        pairs.setdefault((first, pvr.SecondGlyph), v or 0)
            elif st.Format == 2:
                c1 = st.ClassDef1.classDefs; c2 = st.ClassDef2.classDefs
                for first in cov:
                    k1 = c1.get(first, 0)
                    rec = st.Class1Record[k1]
                    for second, k2 in list(c2.items()) + []:
                        v = rec.Class2Record[k2].Value1
                        x = getattr(v, 'XAdvance', 0) if v else 0
                        if x: pairs.setdefault((first, second), x)
    return pairs

_kern = None
def word_path(text='Rostra'):
    """Renvoie (d, largeur, ascent_capitale) en unités de police, ligne de base à y=0, y vers le bas."""
    global _kern
    f = font(); gs = f.getGlyphSet(); cmap = f.getBestCmap(); hmtx = f['hmtx']
    if _kern is None: _kern = _kern_table(f)
    upm = f['head'].unitsPerEm
    names = [cmap[ord(ch)] for ch in text]
    x = 0; ds = []
    for i, g in enumerate(names):
        pen = SVGPathPen(gs)
        gs[g].draw(TransformPen(pen, (1, 0, 0, -1, x, 0)))
        ds.append(pen.getCommands())
        x += hmtx[g][0] + TRACKING * upm
        if i + 1 < len(names):
            x += _kern.get((g, names[i + 1]), 0)
    width = x - TRACKING * upm
    bp = BoundsPen(gs); gs[cmap[ord('H')]].draw(bp)
    cap = bp.bounds[3]
    # Bornes réelles du mot
    bb = BoundsPen(gs); xx = 0
    for i, g in enumerate(names):
        gs[g].draw(TransformPen(bb, (1, 0, 0, 1, xx, 0)))
        xx += hmtx[g][0] + TRACKING * upm + (_kern.get((g, names[i + 1]), 0) if i + 1 < len(names) else 0)
    x0, y0, x1, y1 = bb.bounds
    return ' '.join(ds), (x0, -y1, x1, -y0), cap

if __name__ == '__main__':
    d, bounds, cap = word_path()
    print('bounds', bounds, 'cap', cap, 'kern pairs', len(_kern))
    for p in [('R','o'),('o','s'),('s','t'),('t','r'),('r','a')]:
        f=font(); cmap=f.getBestCmap(); print(p, _kern.get((cmap[ord(p[0])],cmap[ord(p[1])]),0))
