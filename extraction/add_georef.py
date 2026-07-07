#!/usr/bin/env python3
"""Insert the georef field into data.js (surgical edit; rest stays byte-identical)."""
import json

DJS = "/Users/cashrarrington/Desktop/Surveyor/app/assets/www/maps/unalakleet/data.js"
G = json.load(open("/Users/cashrarrington/Desktop/Surveyor/extraction/georef_result.json"))

src = open(DJS).read()

georef_block = (
    "  georef: {\n"
    "    type: 'affine',\n"
    "    // x = a*lon + b*lat + c ; y = d*lon + e*lat + f   (lon/lat WGS-84 -> page units)\n"
    "    // fit vs OSM footprints: 378 pairs, RMS 0.042 page units, max 0.068\n"
    "    toMap: [" + ", ".join(repr(v) for v in G["toMap"]) + "],\n"
    f"    unitsPerMeter: {G['unitsPerMeter']}\n"
    "  },\n"
)

anchor = '  baseSvg: "maps/unalakleet/base.svg",\n'
assert src.count(anchor) == 1, "anchor line not found exactly once"
assert "georef" not in src, "georef already present"
src = src.replace(anchor, anchor + georef_block)
open(DJS, "w").write(src)
print("inserted georef block, new size:", len(src))
