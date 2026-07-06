#!/usr/bin/env python3
"""Enumerate ALL constraint-valid class->digit mappings and render one sample
glyph per class for visual identification."""
import fitz, collections, itertools, json

PDF = "/Users/cashrarrington/Downloads/unalakleet_street_plan.pdf"
doc = fitz.open(PDF)
page = doc[0]

# ---- reuse extraction pipeline (import from extract.py logic, minimal copy) ----
import importlib.util, sys
spec = importlib.util.spec_from_file_location("extract_mod", "/Users/cashrarrington/Desktop/Surveyor/extraction/extract.py")
# extract.py runs everything at import; capture its globals
mod = importlib.util.module_from_spec(spec)
sys.argv = ["x"]
spec.loader.exec_module(mod)

all_labels = mod.all_labels
cands = mod.cands
classes_order = sorted(cands.keys())

# enumerate all valid mappings
solutions = []
def valid(mapping):
    nums = []
    for l in all_labels:
        s = "".join(mapping[c] for c in l["cids"])
        if s[0] == "0": return False
        nums.append(int(s))
    return sorted(nums) == list(range(1, 377))

def backtrack(i, mapping, used):
    if i == len(classes_order):
        if valid(mapping): solutions.append(dict(mapping))
        return
    c = classes_order[i]
    for d_ in cands[c]:
        if d_ in used: continue
        mapping[c] = d_; used.add(d_)
        backtrack(i+1, mapping, used)
        del mapping[c]; used.discard(d_)

backtrack(0, {}, set())
print("TOTAL VALID MAPPINGS:", len(solutions))
for s in solutions:
    print("  ", {k: s[k] for k in sorted(s)})

# subpath count per class (topology)
subn = {}
for l in all_labels:
    for gl, c in zip(l["glyphs"], l["cids"]):
        subn.setdefault(c, len(gl["subs"]))
print("subpaths per class:", dict(sorted(subn.items())))

# filter solutions by topology: '8' must have 3 subpaths; '0','9' 2; '1','2','3','5','7' 1; '4','6' either but same class count
HOLES = {'0': 2, '1': 1, '2': 1, '3': 1, '5': 1, '7': 1, '8': 3, '9': 2}  # 4,6 unknown a priori
topo_ok = []
for s in solutions:
    ok = all(subn[c] == HOLES[d] for c, d in s.items() if d in HOLES)
    if ok: topo_ok.append(s)
print("topology-consistent mappings:", len(topo_ok))
for s in topo_ok:
    print("  ", {k: s[k] for k in sorted(s)})

# render one sample glyph per class at high dpi into a contact sheet
sample = {}
for l in all_labels:
    for gl, c in zip(l["glyphs"], l["cids"]):
        if c not in sample and gl["bbox"][3]-gl["bbox"][1] > 4:  # prefer large font instance
            sample[c] = gl
for l in all_labels:  # fill any missing with any instance
    for gl, c in zip(l["glyphs"], l["cids"]):
        sample.setdefault(c, gl)

tiles = []
for c in sorted(sample):
    b = sample[c]["bbox"]
    pad = 0.6
    clip = fitz.Rect(b[0]-pad, b[1]-pad, b[2]+pad, b[3]+pad)
    pix = page.get_pixmap(clip=clip, dpi=2400, colorspace=fitz.csGRAY)
    tiles.append((c, pix))
    print("class", c, "sample bbox", [round(v,1) for v in b], "pix", pix.width, pix.height)

# compose contact sheet with PIL-free approach: save individual tiles
for c, pix in tiles:
    pix.save(f"/Users/cashrarrington/Desktop/Surveyor/extraction/class_{c}.png")
print("saved class_*.png")
