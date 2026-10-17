# ADR-0068 · Multi-page scans

- **Status:** Accepted
- **Date:** 2026-10-17
- **Builds on:** [ADR-0045](0045-scans-and-text-in-images.md) (scans and text in images)

Scanning a document added one page to a note. A contract, a receipt with a second page, or handwritten notes meant opening the scanner again for each page. ADR-0045 left multi-page scans as a follow-up.

## Decisions

- **Next page:** after choosing a page's look, **Next page** keeps it and goes back to the camera for the next one.
  - The sheet's title counts the pages: "Scan a document · page 2".
  - The next page starts with the same look.
- **A strip of the pages so far** sits above the camera, each page with **Remove**.
- **Adding:**
  - From a page's look, **Add N pages to note** adds the pages so far plus this one.
  - From the camera step, **Add N pages to note** adds what's in the strip.
  - One page still reads **Add to note**, as before.
- **The pages go into the note in order, as separate images.** Each is described with its place, "Scanned document, page 2 of 3", so screen readers and search say which page it is. A single page stays "Scanned document".
- **Each page's text is read on this device,** like any image's (ADR-0045).
- **Not a PDF.** Pages are images in the note, the same as one scan.

## Verification

- `phase51` (10 checks):
  - one page still reads Add to note;
  - Next page keeps the first page in the strip, and the sheet asks for page 2;
  - two pages go in, in order, described "page 1 of 2" and "page 2 of 2";
  - Remove takes a page out, and adding from the camera step adds what's left;
  - a single page is "Scanned document". No console errors.
- `phase35` (the single-page scan) still passes. `tsc -b`, `oxlint`, and `vite build` are clean, and the ratchet is flat.

## Consequences

- **Pages scanned but not added are lost when the sheet closes.** They live only in the sheet until added.
- **Reordering pages** means removing and scanning again.
