# ADR-0067 · A note's images full screen

- **Status:** Accepted
- **Date:** 2026-10-17
- **Builds on:** [ADR-0044](0044-images-in-notes.md) (images in notes)

A note's images show at the note's width, at most 70% of the screen's height. A photo of a whiteboard, a receipt, or a wide moodboard needs more room. ADR-0044 left a full-screen view as a follow-up.

## Decisions

- **Opening it:** double-click an image, or select it and press **View**. View shows in read-only notes too.
- **What it shows:** a full-screen sheet (unicron `SheetContent fullscreen`).
  - The image fits the screen; **Actual size** shows it at its own pixels, scrolling.
  - The header carries the image's description as its title, and "2 of 3" when the note has more than one.
  - Each image opens fitted.
- **Paging through the note's images:** the arrow keys, Previous and Next, or a swipe, in the note's order. It wraps around at the ends.
- **Save image** downloads it, named after its description. It's on the web only: the desktop and phone apps can't download from the page yet. [ADR-0070](0070-core-clipboard-and-image-save.md) saves it from the core there.
- **Escape or Close** leaves.

## Verification

- `phase50` (11 checks):
  - double-click opens it, captioned "1 of 2", fitted to the screen;
  - Actual size shows the 1800px image at 1800px;
  - the arrow key and Next move through both images and wrap;
  - Save names the file after the description;
  - Escape closes it, and View opens the selected image.
  - No console errors.
- Light and dark screens checked. `tsc -b`, `oxlint`, and `vite build` are clean, and the ratchet is flat.

## Consequences

- **Pinch to zoom** is the browser's and the OS's own on touch screens. There's no zoom slider.
- **Saving on the desktop and phone** waits for a native save path, like the one notes export uses.
