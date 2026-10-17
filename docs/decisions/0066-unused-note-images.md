# ADR-0066 · Unused note images go after 30 days

- **Status:** Accepted
- **Date:** 2026-10-17
- **Builds on:** [ADR-0044](0044-images-in-notes.md) (images in notes), [ADR-0045](0045-scans-and-text-in-images.md) (text in images)

A note's images live beside its text. Deleting an image from a note leaves its bytes stored and syncing, so they pile up. ADR-0044 left this as a follow-up.

## Decisions

- **An image no note points at is marked, then dropped 30 days later.**
  - The check runs a minute after the app starts and every six hours after that.
  - When a note points at the image again (an undo, or a paste), the mark clears and the 30 days start over.
- **What's never touched:**
  - Images in **deleted notes**: a deleted note can come back from Recently deleted, with its images.
  - Images in **locked notes**: their text is sealed, so nothing can tell what they point at.
- **Dropped images are remembered** in `note_files_gone` (schema v23). A device that hasn't heard yet can't sync one back.
- **Every device drops them too:**
  - Sync writes dropped ids into the index's `filesGone` map and takes their records off the relay.
  - Each device that sees the list drops its own copy.
  - That's safe because a note's text syncs too: an image unused on one device is unused on all of them.
- **Their text leaves search with them.**

## Verification

- **Core:**
  - the first sweep only marks, and an image is kept inside the grace period;
  - pointing at it again restarts the clock, and it goes after 30 days unused while the one in use stays;
  - sync can't bring a dropped image back, and another device's drop is applied here;
  - a deleted note keeps its images.
- The full browser regression passes. `cargo clippy -D warnings`, `cargo test`, `tsc -b`, and `oxlint` are clean.

## Consequences

- **A device offline for more than 30 days** drops images that another device has since pointed at again. That takes an undo that old and a device offline that long, so it's left as is.
- **The web demo doesn't sweep:** it forgets everything on reload anyway. It still applies drops from other devices.
