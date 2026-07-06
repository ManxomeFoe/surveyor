#!/usr/bin/env python3
"""Emit app/assets/www/maps/unalakleet/data.js from extracted.json per CONTRACT."""
import json

data = json.load(open("/Users/cashrarrington/Desktop/Surveyor/extraction/extracted.json"))
DST = "/Users/cashrarrington/Desktop/Surveyor/app/assets/www/maps/unalakleet/data.js"

def fmt_num(v):
    s = f"{v:.1f}"
    return s[:-2] if s.endswith(".0") else s

def fmt_pts(pts):
    return "[" + ",".join(f"[{fmt_num(x)},{fmt_num(y)}]" for x, y in pts) + "]"

blines = []
for b in data["buildings"]:
    blines.append(f'{{n:{b["n"]},cx:{fmt_num(b["cx"])},cy:{fmt_num(b["cy"])},pts:{fmt_pts(b["pts"])}}}')

lm = data["landmarks"]
landmarks = [
    ("NSHC Medical Clinic", lm["clinic"]["cx"], lm["clinic"]["cy"]),
    ("Alaska Commercial Company", lm["acc"]["cx"], lm["acc"]["cy"]),
    ("Unalakleet Airport (UNK)", 320.0, 1640.0),
]
llines = [f'{{label:{json.dumps(l)},x:{fmt_num(x)},y:{fmt_num(y)}}}' for l, x, y in landmarks]

out = (
    "window.MAP_DATA = window.MAP_DATA || {};\n"
    'window.MAP_DATA["unalakleet"] = {\n'
    '  name: "Unalakleet",\n'
    "  viewBox: [0, 0, 1840.7, 3145.8],\n"
    '  baseSvg: "maps/unalakleet/base.svg",\n'
    "  buildings: [\n" + ",\n".join("    " + b for b in blines) + "\n  ],\n"
    "  landmarks: [\n" + ",\n".join("    " + l for l in llines) + "\n  ]\n"
    "};\n"
)
open(DST, "w").write(out)
import os
print("wrote", DST, os.path.getsize(DST), "bytes")

# sanity: parse as JS-ish via node? Just re-verify structure with a JSON-ish check:
import re
ns = re.findall(r"\{n:(\d+),", out)
assert sorted(map(int, ns)) == list(range(1, 377)), "building numbers wrong"
print("building count:", len(ns), "numbers 1..376 OK")
