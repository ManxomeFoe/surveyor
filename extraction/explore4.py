#!/usr/bin/env python3
"""Understand fragment duplication; split drawings into subpaths/glyphs."""
import fitz, collections

doc = fitz.open("/Users/cashrarrington/Downloads/unalakleet_street_plan.pdf")
page = doc[0]
dr = page.get_drawings()

def keyof(d):
    f = d.get("fill")
    return tuple(round(c, 3) for c in f) if f else None

DARK = (0.227, 0.192, 0.149)
small = [d for d in dr if keyof(d) == DARK and d["rect"].width < 20 and d["rect"].height < 8]

# cluster 0 area: x ~1113-1118, y ~122-128
frs = [d for d in small if d["rect"].x0 < 1120 and d["rect"].x1 > 1112 and d["rect"].y0 < 130 and d["rect"].y1 > 120]
print("fragments near building 1 label:", len(frs))
for d in frs:
    print(" rect:", d["rect"], "n_items:", len(d["items"]), "types:", collections.Counter(it[0] for it in d["items"]),
          "even_odd:", d.get("even_odd"), "stroke:", d.get("color"), "fill_opacity:", d.get("fill_opacity"), "type:", d.get("type"))
    for it in d["items"][:4]:
        print("   ", it[0], it[1], it[2] if it[0]=='l' else '')

# Are the 2 fragments per cluster identical paths?
def sig(d):
    pts = []
    for it in d["items"]:
        if it[0] == 'l':
            pts.append((round(it[1].x,2), round(it[1].y,2)))
        elif it[0] == 'c':
            pts.append((round(it[1].x,2), round(it[1].y,2)))
    return tuple(pts)

if len(frs) == 2:
    print("identical paths:", sig(frs[0]) == sig(frs[1]))
