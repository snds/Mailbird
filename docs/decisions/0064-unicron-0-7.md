# ADR-0064 · unicron 0.7: dialog sizes, rows with a main action, and readable area colors

- **Status:** Accepted
- **Date:** 2026-10-17
- **Builds on:** [ADR-0058](0058-ds-additions-adopted.md) (the last design-system adoption)

ADR-0058 left two gaps in the design system, each worked around in Mailbird's own code:

- dialogs set their width, and sometimes their scrolling, by overriding `DialogContent`;
- three rows that have buttons of their own were still raw `<button>`s.

unicron 0.6 (snds/unicron#14) fills both. unicron 0.7 then judges contrast by what each component paints (APCA first, unicron#27, #30). This moves Mailbird from `@unicron/ui` 0.3.0 and `@unicron/tokens` 0.1.0 to 0.7.1 and 0.5.0.

## Decisions

### Dialog widths come from `size`

- **Every width override is now a size:** `md`, `lg`, `xl` (42rem), or `2xl` (48rem). The default, `sm`, needs nothing.
- **Two dialogs were 36rem,** which has no size:
  - writing settings moves down to `lg` (32rem), since its rows are short;
  - the booking-page preview moves up to `xl` (42rem), so the page shows nearer its real width.
- **Scrolling is the system's now:** every dialog scrolls inside itself when it's taller than the screen. The eight dialogs that added `max-h-… overflow-y-auto` drop it. The composer and the editor frame keep their own height limits, which are shorter than the screen on purpose.

### Rows with buttons use `ItemMain`

- **The booking link, the newsletter bundle, and a contact's upcoming meeting** are `Item` rows now. The row's main action is `ItemMain`, whose target covers the whole row, and its other buttons sit in `ItemActions` as their own controls.
- **Hover and focus come from the system.** Hovering Preview, Archive, or Join no longer looks like hovering the row.
- **The bundle's icon** sits flat, like other rows' icons, instead of in its own circle.

### Area colors as text get their own roles

- **The four area hues (`--vertical-*`) are fills,** tuned for dots, tints, and borders. Mailbird also drew them as text and icons, where they read poorly: amber measured APCA Lc 44 in light mode, and blue 50 in dark.
- **New text roles** (`--vertical-mail-text`, `-calendar-text`, `-contacts-text`, `-notes-text`, and `text-vertical-*-text`) use a step darker in light mode (`600`) and a step lighter in dark (`300`). Every text and icon use moves to them, and so do a note's wiki links (`--c-note-wikilink-text`) and today's label in the calendar (`--c-calendar-today-text`).
- **Filled chips** (today's date, the Screener's count) use their own pair: white on the `600` fill in light mode, and dark text on the `300` fill in dark. White on the old fill measured Lc 56 in dark mode.
- **Measured** with unicron's contrast math (`apca-w3`): text on the canvas and the chrome is Lc 79–87, and the chips 81–92. Reading text needs 75.

### What else 0.4–0.7 brings

- **Higher contrast, everywhere** (unicron #6, #27, #30): muted text, focus rings, field borders (now 3:1), the destructive color, and pressed toggles change. Screens change wherever those show. That's intended, not a regression.
- **New components Mailbird doesn't use yet,** among them `SecretField` and `CrownJewelSurface`. They're candidates for the locked-notes passphrase and the relay's encryption key.
- **A `beforeContent` slot** for an app that draws its own title bar. The desktop app doesn't yet.

## Verification

- `tsc -b`, `oxlint`, and `vite build` are clean.
- The full browser regression passes. The suites that open these rows and dialogs click the same names as before: the bundle (`phase12`), booking links (`phase16`, `phase21`), and a contact's meetings (`phase9`).
- **Ratchet:** `className` overrides drop from 229 to 211, and raw buttons from 19 to 16. The baseline is lowered to match.

## Consequences

- **16 raw buttons remain,** each a whole surface (calendar cells, the shell's rail) or a pattern that is Mailbird's own, as ADR-0058 lists.
- **Later unicron releases** are the usual move: the two tarball URLs in `apps/web/package.json`, and the tokens override in `pnpm-workspace.yaml`.
