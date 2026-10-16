# ADR-0053 · The map of notes (Phase 41)

- **Status:** Accepted
- **Date:** 2026-10-16
- **Builds on:** [ADR-0034](0034-connected-notes.md) (`[[links]]` and Linked from), [ADR-0012](0012-notes.md) (notes linked to events, contacts, and conversations)

The [competitive analysis](../research/competitive-analysis.md) §3 credits Obsidian with **graph and canvas views**: "optional spatial thinking for power users." ADR-0034 left the graph for later, once links existed to draw. This phase adds the graph. The canvas, a board you arrange by hand, is a different tool and stays out.

## Decisions

### A third way to see the same notes, off until you ask

- **The Notes header gets a Map button** (the hub icon). It's a toggle, so it reads as on or off to screen readers. While the map is on, the list-or-cards button hides, because it doesn't apply.
- **The choice is remembered** with the other notes settings, next to list or cards. The map is off by default: most people never need it, and the list is the faster way to find a note.
- **The map shows the notes the list would show.** Search, tags, smart folders, and the archive all apply, so "the map of my #trip notes" is one tap on a tag. This also keeps a large collection readable: narrow it first.
- **It takes the list's place,** full width when no note is open. Opening a note puts it beside the map on desktop, the same as a card, and the map marks it. On a phone the note opens full screen, and Back returns to the map.

### What's on it

| On the map | Drawn as | Joined by |
|---|---|---|
| A note | A dot in its card color (amber when it has none). It grows with its number of links. | A solid line for each `[[link]]` |
| An event, person, or conversation a note links to | A ringed circle with its icon, in the area's hue: calendar coral, contacts green, mail blue | A dashed line in that hue |

- **A link goes where following it would.** That means the most recently changed note with that title (ADR-0034), with case ignored.
- **A link shows only when both ends are on the map.** The map of a search is the map of what you searched for.
- **Not on the map:**
  - links to notes that don't exist yet (they'd be ghosts you can't open);
  - a note's links to itself;
  - repeated links (one line per pair).
- **What notes link to is shared.** Two meeting notes linked to the same event meet at that event. This is the map's main use in a PIM app: it shows which notes belong to the same meeting or person, even when they don't link to each other.
- **Something not on this device** (a contact from another account, say) still shows, with a dashed ring. Tapping it says it isn't here, rather than doing nothing.
- **The chips above the map** are its legend and its filters: Events, People, and Conversations, each with a count, plus "Unlinked notes". Turning one off hides that kind. A chip shows only when there's something to hide.

### It holds still

- **It's laid out once, then stays put.** The layout is a force layout: linked nodes pull together, everything pushes apart a little, and a light pull to the middle keeps separate clusters in view. It settles before it's drawn. Obsidian's graph keeps moving; this one doesn't, because a map you're reading shouldn't drift.
- **The same notes land in the same places,** with no randomness, so the map looks the same each visit, and the tests can rely on it.
- **An edit nudges the map instead of redrawing it.** Nodes start from where they were, so adding a link moves a few dots, not all of them.
- **Dragging a node moves just that node,** and it stays where you leave it.
- **Big collections:** the layout takes about 80 ms for 300 nodes and 350 ms for 1,000 on a laptop. That's fine for a map you open, not for one that animates.

### Moving around

- **Pan:** drag the background.
- **Zoom:** the wheel or a trackpad pinch, centered on the pointer; two fingers on a phone; or the zoom controls (+, −, and Fit).
- **Fit:** the map fits itself until you pan or zoom. Fit hands that back to it.
- **The zoom controls sit at the bottom left,** clear of the phone's new-note button.
- **Labels:** every node is labelled when zoomed in or when the map is small. When zoomed out, labels show for hubs (four or more links), the open note, and whatever you're pointing at.
- **Hovering or focusing a node** lights it, its neighbors, and their lines, and fades the rest.

### Keyboard and screen readers

- **The map is one Tab stop.** It lands on the open note, or the first one.
- **The arrow keys walk the map.** Each press moves to the nearest linked node in that direction. If there's none, it moves to the nearest node of any kind. The view follows the focus.
- **Enter or Space** opens what's focused. **+**, **−**, and **0** zoom and fit.
- **Each node says what it is,** for example "Design review agenda, 2 links", "Icon axis ideas, Purple, 1 link", or "Event: Design review, 1 note".
- **A summary under the map** gives the counts and the keys, such as "4 notes and 3 linked items, with 4 connections."

### One source for the core and the demo

- **The core builds the map** (`note_graph`, given the list's query) on the desktop and the gateway.
- **The demo builds the same map in the browser,** by the same rules.
- **Opening a linked item** (an event on its day, a conversation with its row) moved into a shared hook, `useOpenLink`. The note's link chips and the map now open things the same way.

## Verification

- **Core** (`cargo test -p pim-core`, 223 tests): the map's links resolve by title and case and are kept once per pair. They skip a note's own links, missing notes, and notes off the map (search, archive). Linked items are shared between notes, and one not on this device has no target.
- **App** (`cargo test -p pim-app`): `note_graph` routes through the dispatcher and returns both notes and their link. Clippy is clean.
- **Browser, demo** (`phase41`, 37 checks):
  - the map is off by default, takes the list's place, and the toggle reads on;
  - counts and node names, with color, are correct, and archived notes stay off;
  - a click opens a note and marks it, the map is one Tab stop, and an arrow walks to the linked note;
  - zoom and Fit work, a dragged node stays put without opening, and the background pans;
  - the chips hide events and unlinked notes;
  - a person opens in Contacts and an event in Calendar, and the map is remembered;
  - search narrows the map, and a new `[[link]]` joins it;
  - turning the map off brings back the list;
  - in dark mode, and on a phone: full width, controls clear of the new-note button, a tap opens a note, and Back returns to the map;
  - there are no console errors.
- **Browser, gateway** (`gateway-p41`): the core's map comes through, a link resolves case-insensitively, and the map leaves out missing notes, counts the unlinked note, opens a note from a node, and remembers that it's on.
- **Regression:** all earlier browser suites pass. `tsc -b`, `oxlint`, and `vite build` are clean. The design-system ratchet is unchanged at 241 / 2 / 0 / 0.

## Consequences

- **With a note open on desktop, the map has the list's width.** It still works there, but it's at its best with the note closed. A wider split is a possible follow-up.
- **Labels can overlap** where nodes crowd together, as in most graph views. Zooming in separates them.
- **Not in this phase:** the canvas; links to notes that don't exist yet; a "local graph" of one note and its neighbors inside the note; and coloring by tag. Each can build on `note_graph`.
