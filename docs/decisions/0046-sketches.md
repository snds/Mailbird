# ADR-0046 · Sketches (Phase 36)

- **Status:** Accepted
- **Date:** 2026-10-15
- **Builds on:** [ADR-0044](0044-images-in-notes.md) (images in notes), [ADR-0045](0045-scans-and-text-in-images.md) (text in images, the wide adaptive sheet)

The [competitive analysis](../research/competitive-analysis.md) §3 credits **handwriting, sketch, and Pencil** to Apple Notes: it "captures what typing can't". This phase lets a note hold a drawing. Apple Pencil specifics wait for the device spike; pen pressure works now wherever the browser reports it.

## Decisions

### Drawing

- **"Sketch"** in the note's toolbar opens a drawing sheet. Like the scanner, it's a bottom sheet on phones and the wide side panel from `sm` up.
- **Three tools:**
  - **Pen** in four inks (ink, red, blue, green);
  - **Marker** in three see-through colors (yellow, pink, green), so it highlights without hiding;
  - **Eraser**, which removes whole strokes it touches, as Apple Notes' object eraser does. That's predictable, and undo puts them back.
- **Three thicknesses** (fine, medium, bold), plus **Undo**, **Redo**, **Clear**, Ctrl/⌘+Z and Ctrl/⌘+Shift+Z, and **More room**, which makes the page 350 units taller, up to four pages.
- **Pressure shapes the line.** A pen's pressure sets the width (a harder press drew 2.8× wider in the test). A mouse or a finger gets pressure simulated from speed. Strokes are drawn as filled outlines by **perfect-freehand** (MIT), which is what makes ink look like ink rather than a fixed-width polyline.
- **Every sample counts.** The stroke being drawn lives in a ref, and coalesced pointer events are read, so a fast pen loses no points between frames.

### Storing a sketch

- **A sketch is an SVG image** in the note's files, beside its photos. Any app that shows SVG shows the drawing, including after export, where it's `attachments/<id>.svg`.
- **The SVG carries its own strokes** as JSON in `<metadata id="mailbird-sketch">`. **Edit sketch** on a selected sketch opens it with every stroke, and saving puts a new image in its place. Images never change once stored (ADR-0044), so caches and other devices never show a stale one.
- **It goes into the note described as "Sketch"**, and the description can be edited like any image's. Its text is read too (ADR-0045): the reader draws it onto white first, because Tesseract takes pixels.

### Safety: only sketches the app drew

- **SVG can carry scripts, links, and styles that load things.** The core accepts an SVG only if every part of it is on an allow-list:
  - elements `svg`, `metadata`, `g`, and `path`;
  - attributes `xmlns` (SVG's own only), `viewBox`, `width`, `height`, path data, `fill` and `stroke` as hex or `none`, and widths, opacity, and line caps;
  - text only inside the metadata.
- **Anything else is refused,** including DOCTYPEs and entities, comments, CDATA, processing instructions, `style`, `href`, `url(…)`, event handlers, and a second root.
- **The check runs everywhere a sketch enters:** adding one, another device's copy, and an import. It runs again when a sealed sketch is first opened, since its bytes can only be checked once unsealed. Sketches also only ever show through `<img>`, where SVG can't run anything, so the check is a second wall, not the only one.
- **quick-xml is now a core dependency in every build,** not only with networking, because the check is store logic.

### Looks

- **Sketches sit on paper, light in both themes** (`--c-sketch-paper`, deliberately not redefined for dark mode). Inverting a drawing in dark mode would turn a yellow highlight blue and change the colors you chose. A sketch on a light card reads like a page from a notebook, and it looks the same on every device and after export.
- **Ink colors are content, not UI:** they're stored in the file as hex values, not tokens, because the file has to look the same everywhere.

## Verification

- **Core:**
  - The app's own sketch is kept, with or without an XML declaration.
  - Twelve kinds of hostile or malformed SVG are refused.
  - A bad sketch from another device is refused, unsealed and sealed (the sealed one won't open).
- **Browser, demo (`phase36`, 22 checks):**
  - **Drawing:** an empty sketch can't be added; a mouse stroke draws, and undo and redo work; a harder pen press draws a thicker line; the marker is see-through; the eraser removes the strokes it crosses, and Ctrl+Z restores them in one step; More room makes the page taller.
  - **In the note:** the sketch goes in at full size; editing opens it with its strokes; saving replaces it in place.
  - **Export and looks:** the export carries an `.svg`; the sketch sits on light paper in dark mode.
  - **Phone:** a finger draws; the sheet fits with its buttons on screen.
  - No console errors.

  All earlier demo suites still pass.

## Consequences

- **Apple Pencil extras** (tilt, double-tap to switch tools, Scribble handwriting to text) need native APIs, so they wait for the device spike. Pressure already works through pointer events.
- **There's no lasso, move, or shape recognition.** A sketch is for quick drawing; anything more would be a canvas app.
- **An imported SVG that the app didn't draw is left out and counted,** like a missing image. That's on purpose.
