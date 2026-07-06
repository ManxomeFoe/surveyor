#!/usr/bin/env python3
"""Crop pdftocairo SVG to map area: fix root viewBox, strip legend-panel elements.

Prerequisite (produces full.svg):
  /opt/homebrew/bin/pdftocairo -svg /Users/cashrarrington/Downloads/unalakleet_street_plan.pdf \
      /Users/cashrarrington/Desktop/Surveyor/extraction/full.svg
"""
import re

SRC = "/Users/cashrarrington/Desktop/Surveyor/extraction/full.svg"
DST = "/Users/cashrarrington/Desktop/Surveyor/app/assets/www/maps/unalakleet/base.svg"
PANEL_X = 1840.7
VIEWBOX = "0 0 1840.7 3145.8"

svg = open(SRC).read()

# fix root element
root_re = re.compile(r'<svg[^>]*>')
m = root_re.search(svg)
old_root = m.group(0)
new_root = ('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
            f'width="100%" height="100%" viewBox="{VIEWBOX}" preserveAspectRatio="xMidYMid meet">')
svg = svg[:m.start()] + new_root + svg[m.end():]

# strip elements that live entirely in the legend panel (first coordinate x > PANEL_X)
lines = svg.split("\n")
out = []
removed = 0
use_re = re.compile(r'<use\b[^>]*\bx="([0-9.]+)"')
path_re = re.compile(r'<path\b[^>]*\bd="M\s+(-?[0-9.]+)')
for ln in lines:
    drop = False
    mu = use_re.search(ln)
    if mu and float(mu.group(1)) > PANEL_X:
        drop = True
    mp = path_re.search(ln)
    if mp and float(mp.group(1)) > PANEL_X:
        # make sure the whole path stays right of the panel edge: check min x of all coords
        coords = re.findall(r'([-0-9.]+)\s+[-0-9.]+', ln)
        try:
            if coords and min(float(c) for c in coords) > PANEL_X - 2:
                drop = True
        except ValueError:
            pass
    if drop:
        removed += 1
    else:
        out.append(ln)
svg = "\n".join(out)
open(DST, "w").write(svg)
print("removed", removed, "legend elements")
import os
print("size:", os.path.getsize(DST))

# well-formedness check
import xml.etree.ElementTree as ET
ET.parse(DST)
print("XML OK")

# render check with fitz
import fitz
d = fitz.open(DST)
pg = d[0]
print("svg page rect:", pg.rect)
pix = pg.get_pixmap(dpi=36)
pix.save("/Users/cashrarrington/Desktop/Surveyor/extraction/base_svg_render.png")
print("render:", pix.width, "x", pix.height)
