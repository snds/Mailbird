# ADR-0045 · Scans and text in images (Phase 35)

- **Status:** Accepted
- **Date:** 2026-10-15
- **Builds on:** [ADR-0044](0044-images-in-notes.md) (images in notes), [ADR-0043](0043-locked-notes.md) (locked notes), [ADR-0036](0036-sender-profile.md) (adaptive sheets)

The [competitive analysis](../research/competitive-analysis.md) §3 credits **OCR and doc scanning** to Apple Notes and Keep: "paper becomes searchable text". Phase 34 put images in notes. This phase reads the text in them and adds a scanner.

## Decisions

### Reading text, on the device

- **Tesseract** (Apache-2.0), through tesseract.js, runs in a web worker. It reads every note image on the device that opened it. Images never leave the device to be read, and there's no account or API key.
- **It's served from the app itself,** under `ocr/`, never from a CDN. The engine is about 3.9 MB, plus the 2.9 MB English model (`best_int`). A device downloads them the first time it reads an image, and the browser keeps them after that. Only the LSTM engines ship: the English model needs nothing else.
- **It reads images no one has read yet, one at a time, while the app is idle.** That covers new photos, scans, imports, and images synced from a device that hadn't read them. An image that fails isn't retried in the same session.
- **Low-confidence words are dropped** (below 60%), and so is a result under three characters. Otherwise a photo's texture turns into searchable noise.
- **"Find text in images"** in the Notes menu turns it off. It's on by default, as in Apple Notes. While it's off, nothing new is read; turning it back on catches up.
- **The security policy allows `wasm-unsafe-eval`,** on the gateway and the desktop shell, so the engine can compile its WebAssembly. That allows compiling WebAssembly, not running `eval` on scripts. The worker is same-origin, so `worker-src 'self'` is enough.

### Where the text goes

- **Each image keeps its own text** (schema v18, `note_files.text`). `null` means not read yet; `""` means read, with nothing found.
- **The note gathers its images' text** into `notes.image_text`, a new column in the notes full-text index. Search finds a note by a word that's only in a photo of a receipt. The index is rebuilt once by the migration.
- **The text syncs with the image's record,** so a second device doesn't need to read it again.
- **A locked note's image text is sealed with its image** (AES-256-GCM, bound to `<id>#text`). Locking also empties the note's `image_text`, so search can't see it. Unlocking and changing the passphrase handle the text with the bytes.

### Using the text

- **Select an image, then "Text in image",** to see what was read. You can **Copy** it, or **Add to note**, which puts each line in as its own paragraph after the image. The button only appears when there's text.

### Scanning

- **"Scan a document"** in the note's toolbar opens the scanner. On a phone it's a bottom sheet (75% height, a grab handle, the close button at the bottom right). From `sm` up it's a side panel, using a new `wide` variant of `AdaptiveSheetContent` (`--c-sheet-wide-width`, 36rem) because a photo needs room.
- **Three steps:**
  1. **Take a photo or choose one.** On a phone, "Take a photo" opens the back camera.
  2. **Set the corners.** The page is found automatically: the largest bright area, which paper usually is against a desk (Otsu threshold and flood fill at 256 px). Each corner is a 44 px handle you can drag, or select and move with the arrow keys (Shift for bigger steps). Each one says where it is. **Whole photo** resets them.
  3. **Choose the look:**
     - **Document** (the default) divides each pixel by the paper's own brightness around it, so shadows and uneven light turn white and the ink stays black;
     - **Grayscale**;
     - **Color**.
- **The page is straightened with a perspective transform** to a rectangle at most 2048 px on its long side, and saved as JPEG. It goes into the note described as "Scanned document", then its text is read like any image's.
- **The page outline uses `--c-scan-edge` and `--c-scan-fill`,** which alias the ring color. They have to show up on any photo, so they can't be a neutral.

## Verification

- **Core:**
  - Image text is searchable (words and numbers).
  - A locked note's image text is sealed at rest and invisible to search. It can't be set without the key, a new passphrase reseals it, and removing the lock brings it back.
  - Another device's copy carries its text.
  - `""` counts as read.
  - Text is capped at a character boundary.
- **Dispatcher:** sealed images wait for an unlock; text set on a locked note reads back while unlocked.
- **Browser, demo (`phase35`, 15 checks, with real Tesseract in headless Chromium):**
  - a word and a number that are only in an image find the note;
  - "Text in image" shows the text, and "Add to note" adds it a line per paragraph;
  - a photo of a turned page on a desk:
    - the page is found;
    - a corner moves with the arrow keys;
    - Document is the default look;
    - the shadowed side of the page comes out white;
    - the page is straightened to its own shape (893 × 1002 for a 900 × 1000 page);
    - it goes in described as a scanned document;
    - its text becomes searchable;
  - with "Find text in images" off, nothing is read; turned back on, it catches up;
  - on a phone, the scanner is a bottom sheet that fits;
  - no console errors.

  All earlier demo suites still pass.

## Consequences

- **The web build is about 14 MB larger,** in `ocr/` (three engine builds, so each browser gets the fastest it runs, plus the model). A device that never reads an image never downloads any of it.
- **English only for now.** Another language is one more model file in `ocr/`, plus a setting.
- **Phones will do better natively.** Apple's VisionKit document camera and Live Text, and Google's ML Kit document scanner, find edges live and read text faster. The device spike (Phase 5b) can use them behind the same `set_note_file_text` command; the web scanner stays the fallback.
- **One page per scan.** A multi-page scan is several scans.
