# ADR-0038 · Note cards (Phase 28)

- **Status:** Accepted
- **Date:** 2026-10-15
- **Builds on:** [ADR-0012](0012-notes.md) (notes, their sync records, and the importers), [ADR-0034](0034-connected-notes.md) (Markdown export)

The [competitive analysis](../research/competitive-analysis.md) §3 credits the **color and pinned card grid** to Google Keep. Short notes are found by where they sit and what color they are, before anyone reads them. Here, pinning already existed. Notes were a list of rows, with no color.

## Decisions

### A color per note, synced like pinning

- **Ten colors, named as Keep names them:** red, orange, yellow, green, teal, blue, purple, pink, brown, and gray, plus no color. Keep's two blues fold into one.
- **The note stores the name, not a shade.** That lets the app choose the shade for each theme, and it lets Keep imports keep their colors. A color this version doesn't know shows as a plain card instead of failing.
- **The color is part of the note's sync record**, next to pinned and archived (schema version 13). The newest change wins, as for the rest of the record. A device from before this phase sends records without a color. That clears the color, the same way it would undo any other record change.
- **Export and import carry it.** Exported Markdown gets `color:` in its front matter. Markdown front matter and Keep Takeout's `color` are both read back in.

### Shades are tokens, all three tiers

- **Tier 1 holds only the hue** (`--g-hue-red`, and so on).
- **Tier 2 holds tint lightness and chroma** (`--tint-l`, `--tint-c`). Light mode swaps these for a pale wash; dark mode swaps them for a deep, quiet one. One hue therefore works in both themes, and the text keeps its contrast.
- **Tier 3 is one token per card color** (`--c-note-card-teal` …), built from the two. Brown and gray take less chroma, as Keep's do.

### Cards when you want them

- **One button switches between rows and cards.** The choice is a notes preference in the core, next to "Move checked items down", so every device agrees.
- **While nothing is open, cards take the whole window.** Open one and the usual split view returns, with the grid narrowed beside the note. **Back** returns to the full grid. On phones, the note opens full screen, as rows do.
- **Column count adapts to the pane, not the screen.** CSS columns set a minimum card width (`--c-note-card-min`, 15rem). A container query drops it to a compact width when the pane itself is narrow, so two still fit beside an open note and on a phone. There are no breakpoints.
- **Cards flow down each column**, so a short note never leaves a gap beside a long one. The tradeoff is that the order reads down each column rather than across. Keyboard and screen-reader order still follow the list: pinned first, then newest.
- **Pinned and Others** stay separate sections, as in Keep.

### Seeing and choosing a color

- **The palette button** in the note's toolbar opens a row of swatches, each with a name. The current color is checked, and the button says it ("Color: Teal").
- **An open note takes its card's tint**, edge to edge, including the formatting bar.
- **In row view, a small dot** shows the color. It's read after the title ("Cabin packing list, Green"), so a row is still found by its name.

## Verification

- **Core:**
  - Setting and clearing a color, with forgiving names; unknown names give the plain card.
  - Other changes leave the color alone.
  - The color rides the sync record; a record without one is accepted.
  - Export writes `color:`, and Keep and front-matter imports read it.
  - The schema migrates to version 13.
- **Dispatcher:** `set_note_meta` with a color and with `""`, and `set_notes_prefs` with and without `grid`.
- **Browser, demo (`phase28`, 17 checks):**
  - Row view: color dots, read after the title.
  - Cards fill the window in several columns; colored cards are tinted and plain ones aren't.
  - Opening a card narrows the grid. Picking a color tints the note, its card, and the pane, and the menu checks it. **No color** clears it. Back returns to the full grid, and row view is one tap away.
  - Dark mode: deep tints.
  - Phone: two columns, and a note opens in its color.
  - No console errors.

  All earlier demo suites still pass.

## Consequences

- **Cards show the snippet, not the checklist.** Keep draws checkbox items on the card. That needs the note's structure in the summary, and can come later.
- **No drag to reorder.** Keep lets you drag cards around; here the order is pinned first, then newest, as in every other notes view.
