#!/usr/bin/env python3
"""Georef attempt 2: RANSAC on area-compatible pairs, then ICP refine."""
import json, math, random

EX = json.load(open("/Users/cashrarrington/Desktop/Surveyor/extraction/extracted.json"))
OSM = json.load(open("/Users/cashrarrington/Desktop/Surveyor/extraction/osm_buildings.json"))

def area_centroid(pts):
    a = cx = cy = 0.0
    n = len(pts)
    for i in range(n):
        x0, y0 = pts[i]; x1, y1 = pts[(i+1) % n]
        cr = x0*y1 - x1*y0
        a += cr; cx += (x0+x1)*cr; cy += (y0+y1)*cr
    a *= 0.5
    if abs(a) < 1e-16:
        return sum(p[0] for p in pts)/n, sum(p[1] for p in pts)/n, 0.0
    return cx/(6*a), cy/(6*a), abs(a)

lat0 = 63.878
MLAT = 111320.0
MLON = 111320.0 * math.cos(math.radians(lat0))

# OSM: centroid in meters (local frame) + area m^2
osm = []
for e in OSM["elements"]:
    g = e.get("geometry")
    if not g or len(g) < 4: continue
    pts = [((p["lon"]+160.8)*MLON, (p["lat"]-lat0)*MLAT) for p in g]
    if pts[0] == pts[-1]: pts = pts[:-1]
    E, N, A = area_centroid(pts)
    # NOTE: never run the shoelace centroid on raw lon/lat (magnitude ~160):
    # catastrophic cancellation corrupts the centroid at the ~1e-3 deg level.
    # Derive lon/lat from the metric centroid computed on centered coords.
    lonc = E/MLON - 160.8
    latc = N/MLAT + lat0
    osm.append({"id": e["id"], "E": E, "N": N, "A": A, "lon": lonc, "lat": latc})
print("osm:", len(osm))

# map: centroid page units + area page^2 (page y down)
mappts = []
for b in EX["buildings"]:
    _, _, A = 0, 0, None
    cx, cy, A = area_centroid(b["pts"])
    mappts.append({"tag": b["n"], "x": b["cx"], "y": b["cy"], "A": A})
for tag in ("clinic", "acc"):
    lm = EX["landmarks"][tag]
    cx, cy, A = area_centroid(lm["pts"])
    mappts.append({"tag": tag, "x": lm["cx"], "y": lm["cy"], "A": A})
print("map:", len(mappts))

UPM0 = 72/(0.0254*3000)
AREA_R = UPM0*UPM0  # page^2 per m^2 nominal

# candidate pairs by area compatibility, biased to LARGE distinctive buildings
osm_sorted = sorted(osm, key=lambda o: -o["A"])
map_sorted = sorted(mappts, key=lambda m: -m["A"])
big_map = map_sorted[:25]
cand = []
for m in big_map:
    for o in osm_sorted[:40]:
        pred = o["A"]*AREA_R
        if abs(pred - m["A"]) / max(m["A"], 1) < 0.25:
            cand.append((m, o))
print("candidate big pairs:", len(cand))

def similarity_from2(m1, o1, m2, o2):
    """similarity transform (map page -> osm meters) from 2 pairs.
    map frame: (x, -y) to make it north-up-ish."""
    p1 = (m1["x"], -m1["y"]); p2 = (m2["x"], -m2["y"])
    q1 = (o1["E"], o1["N"]); q2 = (o2["E"], o2["N"])
    vp = (p2[0]-p1[0], p2[1]-p1[1]); vq = (q2[0]-q1[0], q2[1]-q1[1])
    lp = math.hypot(*vp); lq = math.hypot(*vq)
    if lp < 1 or lq < 1: return None
    s = lq/lp
    if not (0.9 < s*UPM0 < 1.1):  # scale must be near nominal
        return None
    ang = math.atan2(vq[1], vq[0]) - math.atan2(vp[1], vp[0])
    if abs(math.degrees(ang)) > 8: return None  # near north-up
    ca, sa = math.cos(ang), math.sin(ang)
    # q = s*R*p + t
    tx = q1[0] - s*(ca*p1[0] - sa*p1[1])
    ty = q1[1] - s*(sa*p1[0] + ca*p1[1])
    return (s, ca, sa, tx, ty)

def apply_sim(T, m):
    s, ca, sa, tx, ty = T
    x, y = m["x"], -m["y"]
    return s*(ca*x - sa*y) + tx, s*(sa*x + ca*y) + ty

# grid for fast NN over osm
from collections import defaultdict
CELL = 20.0
grid = defaultdict(list)
for j, o in enumerate(osm):
    grid[(int(o["E"]//CELL), int(o["N"]//CELL))].append(j)
def nn_osm(E, N, rad):
    r = int(rad//CELL)+1
    ci, cj = int(E//CELL), int(N//CELL)
    best, bd = None, rad*rad
    for di in range(-r, r+1):
        for dj in range(-r, r+1):
            for j in grid.get((ci+di, cj+dj), ()):
                o = osm[j]
                dd = (o["E"]-E)**2 + (o["N"]-N)**2
                if dd < bd: bd = dd; best = j
    return best, math.sqrt(bd) if best is not None else None

random.seed(7)
best_T, best_score = None, -1
for trial in range(4000):
    (m1, o1), (m2, o2) = random.sample(cand, 2)
    if m1["tag"] == m2["tag"] or o1["id"] == o2["id"]: continue
    T = similarity_from2(m1, o1, m2, o2)
    if not T: continue
    score = 0
    for m in mappts[::4]:  # subsample for speed
        E, N = apply_sim(T, m)
        j, d_ = nn_osm(E, N, 6.0)
        if j is not None: score += 1
    if score > best_score:
        best_score = score; best_T = T
print("RANSAC best score (of", len(mappts[::4]), "subsampled):", best_score)
s, ca, sa, tx, ty = best_T
print(f"  scale*UPM0={s*UPM0:.4f} rot={math.degrees(math.atan2(sa,ca)):.3f} deg")

# full inlier set with best T
pairs = []
for i, m in enumerate(mappts):
    E, N = apply_sim(best_T, m)
    j, d_ = nn_osm(E, N, 8.0)
    if j is not None:
        pairs.append((i, j, d_))
print("inliers @8m with RANSAC pose:", len(pairs))

# iterate: affine refit (page -> meters) on mutual-unique pairs, tighten
def fit_affine(quads):
    n = len(quads)
    Sx=Sy=SX=SY=Sxx=Sxy=Syy=SxX=SyX=SxY=SyY=0.0
    for x,y,X,Y in quads:
        Sx+=x; Sy+=y; SX+=X; SY+=Y
        Sxx+=x*x; Sxy+=x*y; Syy+=y*y
        SxX+=x*X; SyX+=y*X; SxY+=x*Y; SyY+=y*Y
    def solve3(A,B):
        M=[row[:]+[B[i]] for i,row in enumerate(A)]
        for col in range(3):
            piv=max(range(col,3),key=lambda r:abs(M[r][col]))
            M[col],M[piv]=M[piv],M[col]
            for r in range(3):
                if r!=col:
                    f=M[r][col]/M[col][col]
                    for c2 in range(4): M[r][c2]-=f*M[col][c2]
        return [M[i][3]/M[i][i] for i in range(3)]
    A=[[Sxx,Sxy,Sx],[Sxy,Syy,Sy],[Sx,Sy,n]]
    a,b,c = solve3(A,[SxX,SyX,SX])
    d,e,f = solve3(A,[SxY,SyY,SY])
    return (a,b,c,d,e,f)

def apply_aff(T, x, y):
    return T[0]*x+T[1]*y+T[2], T[3]*x+T[4]*y+T[5]

# start from RANSAC-pose pairs
T = None
for it, thresh in enumerate([8, 5, 3.5, 2.5, 2.5, 2.5]):
    # dedupe: one osm building per map building, mutual best
    bymap = {}
    for i, j, d_ in pairs:
        if i not in bymap or d_ < bymap[i][1]: bymap[i] = (j, d_)
    byosm = {}
    for i, (j, d_) in bymap.items():
        if j not in byosm or d_ < byosm[j][1]: byosm[j] = (i, d_)
    good = [(i, j) for j, (i, d_) in byosm.items()]
    quads = [(mappts[i]["x"], mappts[i]["y"], osm[j]["E"], osm[j]["N"]) for i, j in good]
    T = fit_affine(quads)
    # re-pair everything
    pairs = []
    res = []
    for i, m in enumerate(mappts):
        E, N = apply_aff(T, m["x"], m["y"])
        j, d_ = nn_osm(E, N, thresh)
        if j is not None:
            pairs.append((i, j, d_)); res.append(d_)
    rms = math.sqrt(sum(r*r for r in res)/len(res))
    print(f"iter {it}: thresh {thresh} m, matched {len(pairs)}, rms {rms:.2f} m, max {max(res):.2f} m")

# 3-sigma rejection
mean = sum(r for *_, r in pairs)/len(pairs)
sd = math.sqrt(sum((r-mean)**2 for *_, r in pairs)/len(pairs))
cut = mean + 3*sd
final_pairs = [(i, j) for i, j, r in pairs if r <= cut]
print(f"3-sigma cut at {cut:.2f} m -> {len(final_pairs)} pairs")

# FINAL affine lon/lat -> page.
# Fit in CENTERED lon/lat (raw lon ~ -160.8 with 0.03 deg spread makes the
# normal equations catastrophically ill-conditioned), then expand back.
lonc0 = sum(osm[j]["lon"] for _, j in final_pairs)/len(final_pairs)
latc0 = sum(osm[j]["lat"] for _, j in final_pairs)/len(final_pairs)
quadsC = [(osm[j]["lon"]-lonc0, osm[j]["lat"]-latc0, mappts[i]["x"], mappts[i]["y"]) for i, j in final_pairs]
a, b, c, d_, e, f = fit_affine(quadsC)
# x = a*(lon-lon0) + b*(lat-lat0) + c  ->  x = a*lon + b*lat + (c - a*lon0 - b*lat0)
Tf = (a, b, c - a*lonc0 - b*latc0, d_, e, f - d_*lonc0 - e*latc0)
quads = [(osm[j]["lon"], osm[j]["lat"], mappts[i]["x"], mappts[i]["y"]) for i, j in final_pairs]
res_pg = []
anchor = {}
for (i, j), (lon, lat, X, Y) in zip(final_pairs, quads):
    px, py = apply_aff(Tf, lon, lat)
    r = math.hypot(px-X, py-Y)
    res_pg.append(r)
    if mappts[i]["tag"] in ("clinic", "acc"):
        anchor[mappts[i]["tag"]] = r
rms_pg = math.sqrt(sum(r*r for r in res_pg)/len(res_pg))
print(f"FINAL affine: {len(res_pg)} pairs, RMS {rms_pg:.3f} page units, max {max(res_pg):.3f}")
print("anchors:", {k: round(v, 3) for k, v in anchor.items()})
matched = {mappts[i]["tag"] for i, _ in final_pairs}
unmatched = [m["tag"] for m in mappts if m["tag"] not in matched]
print("unmatched:", len(unmatched), unmatched[:30])

a, b, c, d_, e, f = Tf
dxe, dye = a/MLON, d_/MLON
dxn, dyn = b/MLAT, e/MLAT
upm_e = math.hypot(dxe, dye); upm_n = math.hypot(dxn, dyn)
upm = (upm_e+upm_n)/2
print(f"unitsPerMeter east {upm_e:.5f} north {upm_n:.5f} mean {upm:.5f}; implied scale 1:{(1/upm)/(0.0254/72):.1f}")

json.dump({"toMap": list(Tf), "unitsPerMeter": round(upm, 5), "rms_page": rms_pg,
           "max_page": max(res_pg), "pairs": len(res_pg),
           "anchors": anchor, "unmatched": [str(u) for u in unmatched]},
          open("/Users/cashrarrington/Desktop/Surveyor/extraction/georef_result.json", "w"), indent=1)
print("wrote georef_result.json")
