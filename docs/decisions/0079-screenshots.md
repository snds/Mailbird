# ADR-0079 · Screenshots of every screen, from one command

- **Status:** Accepted
- **Date:** 2026-11-13
- **Builds on:** [ADR-0016](0016-web-gateway.md) (the web demo on sample mail)

Vale is about to be restyled screen by screen on a new unicron. The browser suites that guarded earlier phases were never committed, so nothing in the repo shows what a screen looked like before a change. This adds one command that takes a picture of every main screen, so each step of a redesign can be compared with the one before it.

## Decisions

- **One command:** `pnpm shots` runs `tools/screenshots/shots.mjs`, beside the test mail servers. It builds `apps/web`, serves `dist` on a free port of this machine, and drives Chromium through `playwright-core` (1.63.0, a root dev dependency; it downloads no browser).
- **Every main screen, four ways:** 75 scenes in `tools/screenshots/scenes.mjs` (mail lanes, a conversation, compose, search, every calendar view and editor, contacts, notes, each settings section, ⌘K, `?`, the mini calendar), each at desktop 1440 × 900 and phone 390 × 844 (touch), light and dark: 296 pictures, named `<scene>-<desktop|phone>-<light|dark>.png`.
- **The real app on its sample data.** The pictures use the in-memory demo a plain browser already gets. Nothing is added to product code for them, and a request that leaves the machine fails the picture.
- **The same on every run:** a fixed clock (Thursday 2026-11-12, 09:16, Los Angeles), locale and zone; motion off; and each picture waits until the screen stops changing. A screen that never settles, or a page error, fails its picture, and the command exits non-zero.
- **Scenes reach their screen as a person would,** by the names on screen. When a screen changes, its scene is fixed in the same commit and keeps its name, so before and after pictures pair up by file name.
- **Pictures stay out of git** (`tools/screenshots/out` is ignored), and CI doesn't take them yet: there is no pixel comparison to pass or fail.

## Verification

- `pnpm shots` takes 296 of 296 pictures in about 3 minutes. Two runs of the same build: 289 identical; 7 differ, by at most 86 pixels each and by a shade (anti-aliasing on text edges).
- `tsc -b`, `oxlint`, `vite build` and the notes relay tests are clean. Nothing under `apps/web/src` changed, so the ratchet has nothing new to count: 208 className overrides, 2 style overrides and 16 raw elements, read from the source (`dsa` itself couldn't be fetched where this was written; CI runs it).
- The lockfile only gains `playwright-core`; the `@snds/dsa` entries are unchanged.

## Consequences

- **A redesign step shows its effect on every screen,** including the ones the new design doesn't draw (lanes, the Screener, splits, booking links, locked and shared notes).
- **A scene breaks when its screen's names change.** That's on purpose: the fix is in the scene, never a deleted scene.
- **Not covered yet:** states the demo can't reach (a sync error, loading, an empty inbox, the gateway's and the desktop app's own settings sections).
