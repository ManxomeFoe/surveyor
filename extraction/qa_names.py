#!/usr/bin/env python3
"""QA: draw matched structure names next to their buildings on the PDF."""
import fitz, json

matches = json.load(open("/Users/cashrarrington/Desktop/Surveyor/extraction/name_matches.json"))
EX = json.load(open("/Users/cashrarrington/Desktop/Surveyor/extraction/extracted.json"))
bldg = {bb["n"]: bb for bb in EX["buildings"]}

doc = fitz.open("/Users/cashrarrington/Downloads/unalakleet_street_plan.pdf")
page = doc[0]
BLUE = (0, 0, 0.9)
kept = [m for m in matches if m["tag"] is not None and not (m["how"] == "near" and m["dist"] > 8)]
print("kept:", len(kept), "of", len(matches))
for m in kept:
    if m["tag"] in ("clinic", "acc"):
        continue
    bb = bldg[m["tag"]]
    pts = [fitz.Point(x, y) for x, y in bb["pts"]] + [fitz.Point(*bb["pts"][0])]
    page.draw_polyline(pts, color=BLUE, width=0.8)
    page.insert_text(fitz.Point(bb["cx"]+4, bb["cy"]-2), f'{m["tag"]}: {m["name"][:40]}',
                     fontsize=4, color=BLUE)

crops = [
    ("qa_addr_school", fitz.Rect(300, 2100, 900, 2600)),   # school area 148-186
    ("qa_addr_south", fitz.Rect(450, 2550, 1100, 3140)),   # 287-376
    ("qa_addr_airport", fitz.Rect(150, 1500, 900, 2100)),  # 40-123 airport+clinic
]
for name, r in crops:
    pix = page.get_pixmap(clip=r, dpi=200)
    pix.save(f"/Users/cashrarrington/Desktop/Surveyor/extraction/{name}.png")
    print(name, pix.width, pix.height)
