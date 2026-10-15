# ADR-0028 · Tasks on the calendar: checklist items from notes, planned as time blocks (Phase 18)

- **Status:** Accepted
- **Date:** 2026-10-15
- **Builds on:** [ADR-0012](0012-notes.md) (notes, Yjs sync, links), [ADR-0021](0021-calendar-planning.md) (find a time)

The [competitive analysis](../research/competitive-analysis.md) §3 lists two rows this phase takes:

- **Tasks time-blocked on the calendar** (Morgen): turns intentions into committed time.
- **Checklists that auto-sort completed items** (Apple Notes, Keep): lightweight tasks without a separate app.

Principle 2 (cross-vertical objects are the product) decides the shape: the tasks people already write are checklist items in notes, so those are the tasks.

## Decisions

### A task is a checklist item in a note. There is no task list to keep in step

`note_tasks` reads every checklist item (`- [ ]` / `- [x]`, nested ones included, code blocks skipped) from notes that aren't archived or deleted, in note order. Each task carries its note, its words, and its **index**: its place among the note's checklist items, in document order, which is the same order the editor walks them.

We didn't add a separate task store, and that's deliberate:

- **One home for each task.** A separate list would need two-way sync with the notes it came from, and would drift the first time someone edits a note on another device.
- **It syncs already.** The note's text syncs through the relay (ADR-0012), so a task checked on one device is checked everywhere.
- **Nothing to migrate or learn.** Every checklist you've written, or imported from Apple Notes or Keep, is a task the moment this ships.

### Planning makes an ordinary event, linked from the note

**Plan** on a task opens a small sheet: day, start, length, and calendar. **Find a free time** reuses `find_times` (ADR-0021) for the next three openings from 8 AM to 8 PM.

**Plan it** creates an event titled with the task's words ("From your note “…”" in its notes) and adds that event to the note's links. A task is *planned* when its note links to an event with its words as the title. With several such events, the next one to come shows, else the latest.

- **No new state.** The event syncs over CalDAV, and the link syncs in the note's record. Every device works out "planned" the same way.
- **The block is a real event.** It shows in every calendar app, reminders work, and you can move it like any other event. Rename it and it stops counting as that task's block, which is what you'd expect.
- **The event's page already lists its notes** (ADR-0012), so the way back to the checklist is there with no extra work.

### Checking off from the calendar edits the note's document

The checkbox in **Tasks** writes into the note itself. It runs in the web layer, because the note's Yjs document is the source of truth once a note has been opened (ADR-0012). The core holds the bytes but doesn't edit them.

1. Load the note's Yjs document (or seed it from Markdown, as the editor would).
2. Find the item by its index, **confirmed by its words**. If those don't match, take the first item with the same words. If none match, say so ("That item changed in its note") rather than tick the wrong one.
3. Change its `checked` attribute through `updateYFragment`, then save Markdown and state together. Sync picks it up like typing.

A toast offers **Undo**.

### Checked items move down: on by default, one setting

A ProseMirror plugin moves an item below its list's unchecked items when it's checked. It keeps each group's order, so unchecking puts an item back at the end of the open ones. It acts only on the lists where a checkbox changed in this transaction. It skips its own changes and edits arriving from other devices: those were sorted where they were made.

The calendar's checkbox applies the same sort. **Move checked items down** in Notes' More menu turns it off. The setting lives in the core (`notes_prefs`), so it's the same in every browser on a gateway.

## Tradeoffs

- **Index plus words, not item ids.** Markdown has no stable ids, and adding hidden ids would show up in exported files. The words check covers the common case (an edit elsewhere in the note shifts the indexes). Two identical items in one note still resolve to the first.
- **Moving is delete plus insert in Yjs.** If two devices move the *same* item at the same moment, it can end up twice. Concurrent typing elsewhere merges fine. This is the usual cost of reordering in a CRDT (a data type that merges concurrent edits), and it's rare for a checklist.
- **No due dates or priorities.** A time block is the commitment. Dates written in a task's words ("tomorrow") aren't parsed yet.

## Verification

- **Core (`cargo test -p pim-core`, 186 tests):**
  - Checklist lines in document order: nested items, `*`/`+` markers, `[X]`, empty items, and code blocks skipped.
  - Tasks across notes, with indexes counting every item.
  - Planned blocks: case-insensitive title match; the upcoming block wins over a past one; a deleted block falls back to the past one; events with other words don't count.
  - Archived notes keep their tasks to themselves. Prefs default to sorting.
- **Browser, demo (`phase18`, 19 checks):**
  - Open items listed with their notes.
  - Plan into a free time, shown on the task and opening the event, which links back to the note.
  - Check off from the calendar, Undo, then again; the note shows the item checked and moved below the open ones.
  - Checking and unchecking in the editor sorts; with the setting off, items stay put.
  - Edits in the note show in Tasks; phone width.
  - All earlier demo suites still pass.
- **Browser, two devices through the relay (`phase18-sync`):** checked off on A's calendar, it leaves B's Tasks; B's note has it checked, with no duplicate, and both agree.
- **Browser, gateway (`gateway-p18`):**
  - The core lists a never-opened note's items, nested ones included.
  - Planning creates a 90-minute block with the task's words, linked from the note.
  - Checking off rewrites the note's Markdown (moved below the open ones) and gives it Yjs state.
  - With sorting off (set through the core), a nested item stays in place; the editor opens the note as saved.
