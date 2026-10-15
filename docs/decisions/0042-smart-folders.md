# ADR-0042 · Smart folders for notes (Phase 32)

- **Status:** Accepted
- **Date:** 2026-10-15
- **Builds on:** [ADR-0012](0012-notes.md) (tags and search), [ADR-0023](0023-contacts-that-keep-themselves.md) (contacts' smart groups), [ADR-0038](0038-note-cards.md) (colors), [ADR-0039](0039-note-reminders.md) (reminders)

The [competitive analysis](../research/competitive-analysis.md) §3 credits **inline #tags and smart folders** to Bear and Apple Notes: "organization emerges from writing". Tags have been here since Phase 3. This phase adds smart folders: saved searches that fill and empty themselves.

## Decisions

### A folder is a rule, not a place

- **A note is in every folder whose rule it matches.** Joining or leaving a folder never moves or changes the note, and deleting a folder leaves its notes where they are. That's the difference from a real folder, and the reason they can't conflict with tags.
- **The rule has six parts.** A note must match every part that's filled in:
  - **has any of these tags** (with or without `#`, any case);
  - **contains the words**, the same full-text search as the search field;
  - **linked to** an event, a person, a conversation, or anything;
  - **a color**, or any color;
  - **has a reminder**;
  - **has to-dos left**: an unchecked checklist item.
- **A folder needs a name and at least one part.** Otherwise it would just be "all notes", and the form says so.
- **Archived notes stay out of the folder and its count,** as they stay out of Notes.

### Where folders live

- **The rules are a device setting**, the same as contacts' smart groups (ADR-0023). Notes sync through each note's own record, and a folder belongs to no note.
- **Counts are worked out when listed,** so the chip's number is always current.

### In Notes

- **Folders are chips above the tags.** Each has its count; tapping one opens it, and tapping it again shows every note. The pane title becomes the folder's name, and the search field reads "Search To do".
- **Searching inside a folder narrows it further.** The folder's words and the search are one full-text query, because SQLite's FTS takes a single MATCH and ANDs its terms.
- **A tag chip narrows a folder too.**
- **The tune button edits the open folder.** The form says what happened ("Added “To do”: 1 note so far"; "Deleted “Colorful”. Its notes are still in Notes").
- **An empty folder explains itself:** "No notes in this folder yet. They join by themselves when they match."

## Verification

- **Core:**
  - Tags match any, ignoring `#` and case.
  - "To-dos left" means unchecked items only, and every part must match.
  - Words and links filter; a search narrows a folder.
  - Archived notes leave the count.
  - Editing keeps the folder's place; deleting leaves the notes; a deleted folder says so.
  - A folder needs a name and a rule, and unknown colors or link kinds are refused.
- **Dispatcher:** save, list inside, delete.
- **Browser, demo (`phase32`, 16 checks):**
  - a folder with no rule says what it needs;
  - "To do" holds just the list with items left, is named in the pane title, and shows its count on the chip;
  - "Colorful" (any color) holds the three colored notes, and a search narrows it;
  - coloring another note makes it join on its own;
  - after an edit matches nothing, the empty state explains why;
  - deleting leaves every note and the title returns to Notes;
  - the form fits a phone;
  - no console errors.

  All earlier demo suites still pass.

## Consequences

- **Folders don't follow you to other devices yet.** They'd need their own sync record. Contacts' smart groups have the same limit, so both can move together.
- **No "any of" between parts.** A folder is all of its parts. Two folders cover "this or that" well enough for now.
