#!/usr/bin/env python3
"""Cluster dark label fragments spatially; render a sample crop."""
import fitz, collections

doc = fitz.open("/Users/cashrarrington/Downloads/unalakleet_street_plan.pdf")
page = doc[0]
dr = page.get_drawings()

def keyof(d):
    f = d.get("fill")
    return tuple(round(c, 3) for c in f) if f else None

DARK = (0.227, 0.192, 0.149)
small = [d for d in dr if keyof(d) == DARK and d["rect"].width < 20 and d["rect"].height < 8]
print("small dark fragments:", len(small))

# union-find cluster by rect proximity (expand 1.5pt, overlap)
rects = [d["rect"] for d in small]
parent = list(range(len(rects)))
def find(i):
    while parent[i] != i:
        parent[i] = parent[parent[i]]
        i = parent[i]
    return i
def union(i, j):
    parent[find(i)] = find(j)

exp = [fitz.Rect(r.x0-1.2, r.y0-1.2, r.x1+1.2, r.y1+1.2) for r in rects]
# sort by x for locality; naive O(n^2) fine for 755
for i in range(len(rects)):
    for j in range(i+1, len(rects)):
        if exp[i].intersects(exp[j]):
            union(i, j)

clusters = collections.defaultdict(list)
for i in range(len(rects)):
    clusters[find(i)].append(i)
print("clusters:", len(clusters))
csizes = collections.Counter(len(v) for v in clusters.values())
print("cluster size histogram:", dict(csizes))

# sample: render a crop around the first cluster at high dpi
ks = sorted(clusters.keys(), key=lambda k: (rects[k].y0, rects[k].x0))
for idx, k in enumerate(ks[:3]):
    bbox = fitz.Rect(rects[clusters[k][0]])
    for i in clusters[k][1:]:
        bbox |= rects[i]
    crop = fitz.Rect(bbox.x0-15, bbox.y0-15, bbox.x1+15, bbox.y1+15)
    pix = page.get_pixmap(clip=crop, dpi=1200)
    pix.save(f"/Users/cashrarrington/Desktop/Surveyor/extraction/sample_cluster_{idx}.png")
    print("cluster", idx, "bbox", bbox, "frag count", len(clusters[k]))

# dump structure of one small drawing
d = small[0]
print("\nsample drawing rect:", d["rect"], "even_odd:", d.get("even_odd"), "closePath:", d.get("closePath"))
print("items count:", len(d["items"]))
for it in d["items"][:12]:
    print("  ", it)
