#!/usr/bin/env python3
"""QA: draw extracted polygons + decoded numbers over the PDF and render crops."""
import fitz, json, random

PDF = "/Users/cashrarrington/Downloads/unalakleet_street_plan.pdf"
data = json.load(open("/Users/cashrarrington/Desktop/Surveyor/extraction/extracted.json"))

doc = fitz.open(PDF)
page = doc[0]

MAGENTA = (1, 0, 0.8)
for b in data["buildings"]:
    pts = [fitz.Point(x, y) for x, y in b["pts"]]
    pts.append(pts[0])
    page.draw_polyline(pts, color=MAGENTA, width=0.5)
    # decoded number to the right of the building, small magenta text
    page.insert_text(fitz.Point(b["cx"] + 3.5, b["cy"] + 1.2), str(b["n"]),
                     fontsize=3.2, color=MAGENTA)

for k, v in data["landmarks"].items():
    pts = [fitz.Point(x, y) for x, y in v["pts"]]
    pts.append(pts[0])
    page.draw_polyline(pts, color=(0, 0.7, 0), width=0.8)

# choose crops: cover whole map incl. buildings with digits 1/2/4/6/8/9 heavy
regions = [
    ("qa_top", fitz.Rect(950, 80, 1450, 580)),        # buildings 1..30ish
    ("qa_mid_west", fitz.Rect(80, 1800, 700, 2400)),  # clinic area, 100s
    ("qa_mid_east", fitz.Rect(1350, 400, 1840, 1000)),# east side
    ("qa_south", fitz.Rect(500, 2600, 1200, 3140)),   # ACC / south, 300s
]
for name, r in regions:
    pix = page.get_pixmap(clip=r, dpi=220)
    pix.save(f"/Users/cashrarrington/Desktop/Surveyor/extraction/{name}.png")
    print(name, pix.width, pix.height)

# also render 6 random tight crops for spot checks on specific numbers
random.seed(42)
picks = random.sample(data["buildings"], 6)
for b in picks:
    r = fitz.Rect(b["cx"]-25, b["cy"]-25, b["cx"]+25, b["cy"]+25)
    pix = page.get_pixmap(clip=r, dpi=600)
    pix.save(f"/Users/cashrarrington/Desktop/Surveyor/extraction/qa_n{b['n']}.png")
    print("spot", b["n"], "at", b["cx"], b["cy"])
