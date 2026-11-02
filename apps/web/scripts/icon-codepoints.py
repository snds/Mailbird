#!/usr/bin/env python3
"""Write src/lib/material-symbols-codepoints.json: each Material Symbols name
and the private-use character its ligature draws (ADR-0073).

Read from the installed font itself, so the map always matches the glyphs that
ship. Run after bumping material-symbols:

    pip install fonttools brotli
    python3 scripts/icon-codepoints.py
"""
import json
import pathlib

from fontTools.ttLib import TTFont

here = pathlib.Path(__file__).resolve().parent.parent
font = next((here.parent.parent / "node_modules/.pnpm").glob("material-symbols@*/node_modules/material-symbols/material-symbols-rounded.woff2"))
f = TTFont(font)

# Glyph → letter (lowercase) and glyph → private-use code point.
letter, pua = {}, {}
for cp, glyph in f.getBestCmap().items():
    if cp < 0x80:
        letter[glyph] = chr(cp).lower()
    if 0xE000 <= cp <= 0xF8FF or cp >= 0xF0000:
        pua.setdefault(glyph, cp)

names = {}
for lookup in f["GSUB"].table.LookupList.Lookup:
    for st in lookup.SubTable:
        if st.LookupType == 7:  # extension wrapper
            st = st.ExtSubTable
        if st.LookupType != 4:  # ligatures only
            continue
        for first, ligs in st.ligatures.items():
            for lig in ligs:
                parts = [first, *lig.Component]
                if all(p in letter for p in parts) and lig.LigGlyph in pua:
                    names.setdefault("".join(letter[p] for p in parts), pua[lig.LigGlyph])

out = here / "src/lib/material-symbols-codepoints.json"
out.write_text(json.dumps(dict(sorted(names.items())), separators=(",", ":")))
print(f"{len(names)} names → {out.relative_to(here)}")
