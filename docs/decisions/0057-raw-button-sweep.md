# ADR-0057 · Raw buttons: a sweep and a ratchet

- **Status:** Accepted
- **Date:** 2026-10-17
- **Builds on:** [ADR-0048](0048-design-system-cleanup.md) (the design-system cleanup and its ratchet), [ADR-0052](0052-unicron-packages.md) (unicron as packages)

ADR-0048 left one sweep for later: 43 plain `<button>` elements that bypass unicron entirely. The design-system scan (`dsa`) can't see them. It counts misuse of library components, and a plain element isn't one, so these never showed up as findings and could only grow. There were 44 by this phase.

Some of these are right as they are. A calendar day cell or a note's card is a whole surface you click, and no library control covers that. Others are library controls drawn by hand: a Cancel button, a chip's ×, a text link. This phase converts the hand-drawn ones the library already covers, and gives every raw button that stays a written reason. A new check stops the count from growing.

## Decisions

### What moved to the library

| Where | Before | Now | Why |
|---|---|---|---|
| Editor header Cancel (contact and event editors) | A hand-styled button, 12px padding | `Button variant="ghost"` | The composer's header already uses it; the editors now match it exactly |
| The × on chips: a note's links and tags, the quick note's link, a contact's labels, an event's reminders | Five hand-drawn versions: two full-height segments, one bare icon, two round 20px targets | One recipe: `IconButton icon="close"` on a `ghost-muted`, `icon-xs`, pill `Button` | One remove affordance everywhere, a 24px target, and a tooltip that says what it removes ("Remove tag trip") |
| Agenda's "Show the next 30 days" | A hand-styled text link | `Button variant="link"` | Its wrapper's padding shrinks by the button's own, so the text stays on the rows' 16px inset |

- **Chips now hug their ×.** Each chip's right padding is 2px, so the × sits as far from the edge as the text does on the left. The event editor's reminder chips are 28px tall, like the other chips, instead of 24px.
- **Icon sizes come from the library.** The ×s no longer set their own size, which also removes 5 `className` overrides.

### What stays, and why

There are 35 raw buttons in 21 files. `.dsa/raw-buttons.json` lists every file with its count and the reason it keeps them. They fall into three groups:

- **Whole surfaces (18):**
  - calendar day cells, event blocks and bars, and "+N more";
  - the mini month's days;
  - note cards;
  - color swatches;
  - the scanner's corner handles;
  - an attachment card (its body, and its Save side);
  - a message's collapsed header;
  - the nav rail's tabs;
  - `ListRow` itself.

  No library control is meant for these, and that's correct.
- **Rows that wait on the library (11):**
  - settings rows and provider choices;
  - Duplicates and Recently deleted;
  - booking links;
  - the newsletter bundle;
  - linked notes;
  - a contact's events and conversations;
  - the contact editor's "Add …" rows.

  Each is an icon, a title, and a hint, which is what `Item` is for. But `Item` only shows hover when it renders a link (`[a]:hover:bg-muted`). As a `<button>`, it would lose its hover. Converting these now would mean adding a `className` to each, which the ratchet counts against us.
- **Text actions that wait on the library (6):**
  - "Sign in again" and "Connect calendars and contacts";
  - "Save what's showing as a set";
  - a task's "planned for" and note links;
  - a contact's email address.

  These sit inside or flush with a line of text. `Button variant="link"` brings a button's height and padding, so each would sit 8–10px off the text it belongs to. The two existing link buttons (`oauth-sign-in`, `grammar`) already override that padding away.

The open side of a split chip (a note link or backlink, a reminder's Done) is counted with the whole surfaces. It waits on a library chip with a separate action.

### A raw-button ratchet

- `pnpm ds:raw-buttons` (`tools/ds-raw-buttons.mjs`) counts plain `<button>`s in `apps/web/src`, file by file, against `.dsa/raw-buttons.json`. CI runs it after the `dsa` ratchet.
- **A file that gains one fails the check.** The message says what to use instead (`Button`, `IconButton`, or `Item render={<button />}`). For a real whole surface, `--update` accepts the new count, and the baseline asks why.
- A `<button>` handed to a library control through `render={…}` isn't counted, because it's the system's element, not a bypass.
- **Counts can only go down.** When a file loses one, the check says to lock that in.

## Proposals for unicron

These four additions would let the rest of the sweep happen without overrides:

1. **`Item` hover for buttons.** Make `[a]:hover:bg-muted` apply to `button` too (`[a,button]:hover:…`), along with a pressed state for `data-selected`. This unlocks the 11 rows.
2. **A flush link size.** Add `Button size="inline"`: no height, no padding, and the surrounding text size. This is for text actions inside a sentence, and unlocks the 6 text actions. It also removes the two existing overrides.
3. **A chip with an action.** Add `Chip` with an optional remove or secondary action and a `variant` (`outline`, `secondary`, `muted`). It would replace the five hand-built chip containers, and the split chips in Notes.
4. **A raw-element metric in `dsa`.** Count plain interactive elements (`button`, `a` with `onClick`, `input`) with an allow-list. This would take over from `tools/ds-raw-buttons.mjs`, so every app using unicron gets the check.

## Verification

- **Screens:** 28 states captured before and after, in light and dark, on desktop and phone:
  - the quick note;
  - a note's chips, at rest and with the × hovered;
  - the agenda's "Show the next" link;
  - the event editor and its reminders;
  - the contact editor.

  Every difference traces to the table above:
  - Cancel moves 1–2px to the composer's padding;
  - the × gains a tooltip on hover;
  - "Show the next" moves 1px.
- **Ratchets:** `className` overrides went from 240 to 235, and the baseline is lowered to match. Raw buttons went from 44 to 35, which is now the baseline.
- **The check fails** when a file gains a raw button (tried with a probe file).
- **Regression:** all browser suites pass. `tsc -b`, `oxlint`, and `vite build` are clean.

## Consequences

- The remaining sweep is mostly upstream: three small unicron additions and one `dsa` metric. After a unicron release, the 17 waiting raw buttons can move over without overrides, and the baseline drops to the 18 whole surfaces.
- The ratchet is local to Mailbird until `dsa` has the metric.
