#!/usr/bin/env python3
"""Main extraction: building polygons + label glyph decoding for Unalakleet street plan.

Outputs extraction/extracted.json with buildings (polygon, centroid, decoded number),
landmarks, and diagnostics.
"""
import fitz, collections, json, math, sys

PDF = "/Users/cashrarrington/Downloads/unalakleet_street_plan.pdf"
OUT = "/Users/cashrarrington/Desktop/Surveyor/extraction/extracted.json"
LEGEND_X = 1840.0  # anything with x0 beyond this is legend panel

doc = fitz.open(PDF)
page = doc[0]
dr = page.get_drawings()

def fillkey(d):
    f = d.get("fill")
    return tuple(round(c, 3) for c in f) if f else None

TAN = (0.91, 0.851, 0.722)
RED = (0.878, 0.361, 0.361)
BLUE = (0.361, 0.561, 0.878)
DARK = (0.227, 0.192, 0.149)

# ---------------- Task 1: building polygons ----------------
def drawing_to_polys(d):
    """Convert a drawing's items into list of closed point-lists (subpaths)."""
    polys = []
    cur = []
    for it in d["items"]:
        if it[0] == 'l':
            p1, p2 = it[1], it[2]
            if cur and (abs(cur[-1][0]-p1.x) > 1e-4 or abs(cur[-1][1]-p1.y) > 1e-4):
                polys.append(cur); cur = []
            if not cur:
                cur.append((p1.x, p1.y))
            cur.append((p2.x, p2.y))
        elif it[0] == 're':
            if cur: polys.append(cur); cur = []
            r = it[1]
            polys.append([(r.x0,r.y0),(r.x1,r.y0),(r.x1,r.y1),(r.x0,r.y1)])
        elif it[0] == 'qu':
            if cur: polys.append(cur); cur = []
            q = it[1]
            polys.append([(q.ul.x,q.ul.y),(q.ur.x,q.ur.y),(q.lr.x,q.lr.y),(q.ll.x,q.ll.y)])
        elif it[0] == 'c':
            # flatten bezier with a few samples
            p1, c1, c2, p2 = it[1], it[2], it[3], it[4]
            if cur and (abs(cur[-1][0]-p1.x) > 1e-4 or abs(cur[-1][1]-p1.y) > 1e-4):
                polys.append(cur); cur = []
            if not cur:
                cur.append((p1.x, p1.y))
            for t in (0.25, 0.5, 0.75, 1.0):
                mt = 1-t
                x = mt**3*p1.x + 3*mt*mt*t*c1.x + 3*mt*t*t*c2.x + t**3*p2.x
                y = mt**3*p1.y + 3*mt*mt*t*c1.y + 3*mt*t*t*c2.y + t**3*p2.y
                cur.append((x, y))
    if cur:
        polys.append(cur)
    # drop duplicate closing point
    out = []
    for p in polys:
        if len(p) > 2 and abs(p[0][0]-p[-1][0]) < 1e-4 and abs(p[0][1]-p[-1][1]) < 1e-4:
            p = p[:-1]
        out.append(p)
    return out

def poly_area_centroid(pts):
    a = 0.0; cx = 0.0; cy = 0.0
    n = len(pts)
    for i in range(n):
        x0, y0 = pts[i]; x1, y1 = pts[(i+1) % n]
        cross = x0*y1 - x1*y0
        a += cross; cx += (x0+x1)*cross; cy += (y0+y1)*cross
    a *= 0.5
    if abs(a) < 1e-9:
        xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
        return 0.0, sum(xs)/n, sum(ys)/n
    return a, cx/(6*a), cy/(6*a)

def point_in_poly(x, y, pts):
    inside = False
    n = len(pts)
    j = n - 1
    for i in range(n):
        xi, yi = pts[i]; xj, yj = pts[j]
        if (yi > y) != (yj > y) and x < (xj-xi)*(y-yi)/(yj-yi)+xi:
            inside = not inside
        j = i
    return inside

buildings = []   # dicts: pts, cx, cy, rect
for d in dr:
    if fillkey(d) != TAN: continue
    if d["rect"].x0 > LEGEND_X: continue  # legend swatch
    # tan buildings drawn twice? check type
    polys = drawing_to_polys(d)
    # building should be a single closed polygon
    if len(polys) != 1:
        print("WARN: tan drawing with", len(polys), "subpaths at", d["rect"], "type", d.get("type"))
    pts = polys[0]
    a, cx, cy = poly_area_centroid(pts)
    buildings.append({"pts": pts, "cx": cx, "cy": cy,
                      "rect": tuple(d["rect"]), "type": d.get("type")})

print("tan building drawings (map area):", len(buildings))
tcount = collections.Counter(b["type"] for b in buildings)
print("types:", dict(tcount))

# dedupe if drawn twice (fs + f duplicates like labels)
seen = {}
for b in buildings:
    key = (round(b["cx"], 2), round(b["cy"], 2), len(b["pts"]))
    seen.setdefault(key, []).append(b)
uniq = [v[0] for v in seen.values()]
print("unique tan buildings:", len(uniq))
buildings = uniq

# red / blue landmark buildings
landmark_polys = {}
for d in dr:
    fk = fillkey(d)
    if fk not in (RED, BLUE): continue
    if d["rect"].x0 > LEGEND_X: continue
    polys = drawing_to_polys(d)
    pts = polys[0]
    a, cx, cy = poly_area_centroid(pts)
    name = "clinic" if fk == RED else "acc"
    landmark_polys[name] = {"pts": pts, "cx": cx, "cy": cy, "rect": tuple(d["rect"])}
print("landmarks found:", list(landmark_polys.keys()))
for k, v in landmark_polys.items():
    print("  ", k, "centroid", round(v["cx"],1), round(v["cy"],1))

# ---------------- Task 2: labels ----------------
# dark small drawings; keep only unique paths (drawn twice: 'fs' halo + 'f')
darks = [d for d in dr if fillkey(d) == DARK and d["rect"].width < 20 and d["rect"].height < 8]
labels_raw = [d for d in darks if d["rect"].x0 < LEGEND_X]
print("dark small fragments in map area:", len(labels_raw))
fcount = collections.Counter(d.get("type") for d in labels_raw)
print("fragment types:", dict(fcount))
labels = [d for d in labels_raw if d.get("type") == "f"]
if len(labels) != len(labels_raw) // 2:
    # fall back: dedupe by rect
    ded = {}
    for d in labels_raw:
        ded[tuple(round(v,3) for v in d["rect"])] = d
    labels = list(ded.values())
print("unique labels:", len(labels))

# split each label into glyphs: subpaths -> group by horizontal overlap (holes sit inside outer contour)
def label_glyphs(d):
    subs = drawing_to_polys(d)
    # bbox per subpath
    boxes = []
    for p in subs:
        xs = [q[0] for q in p]; ys = [q[1] for q in p]
        boxes.append([min(xs), min(ys), max(xs), max(ys), p])
    # group subpaths whose x-ranges overlap
    boxes.sort(key=lambda b: b[0])
    groups = []
    for b in boxes:
        placed = False
        for g in groups:
            gx0 = min(x[0] for x in g); gx1 = max(x[2] for x in g)
            if b[0] < gx1 - 0.05 and b[2] > gx0 + 0.05:
                g.append(b); placed = True; break
        if not placed:
            groups.append([b])
    glyphs = []
    for g in groups:
        gx0 = min(x[0] for x in g); gy0 = min(x[1] for x in g)
        gx1 = max(x[2] for x in g); gy1 = max(x[3] for x in g)
        glyphs.append({"bbox": (gx0, gy0, gx1, gy1), "subs": [x[4] for x in g]})
    glyphs.sort(key=lambda gl: gl["bbox"][0])
    return glyphs

def glyph_signature(gl):
    """Points of all subpaths relative to glyph bbox origin, scale-normalized
    by glyph height (labels come in several font sizes), quantized."""
    gx0, gy0, gx1, gy1 = gl["bbox"]
    h = gy1 - gy0
    sig = []
    for p in gl["subs"]:
        sub = tuple((round((x-gx0)/h*50)/50, round((y-gy0)/h*50)/50) for x, y in p)
        sig.append(sub)
    sig.sort()
    return tuple(sig)

all_labels = []
for d in labels:
    gls = label_glyphs(d)
    r = d["rect"]
    all_labels.append({"rect": tuple(r), "cx": (r.x0+r.x1)/2, "cy": (r.y0+r.y1)/2, "glyphs": gls})

glyph_count = sum(len(l["glyphs"]) for l in all_labels)
print("total glyphs:", glyph_count, "(expect 1020 for 1..376)")
ndig = collections.Counter(len(l["glyphs"]) for l in all_labels)
print("digits per label:", dict(ndig), "(expect 1:9, 2:90, 3:277)")

# classify glyphs by normalized signature
exact = {}
for l in all_labels:
    for gl in l["glyphs"]:
        s = glyph_signature(gl)
        gl["sig"] = s
        exact.setdefault(s, []).append(gl)
print("exact signature classes:", len(exact))

def sigdist(a, b):
    if len(a) != len(b): return 1e9
    m = 0.0
    for sa, sb in zip(a, b):
        if len(sa) != len(sb): return 1e9
        for pa, pb in zip(sa, sb):
            m = max(m, abs(pa[0]-pb[0]), abs(pa[1]-pb[1]))
            if m >= 1e9: return m
    return m

# fuzzy merge exact classes into final classes
merged = []  # list of [rep_sig, [exact_sigs], count]
for k in sorted(exact, key=lambda k: -len(exact[k])):
    hit = None
    for m in merged:
        if sigdist(k, m[0]) < 0.12:
            hit = m; break
    if hit:
        hit[1].append(k); hit[2] += len(exact[k])
    else:
        merged.append([k, [k], len(exact[k])])
merged.sort(key=lambda m: -m[2])
print("merged classes:", len(merged))
sig_to_cid = {}
for i, m in enumerate(merged):
    for s in m[1]:
        sig_to_cid[s] = i
    print(f"class {i}: count {m[2]}, subpaths {len(m[0])}, "
          f"norm w={round(max(p[0] for sub in m[0] for p in sub),2)}")

# per-label class sequence (left to right)
for l in all_labels:
    l["cids"] = [sig_to_cid[gl["sig"]] for gl in l["glyphs"]]

# ---------------- solve class -> digit ----------------
# expected digit frequency in 1..376
exp = collections.Counter()
for n in range(1, 377):
    for ch in str(n):
        exp[ch] += 1
print("expected digit freq:", dict(sorted(exp.items())))
obs = collections.Counter()
for l in all_labels:
    for c in l["cids"]:
        obs[c] += 1
print("observed class freq:", dict(sorted(obs.items())))

# candidate digits per class by frequency match
cands = {c: [d_ for d_ in exp if exp[d_] == obs[c]] for c in obs}
print("freq-based candidates:", cands)

# NOTE: the set {1..376} admits digit-swap automorphisms (1<->2, any perm of
# {4,5,6}, 8<->9), so the set constraint alone allows 24 mappings (see
# disambiguate.py). Filtering by glyph topology (subpath count: '8' has 3
# subpaths, '0'/'4'/'6'/'9' have 2, rest 1) leaves 4. The final mapping below
# was fixed by visually identifying a rendered sample of every class
# (extraction/class_*.png, verified by eye): 0='1' 1='2' 2='3' 3='4' 4='5'
# 5='6' 6='7' 7='9' 8='0' 9='8'.
solution = {0: '1', 1: '2', 2: '3', 3: '4', 4: '5', 5: '6', 6: '7', 7: '9', 8: '0', 9: '8'}
# sanity: mapping must respect frequency candidates and yield exactly {1..376}
for c, d_ in solution.items():
    assert d_ in cands[c], f"class {c} digit {d_} conflicts with frequency"
print("SOLUTION class->digit (visually verified):", solution)

for l in all_labels:
    l["n"] = int("".join(solution[c] for c in l["cids"]))
nums = sorted(l["n"] for l in all_labels)
assert nums == list(range(1, 377)), "decoded set mismatch!"
print("PROVEN: decoded numbers are exactly 1..376")

# ---------------- associate labels with buildings ----------------
assigned = {}
unmatched = []
for l in all_labels:
    hits = [i for i, b in enumerate(buildings) if point_in_poly(l["cx"], l["cy"], b["pts"])]
    if len(hits) == 1:
        i = hits[0]
    else:
        # nearest centroid
        i = min(range(len(buildings)), key=lambda i: (buildings[i]["cx"]-l["cx"])**2 + (buildings[i]["cy"]-l["cy"])**2)
        if not hits:
            unmatched.append((l["n"], l["cx"], l["cy"], i))
    if i in assigned:
        print("CONFLICT: building", i, "gets labels", assigned[i], "and", l["n"])
    assigned[i] = l["n"]
print("labels not inside any polygon (nearest used):", len(unmatched), unmatched[:10])
print("buildings with labels:", len(assigned), "of", len(buildings))
missing = [i for i in range(len(buildings)) if i not in assigned]
print("buildings without label:", missing)

# check clinic/ACC for labels
for name, lp in landmark_polys.items():
    inside = [l["n"] for l in all_labels if point_in_poly(l["cx"], l["cy"], lp["pts"])]
    print(name, "contains labels:", inside)

# ---------------- write result ----------------
out = {
    "buildings": [
        {"n": assigned[i],
         "cx": round(b["cx"], 1), "cy": round(b["cy"], 1),
         "pts": [[round(x, 1), round(y, 1)] for x, y in b["pts"]]}
        for i, b in enumerate(buildings) if i in assigned
    ],
    "landmarks": {k: {"cx": round(v["cx"], 1), "cy": round(v["cy"], 1),
                      "pts": [[round(x,1), round(y,1)] for x, y in v["pts"]]}
                  for k, v in landmark_polys.items()},
    "class_digit": solution,
}
out["buildings"].sort(key=lambda b: b["n"])
with open(OUT, "w") as f:
    json.dump(out, f)
print("wrote", OUT)
