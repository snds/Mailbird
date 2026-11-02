# ADR-0073 · Icons by code point, a rail that opens to labels, and a floating "new"

- **Status:** Accepted; the icon part is superseded by [ADR-0074](0074-unicron-0-16.md) (unicron 0.16; see "Amended 2026-11-02" below). The rail and the floating "new" stand.
- **Date:** 2026-11-02
- **Builds on:** [ADR-0052](0052-unicron-packages.md) (unicron), [ADR-0072](0072-demo-app-for-mac.md) (the demo app for Mac)

Sean opened the Mac demo and the icons were blank. He also asked for the left nav to show labels beside its icons, to close down to a column of icons, and for "new" to become a floating button for whatever area is open.

## Amended 2026-11-02: the icons come from unicron again

- **The cause was misread above.** WebKit does join the letters into the icon. What it gets wrong is the centring: it centres SVG text by the width of the separate letters ("home" is four glyphs, 96 units wide) before the font joins them into one icon, so a centred icon lands far to the left, outside its box. unicron found and fixed this in 0.13.1 ([snds/unicron#49](https://github.com/snds/unicron/pull/49), from Synapse's Mac app): the glyph is anchored at the left edge, and every Material Symbol is exactly 1em wide. Vale was still on unicron 0.9.
- **Drawing by code point worked for the same reason:** one character has no separate letters to mis-measure.
- **So Vale moves to unicron 0.16** and drops its stand-in ([ADR-0074](0074-unicron-0-16.md)).

The original decision, kept for the record:

## Decisions

### Icons draw by code point

- **Why they were blank:** unicron's `Icon` puts the symbol's name ("inbox") as text inside a small `<svg>`, and the Material Symbols font turns that word into the glyph through a ligature. WebKit, the engine in the Mac app (and Safari), doesn't apply ligatures to SVG text. So the word never became a glyph. Chrome does apply them, which is why the browser suites passed.
- **The fix:** draw each symbol by its own character (the private-use code point the ligature points to), which needs no ligature. The `<svg>` wrapper, the props, and the live font axes (fill, weight, grade, optical size) stay as they were.
- **The map comes from the font itself.** `apps/web/scripts/icon-codepoints.py` reads the installed `material-symbols` font's ligature table and writes `src/lib/material-symbols-codepoints.json` (4,301 names, about 31 KB gzipped). Re-run it after bumping `material-symbols`. A name missing from the map falls back to the ligature, as before.
- **Where it lives, for now:** in Vale (`src/lib/unicron-icon.tsx`). A small Vite plugin swaps it in for unicron's own icon module, so unicron's components (dialogs, menus, checkboxes) get it too, not just Vale's screens. The plugin runs in the build and in the dev server's pre-bundle.
- **It belongs in unicron.** When unicron's `Icon` draws by code point, drop the plugin, the file, and the map here. Until then the ratchet carries one look-alike (`Icon` declared in Vale), accepted in this review.

### The rail opens to labels and closes to icons

- **Open:** each area is a row with its icon and its label to the right, 11rem wide (`--c-shell-rail-width-expanded`). At that width a 1440px window still fits the list, the conversation, and its sender panel; at 13rem the sender panel dropped out. The command menu and settings at the bottom get labels too; the ⌘K hint stays in the closed rail's tooltip (and in `aria-keyshortcuts`), since it didn't fit beside "Commands".
- **Closed:** a column of icons at the old 4.5rem width, each named by a tooltip and an accessible label.
- **A toggle at the top** opens and closes it. The choice is kept on the device (`vale.nav.expanded`). With no choice saved yet, it opens on a wide window (64rem and up) and starts closed on a tablet.
- **The phone keeps its bottom tab bar,** labels under icons; that's a different control from the rail.

### "New" floats at the content's bottom right

- **One button, and what it makes depends on the open area:** Compose in Mail, New event in Calendar, New contact in Contacts, New note in Notes. It's the same action the rail's top button used to run, now out of the rail.
- **On a tablet and up** it sits at the bottom right of the content area, with its label beside the icon, so it says what it makes. **On a phone** it stays an icon-only button above the tab bar.
- **Trade-off:** it floats over content. Long lists and the calendar grid run under it, as with any floating action button. Lists keep scrolling past it, and nothing at the very bottom right is reachable only there.

## Verification

- `tsc -b`, `oxlint`, `vite build` and `pnpm build:demo` are clean. The ratchet's className overrides go down by one (211 → 210); look-alikes go up by one (the stand-in `Icon`, above).
- **In Chromium:** labels sit to the right of their icons; the rail measures 176px open and 72px closed; closing it is remembered after a reload; the floating button reads "New event" in Calendar and opens the event editor; the icon text is the code point, not the word; the console is clean. The browser regression passes.
- **On the Mac:** this PR's Mac workflow builds a dmg; the WebKit check is opening it and seeing the icons.
