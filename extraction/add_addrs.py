#!/usr/bin/env python3
"""Add addr fields (NOAA OCM structure names) to matched building entries in
data.js. Surgical line edits; everything else byte-identical."""
import json, re

DJS = "/Users/cashrarrington/Desktop/Surveyor/app/assets/www/maps/unalakleet/data.js"
matches = json.load(open("/Users/cashrarrington/Desktop/Surveyor/extraction/name_matches.json"))

# keep: matched, confident (inside, or near with dist <= 8), numbered buildings only
addrs = {}
for m in matches:
    if m["tag"] is None or m["tag"] in ("clinic", "acc"):
        continue
    if m["how"] == "near" and m["dist"] > 8:
        print("skipping low-confidence:", m["name"], "d=", round(m["dist"], 1))
        continue
    assert m["tag"] not in addrs, f"duplicate target {m['tag']}"
    addrs[m["tag"]] = m["name"]
print("adding addr to", len(addrs), "buildings")

src = open(DJS).read()
assert '"addr"' not in src and "addr:" not in src, "addr already present"
for n, name in sorted(addrs.items()):
    old = f"{{n:{n},cx:"
    assert src.count(old) == 1, f"anchor for building {n} not unique"
    new = f"{{n:{n},addr:{json.dumps(name)},cx:"
    src = src.replace(old, new)
open(DJS, "w").write(src)
print("wrote data.js,", len(src), "bytes")
