# ADR-0058 · The design-system additions, adopted

- **Status:** Accepted
- **Date:** 2026-10-17
- **Builds on:** [ADR-0057](0057-raw-button-sweep.md) (the raw-button sweep and its four proposals), [ADR-0052](0052-unicron-packages.md) (unicron as packages)

ADR-0057 left 17 raw buttons waiting on the design system. It proposed three additions to unicron and one check in dsa. All four are now released:

- **unicron 0.3.0** (snds/unicron#9) adds `Item` as a button, `Button size="inline"`, and `Chip`.
- **dsa 0.2.0** (snds/dsa#2) adds the `rawElements` count.

This phase moves Mailbird onto them, and lets dsa do the counting Mailbird's own script did.

## Decisions

### What moved

| Where | Before | Now |
|---|---|---|
| Settings rows (Signatures, Shortcuts, Advanced mail) and the "Add an account" choices | Hand-built bordered buttons | `Item variant="outline"` as a button, with `ItemMedia`, `ItemTitle`, `ItemDescription`, and a chevron in `ItemActions` |
| Contacts: Duplicates and Recently deleted | Hand-built rows with their own hover and selected styles | `Item` as a button with `data-selected` (Duplicates uses `muted`) |
| A contact's recent mail, and a linked thing's notes | Divided lists of text buttons that changed color on hover | `Item size="xs"` as a button: hover is a background, like every other row |
| Text actions inside a line: "Sign in again", "Connect calendars and contacts", "Save what's showing as a set", a contact's email address, a task's "planned for" and note links | Hand-styled text buttons | `Button variant="link" size="inline"`, in the text size around them |
| Chips: a note's links, tags, backlinks, and reminder; the quick note's link; contact labels; event reminders | Hand-built pills, with the shared × from ADR-0057 | `Chip` (`outline`, `secondary`, or `muted`), with `ChipAction` for the main action and `ChipRemove` for the × |

- **Icons follow the system.** In rows, an icon is no longer forced to 20px; it takes the text's size (`1.25em`, about 17px at 14px).
- **App hues stay as classes.** A planned task's link keeps the calendar's hue, a note's link icon the notes hue, and a due reminder its notes tint. ADR-0048 settled this: app roles live in the app's classes, because the core can't know them.
- **Test hooks move to `data-role`.** `data-slot` belongs to the library: `Chip` sets `data-slot="chip"`, which takes precedence. So Mailbird's own hooks are now `data-role="note-link"`, `"note-reminder"`, and `"quick-link"`.

### What stays, and why

dsa counts **19** raw buttons. Every one is right as it is, or waits on something that isn't a small change.

- **Whole surfaces (14):**
  - the nav rail's tabs;
  - `ListRow` itself;
  - agenda event rows;
  - the mini month's days;
  - the month grid's days, event bars, and "+N more";
  - week-grid event blocks;
  - an attachment card's body;
  - a message's collapsed header;
  - note cards;
  - two sets of color swatches;
  - the scanner's corner handles.

  No library control is meant for these.
- **Rows with buttons of their own (3):**
  - a booking link (Preview, Copy);
  - the newsletter bundle (its menu);
  - a contact's upcoming meeting (Join).

  A row that is one button can't hold other buttons. These would need a "row with a main action" pattern, where the row's main area is the action and its other buttons sit beside it. That's a candidate for unicron if a second app needs it.
- **The contact editor's form rows (2):** "Add phone" and "Paste a signature". They're rows in Mailbird's inset form, which is Mailbird's own pattern.

Before, Mailbird's script counted 20. dsa counts 19, because dsa reads the code itself. An attachment card's Save button is handed to a `Tooltip` through a `render={…}` that spans several lines, so it belongs to the Tooltip; the script, which matched text, missed that.

### One check, in dsa

- `tools/ds-raw-buttons.mjs` and `.dsa/raw-buttons.json` are retired. dsa's `rawElements` is part of the same ratchet as the other counts, in `.dsa/baseline.json`, and CI runs it as before (`pnpm ds:ratchet`).
- The reasons that file kept, per file, are the list above.

## Verification

- **Packages:**
  - `@unicron/ui` 0.3.0 comes from its GitHub release tarball;
  - `@snds/dsa` is pinned to the merged commit (a9343c1, 0.2.0).
- **Ratchet:**
  - `className` overrides went from 235 to 228;
  - raw elements are 19, now tracked in the baseline;
  - the other counts are unchanged.
- **Screens:** the converted surfaces, before and after, in light and dark: the accounts dialog, the contacts list and detail, a note's chips, the calendar sidebar, the event editor, and the contact editor. Every difference traces to the table above.
- **Regression:** every browser suite passes (the 12 that touch these surfaces were run first, against a local pack of unicron#9). `tsc -b`, `oxlint`, and `vite build` are clean.

## Consequences

- **Rows feel the same everywhere.** Hover is a background, selected uses one neutral, and disabled is 50% opacity, whether the row is a contact, a setting, or a choice.
- **Raw buttons can't come back unnoticed** in Mailbird or in any other app that uses dsa 0.2.0.
- **A "row with a main action" pattern** would clear the three rows that have their own buttons. It's worth raising when a second app needs one.
