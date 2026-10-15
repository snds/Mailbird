# ADR-0044 · Images in notes (Phase 34)

- **Status:** Accepted
- **Date:** 2026-10-15
- **Builds on:** [ADR-0012](0012-notes.md) (notes and their Yjs sync), [ADR-0034](0034-connected-notes.md) (Markdown import and export), [ADR-0038](0038-note-cards.md) (the card grid), [ADR-0043](0043-locked-notes.md) (locked notes)

The [competitive analysis](../research/competitive-analysis.md) §3 credits **OCR and doc scanning** to Apple Notes and Keep: "paper becomes searchable text". Both need a note to hold an image first, and until now a note couldn't. Imports dropped every image and only counted them. This phase adds images. Scanning and text recognition build on it in Phase 35.

## Decisions

### Where an image lives

- **The text points at it; the bytes live beside it.** A note's Markdown says `![description](note-file:ID)`. The image is a row in a new `note_files` table (schema v17), one per image.
- **Why not inline (`data:` URLs) in the text?** A photo would make the note's text megabytes long. Search, snippets, Yjs merging, and every sync of the text would carry it. Kept apart, the text stays small and mergeable, and images sync once.
- **Only JPEG, PNG, WebP, and GIF,** up to 10 MB each. The core checks the type and size on the way in and when another device sends one.
- **Each imported or pasted image gets its own id.** Two notes never share one, so deleting or locking one note can't affect another.

### Adding one

- **Three ways in:** the **Add image** button in the note's toolbar, pasting, and dragging onto the note. Several at once are fine.
- **Photos are shrunk before they're stored.** The longest side becomes at most 2048 px, saved as JPEG at 0.85 quality. That's sharp on a 4K screen and a few hundred KB. Small images (≤ 2048 px and ≤ 1 MB) and GIFs are kept byte for byte, so screenshots stay crisp and animations play. JPEG has no transparency, so a large screenshot's clear areas become white, not black.
- **A file the browser can't read** (HEIC on most browsers) says so in words and suggests JPEG or PNG. The other images still go in.

### Showing one

- **The image sits in the text,** up to 70% of the window's height and never wider than the note. On a phone it fits the screen.
- **Selecting it asks for a description.** The field reads "Describe this image for people who can't see it". The description is the image's accessible name, it's searchable, and it is the alt text other apps see after export. It saves on Enter or on leaving the field, so one edit is one undo step.
- **An image not on this device yet** (still syncing) says so in place, rather than showing a broken icon.
- **Web images (`https:`), from imports, load only when asked.** They show their description and a **Show from example.com** button. Loading one tells its server that someone opened the note, as remote images in mail do.
- **A card in the grid shows the note's first image on top,** edge to edge, the way Keep shows photos. It's decorative (empty alt): the card's title already names the note. The core finds the cover from the text itself, so it's always the first image the note shows, and a locked note has none.

### Locked notes

- **A locked note's images are sealed with its text** (AES-256-GCM, bound to the image's id), the moment it's locked. Images added while it's locked go in sealed.
- **Removing the lock opens them again; a new passphrase reseals them** in the same transaction as the notes.
- **Without the key, a sealed image won't open,** on this device or anywhere it synced.

### Sync

- **Each image's facts** (id, note, type, size, sealed, dates) **ride in the relay's index** in a `files` map. The newest `updated` wins, like notes' records.
- **Its bytes go in a document of their own,** `file/<id>`. A device writes the bytes first and the record second, so a device that sees the record finds the bytes.
- **Images move one at a time,** so a first sync with many photos doesn't flood the relay.
- **A sealed image travels sealed.** The relay never has a readable copy of a locked note's image.
- **The relay now accepts `mailbird/file/<id>`** next to `index` and `note/<id>`.

### Import and export

- **Import brings images along.** It reads Markdown `![alt](path)` (relative to the note, with `%20`-style escapes and `<paths with spaces>`), Obsidian's `![[photo.png]]` embeds (found by file name anywhere in the folder, shortest path first, as Obsidian does), and Google Keep's attachments.
- **The browser sends only the images notes name,** shrunk like the editor shrinks them, in batches of about 8 MB. A big vault then imports in several calls without hitting the gateway's limit, and each note travels with its images.
- **The report counts what didn't come.** That means images a note names but that weren't found or couldn't be read, plus recordings and PDFs.
- **Export writes images into `attachments/`** next to the notes, and the Markdown points there (`![alt](attachments/ID.png)`). Obsidian and Bear open that as is. Exporting and importing again round-trips the images. A locked note and its images aren't exported.
- **The file's bytes decide its type,** not its name, in case a big PNG was shrunk to JPEG on the way in.

### The gateway

- **Requests to `/api/core/*` may be up to 16 MB,** up from axum's default of 2 MB. A 10 MB image is about 13.4 MB as base64.

## Verification

- **Core:**
  - Image ids are read from Markdown.
  - Adding, listing, and showing an image; unsupported types, damaged data, and a missing note are refused.
  - Locking seals a note's images (no plain bytes are left in the database), a new passphrase reseals them, and removing the lock opens them.
  - Sync keeps the newer copy.
  - Export writes `attachments/`, import brings them back as new copies, and the card's cover follows the text.
  - Import resolves relative paths, `%20` escapes, Obsidian embeds by name, and Keep attachments. It leaves web images and code alone, counts missing images, and trusts the bytes over the name.
- **Dispatcher:** add an image to a locked note (sealed), open it while unlocked, read its raw (sealed) bytes, list, records, and an older sync copy is refused.
- **Browser, demo (`phase34`, 23 checks):**
  - a 3000 px photo is stored at 2048 px, and shows from this device;
  - the description field, and Enter going back to the text;
  - pasting an image (a small one is kept as it is);
  - images and descriptions survive reopening;
  - the card's cover, and that it's decorative;
  - a locked note and its card show no image, and unlocking brings it back;
  - the demo's sample image;
  - importing a note with a local image, a web image, and a missing one: each on its own line, the web image loading nothing until asked;
  - the export's `attachments/` and links;
  - the phone layout;
  - no console errors.
- **Browser, two devices through a real relay (`phase34-sync`, 6 checks):**
  - the image's bytes reach the relay in `file/<id>`;
  - the other device shows its own full copy;
  - a description typed on one device shows on the other.

  All earlier demo suites, and the notes and locked-notes sync suites, still pass.

## Consequences

- **Removing an image from the text leaves its row in place,** so undo can bring it back. A later cleanup can drop images no note's text names after a grace period.
- **Tiptap lifts an image alone in its paragraph out of it,** for block image nodes. Ours is inline, so the note's parser puts each one back in a paragraph of its own. Otherwise images on separate lines would merge onto one.
- **The demo draws its sample image when first shown,** so the bundle carries no binary. Its "sealing" of images is only a flag; the core does the real encryption.
- **There's no full-screen view or resizing yet.** Markdown has no portable way to store a size, so images show at their natural size, capped to the note.
