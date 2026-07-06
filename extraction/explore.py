#!/usr/bin/env python3
"""Initial exploration of the PDF drawings."""
import fitz, collections, json

doc = fitz.open("/Users/cashrarrington/Downloads/unalakleet_street_plan.pdf")
page = doc[0]
print("page rect:", page.rect)

dr = page.get_drawings()
print("drawings:", len(dr))

fills = collections.Counter()
for d in dr:
    f = d.get("fill")
    key = tuple(round(c, 3) for c in f) if f else None
    fills[key] += 1
print("fill census:")
for k, v in fills.most_common(20):
    print("  ", k, v)

# item type census per fill color group
TAN = (0.91, 0.851, 0.722)
RED = (0.878, 0.361, 0.361)
BLUE = (0.361, 0.561, 0.878)
DARK = (0.227, 0.192, 0.149)

def keyof(d):
    f = d.get("fill")
    return tuple(round(c, 3) for c in f) if f else None

for name, col in [("TAN", TAN), ("RED", RED), ("BLUE", BLUE), ("DARK", DARK)]:
    items = collections.Counter()
    rects = []
    n = 0
    for d in dr:
        if keyof(d) == col:
            n += 1
            for it in d["items"]:
                items[it[0]] += 1
            r = d["rect"]
            rects.append((r.width, r.height, r.x0, r.y0))
    print(name, n, dict(items))
    ws = sorted(r[0] for r in rects)
    hs = sorted(r[1] for r in rects)
    print("   width min/med/max:", ws[0], ws[len(ws)//2], ws[-1])
    print("   height min/med/max:", hs[0], hs[len(hs)//2], hs[-1])
    # x range
    xs = sorted(r[2] for r in rects)
    print("   x0 min/max:", xs[0], xs[-1])

# text census
text = page.get_text("dict")
spans = []
for b in text["blocks"]:
    for l in b.get("lines", []):
        for s in l["spans"]:
            spans.append((s["text"], round(s["bbox"][0],1), round(s["bbox"][1],1), round(s["size"],1)))
print("text spans:", len(spans))
for s in spans[:60]:
    print("  ", s)
