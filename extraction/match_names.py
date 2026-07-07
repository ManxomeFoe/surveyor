#!/usr/bin/env python3
"""Match NOAA OCM named structures (Dewberry 2025) to our buildings via the
published georef affine; emit name->building assignments."""
import json, math

EX = json.load(open("/Users/cashrarrington/Desktop/Surveyor/extraction/extracted.json"))
G = json.load(open("/Users/cashrarrington/Desktop/Surveyor/extraction/georef_result.json"))
NS = json.load(open("/Users/cashrarrington/Desktop/Surveyor/extraction/noaa_structures.json"))
a, b, c, d_, e, f = G["toMap"]

def centroid_ll(rings):
    """area centroid of outer ring, computed on centered coords (avoid
    catastrophic cancellation on raw lon/lat)."""
    pts = rings[0]
    if pts[0] == pts[-1]: pts = pts[:-1]
    x0r, y0r = pts[0]
    P = [(x - x0r, y - y0r) for x, y in pts]
    A = cx = cy = 0.0
    n = len(P)
    for i in range(n):
        xa, ya = P[i]; xb, yb = P[(i+1) % n]
        cr = xa*yb - xb*ya
        A += cr; cx += (xa+xb)*cr; cy += (ya+yb)*cr
    A *= 0.5
    if abs(A) < 1e-18:
        return x0r + sum(p[0] for p in P)/n, y0r + sum(p[1] for p in P)/n
    return x0r + cx/(6*A), y0r + cy/(6*A)

def to_page(lon, lat):
    return a*lon + b*lat + c, d_*lon + e*lat + f

def point_in_poly(x, y, pts):
    inside = False
    j = len(pts) - 1
    for i in range(len(pts)):
        xi, yi = pts[i]; xj, yj = pts[j]
        if (yi > y) != (yj > y) and x < (xj-xi)*(y-yi)/(yj-yi)+xi:
            inside = not inside
        j = i
    return inside

# target polygons: numbered buildings + landmarks
targets = [{"tag": bld["n"], "pts": bld["pts"], "cx": bld["cx"], "cy": bld["cy"]} for bld in EX["buildings"]]
for tag in ("clinic", "acc"):
    lm = EX["landmarks"][tag]
    targets.append({"tag": tag, "pts": lm["pts"], "cx": lm["cx"], "cy": lm["cy"]})

named = [ft for ft in NS["features"] if (ft["attributes"].get("Structure_Name") or "").strip()]
print("named structures:", len(named))

matches = []   # (name, type, page x, page y, target tag or None, dist)
for ft in named:
    name = ft["attributes"]["Structure_Name"].strip()
    styp = ft["attributes"]["Structure_Type"]
    lon, lat = centroid_ll(ft["geometry"]["rings"])
    px, py = to_page(lon, lat)
    hit = [t for t in targets if point_in_poly(px, py, t["pts"])]
    if hit:
        t = hit[0]
        matches.append({"name": name, "type": styp, "px": px, "py": py,
                        "tag": t["tag"], "dist": math.hypot(t["cx"]-px, t["cy"]-py), "how": "inside"})
    else:
        t = min(targets, key=lambda t: (t["cx"]-px)**2 + (t["cy"]-py)**2)
        dist = math.hypot(t["cx"]-px, t["cy"]-py)
        matches.append({"name": name, "type": styp, "px": px, "py": py,
                        "tag": t["tag"] if dist <= 15 else None, "dist": dist,
                        "how": "near" if dist <= 15 else "unmatched"})

for m in sorted(matches, key=lambda m: (m["how"], m["dist"])):
    print(f"{m['how']:9s} {str(m['tag']):8s} d={m['dist']:6.1f}  {m['name']}")

# conflicts: multiple names on one target
from collections import defaultdict
bytag = defaultdict(list)
for m in matches:
    if m["tag"] is not None:
        bytag[m["tag"]].append(m)
print("\nconflicts:")
for tag, ms in bytag.items():
    if len(ms) > 1:
        print(" ", tag, [(m["name"], round(m["dist"],1), m["how"]) for m in ms])

json.dump(matches, open("/Users/cashrarrington/Desktop/Surveyor/extraction/name_matches.json", "w"), indent=1)
print("\nwrote name_matches.json;",
      sum(1 for m in matches if m["tag"] is not None), "matched,",
      sum(1 for m in matches if m["tag"] is None), "unmatched")
