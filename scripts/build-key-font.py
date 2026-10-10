# /// script
# requires-python = ">=3.11"
# dependencies = ["fonttools[woff]==4.66.1", "skia-pathops==0.9.2"]
# ///
"""Draw the key glyphs IBM Plex Sans lacks into web/src/ui/fonts/keys.woff2.

Plex as shipped has no modifier keys (⌃ ⇧ ⌘ ⌥ ↵) and the Fontsource subset has no ← or →, so
browsers drew them from whatever system font they found: matched on macOS, mismatched in size and
weight on Android. These are drawn here in Plex's proportions (cap height 698, stems 84 units) and
served as an extra face of the same family. Run with `uv run scripts/build-key-font.py`.
"""

from pathlib import Path

import pathops
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.pens.transformPen import TransformPen
from fontTools.svgLib.path import parse_path

OUT = Path(__file__).resolve().parent.parent / "web/src/ui/fonts/keys.woff2"
SCALE = 50  # Glyphs are drawn on the icons' 16-unit grid, y down; 14 units span the cap height.
STEM = 84
SIDE = 60
CAP = 698
# name, code point, centre line, vertical placement: "base" sits on the baseline, "cap" hangs from
# the cap height, "middle" centres where Plex centres its → (349 units up).
GLYPHS = [
    ("control", 0x2303, "M4 7 8 3l4 4", "cap"),
    ("shift", 0x21E7, "M8 1.5 14.5 8H11v6H5V8H1.5z", "base"),
    ("command", 0x2318, "M5 6h6v6H5z M5 6V4a2 2 0 1 0-2 2h2 M11 6V4a2 2 0 1 1 2 2h-2 M5 12v0a2 2 0 1 1-2-2h2 M11 12v0a2 2 0 1 0 2-2h-2", "base"),
    ("option", 0x2325, "M1.5 3h4l5 11h4 M10 3h4.5", "base"),
    ("return", 0x21B5, "M14 2v8H3 M6.5 6.5 3 10l3.5 3.5", "base"),
    ("arrowleft", 0x2190, "M14.5 8h-13 M6.5 3l-5 5 5 5", "middle"),
    ("arrowup", 0x2191, "M8 14.5v-13 M3 6.5l5-5 5 5", "base"),
    ("arrowright", 0x2192, "M1.5 8h13 M9.5 3l5 5-5 5", "middle"),
    ("arrowdown", 0x2193, "M8 1.5v13 M3 9.5l5 5 5-5", "base"),
]


def outline(d: str) -> pathops.Path:
    centre = pathops.Path()
    parse_path(d, TransformPen(centre.getPen(), (SCALE, 0, 0, -SCALE, 0, 0)))
    centre.stroke(STEM, pathops.LineCap.BUTT_CAP, pathops.LineJoin.MITER_JOIN, 4)
    return pathops.simplify(centre)


def build() -> None:
    order, cmap, charstrings, metrics = [".notdef"], {}, {}, {}
    empty = T2CharStringPen(500, None)
    charstrings[".notdef"], metrics[".notdef"] = empty.getCharString(), (500, 0)
    for name, code, d, place in GLYPHS:
        path = outline(d)
        x0, y0, x1, y1 = path.bounds
        dy = {"base": -y0, "cap": CAP - y1, "middle": 349 - (y0 + y1) / 2}[place]
        dx = SIDE - x0
        width = round(x1 - x0 + 2 * SIDE)
        pen = T2CharStringPen(width, None)
        path.draw(TransformPen(pen, (1, 0, 0, 1, dx, dy)))
        order.append(name)
        cmap[code] = name
        charstrings[name] = pen.getCharString()
        metrics[name] = (width, SIDE)
    builder = FontBuilder(1000, isTTF=False)
    builder.setupGlyphOrder(order)
    builder.setupCharacterMap(cmap)
    builder.setupCFF("TesseraKeys-Regular", {"FullName": "Tessera Keys"}, charstrings, {})
    builder.setupHorizontalMetrics(metrics)
    builder.setupHorizontalHeader(ascent=1025, descent=-275)
    builder.setupNameTable({"familyName": "Tessera Keys", "styleName": "Regular"})
    builder.setupOS2(sTypoAscender=1025, sTypoDescender=-275, usWinAscent=1025, usWinDescent=275, sxHeight=516, sCapHeight=CAP)
    builder.setupPost()
    builder.font.flavor = "woff2"
    OUT.parent.mkdir(parents=True, exist_ok=True)
    builder.save(OUT)
    print(f"{OUT} {OUT.stat().st_size} bytes")


if __name__ == "__main__":
    build()
