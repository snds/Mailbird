# ADR-0006 · Product name

- **Status:** Open. Owner decision needed.
- **Date:** 2026-10-13

## Context

**Mailbird** is a live commercial email client from Mailbird, Inc. It ships on Windows and macOS with freemium pricing, so the name collides with an active trademark in our exact category.

## Decision so far

- "Mailbird" is a **working repo name only**.
- Package and crate names are kept neutral where it's cheap:
  - Rust core: `pim-core`.
  - Shell: `mailbird-shell`. Rename it with the product.
- The app bundle identifier `design.snds.mailbird` must change before any store submission.

## To do before any public release

1. Choose a name.
2. Run a trademark search (USPTO and EUIPO, class 9/42).
3. Check domain and store availability.
4. Rename the repo, `productName`, `identifier`, and `index.html` title.
