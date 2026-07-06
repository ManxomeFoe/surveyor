#!/usr/bin/env python3
"""Examine dark-fill drawings in detail."""
import fitz, collections

doc = fitz.open("/Users/cashrarrington/Downloads/unalakleet_street_plan.pdf")
page = doc[0]
dr = page.get_drawings()

DARK = (0.227, 0.192, 0.149)
def keyof(d):
    f = d.get("fill")
    return tuple(round(c, 3) for c in f) if f else None

dark = [d for d in dr if keyof(d) == DARK]
print("dark:", len(dark))

# histogram of (w,h) rounded
sizes = collections.Counter()
for d in dark:
    r = d["rect"]
    sizes[(round(r.width), round(r.height))] += 1
for k in sorted(sizes):
    print(k, sizes[k])
