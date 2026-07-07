#!/usr/bin/env python3
"""QA: project OSM building centroids through the published georef affine onto
the PDF map; crosses must land on the buildings."""
import fitz, json, math

PDF = "/Users/cashrarrington/Downloads/unalakleet_street_plan.pdf"
G = json.load(open("/Users/cashrarrington/Desktop/Surveyor/extraction/georef_result.json"))
OSM = json.load(open("/Users/cashrarrington/Desktop/Surveyor/extraction/osm_buildings.json"))
a, b, c, d_, e, f = G["toMap"]

lat0 = 63.878
MLAT = 111320.0
MLON = 111320.0 * math.cos(math.radians(lat0))

def centroid_metric(g):
    pts = [((p["lon"]+160.8)*MLON, (p["lat"]-lat0)*MLAT) for p in g]
    if pts[0] == pts[-1]: pts = pts[:-1]
    A = cx = cy = 0.0
    n = len(pts)
    for i in range(n):
        x0, y0 = pts[i]; x1, y1 = pts[(i+1) % n]
        cr = x0*y1 - x1*y0
        A += cr; cx += (x0+x1)*cr; cy += (y0+y1)*cr
    A *= 0.5
    if abs(A) < 1e-12:
        return sum(p[0] for p in pts)/n, sum(p[1] for p in pts)/n
    return cx/(6*A), cy/(6*A)

doc = fitz.open(PDF)
page = doc[0]
GREEN = (0, 0.6, 0)
count = 0
for el in OSM["elements"]:
    g = el.get("geometry")
    if not g or len(g) < 4: continue
    E, N = centroid_metric(g)
    lon = E/MLON - 160.8
    lat = N/MLAT + lat0
    x = a*lon + b*lat + c
    y = d_*lon + e*lat + f
    if not (0 <= x <= 1840.7 and 0 <= y <= 3145.8): continue
    s = 4
    page.draw_line(fitz.Point(x-s, y), fitz.Point(x+s, y), color=GREEN, width=0.7)
    page.draw_line(fitz.Point(x, y-s), fitz.Point(x, y+s), color=GREEN, width=0.7)
    count += 1
print("projected crosses on page:", count)

crops = [
    ("qa_geo_ne_outliers", fitz.Rect(950, 80, 1840, 970)),    # far NE buildings 1..13
    ("qa_geo_clinic", fitz.Rect(300, 1950, 800, 2350)),       # clinic + 100s
    ("qa_geo_acc_south", fitz.Rect(400, 2600, 1000, 3140)),   # ACC + south end
]
for name, r in crops:
    pix = page.get_pixmap(clip=r, dpi=200)
    pix.save(f"/Users/cashrarrington/Desktop/Surveyor/extraction/{name}.png")
    print(name, pix.width, pix.height)
