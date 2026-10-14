# ADR-0012 · Notes (Phase 3)

- **Status:** Accepted
- **Date:** 2026-10-14
- **Builds on:** [ADR-0005](0005-notes.md)

## Decisions

### Markdown is what's kept; Yjs is how it's edited

Each note row stores two things, plus a few indexed fields (title, snippet, tags, pinned, archived) for lists and search:

| Field | What it is | Who reads it |
|---|---|---|
| `body` | The note as Markdown | Search (FTS5), lists, export, "Copy as Markdown" |
| `ydoc` | The note's Yjs state | The editor, and sync |

- **The editor** is Tiptap 3 core (MIT), bound to the note's Yjs document through the Collaboration extension. Every change saves both fields together after a short pause, and again when the note closes. The Markdown is derived from the Yjs document by Tiptap's own Markdown extension, so the two never disagree.
- **Undo** comes from Yjs, so it only undoes your own changes, never someone else's.
- **What a note can hold:** headings, lists, checklists, quotes, code, and links. One list of extensions builds the editor, the schema, and the headless converter, so all three always agree.
- **The first line is the title**, styled larger (the Apple Notes convention). There is no separate title field to keep in sync.
- **A note opened for the first time** (new, imported, or written before Yjs) gets its Yjs content from its Markdown. That seed is written as one fixed Yjs client derived from the note's id. If two seeds happen at once (the background sync and the editor, say), they produce identical items and merge into one copy.

### Records sync whole; text syncs as a CRDT

A note is split into two parts that sync differently:

- **The record** holds pinned, archived, deleted, tags, links, created, and updated. It lives in one shared index document (a Y.Map). It's replaced whole, and the newest `updated` wins, both on the relay and in the core.
- **The text** lives in one Yjs document per note. Edits merge character by character, so two people typing at once both keep their words.

How the two parts move:

- **The open note** stays connected and merges live.
- **A closed note** connects briefly when its record says it changed. It merges, saves Markdown and state to the core, then disconnects.
- **Opening a note mid-merge** cancels that merge, and the editor takes over.
- **Edits only count when the text changes.** Opening a note can re-shape its Markdown slightly (a trailing paragraph, list markers). That doesn't count as an edit and doesn't move the note up the list.
- **Deletes leave a tombstone,** so they reach other devices. Undo restores the note.

### The relay is Hocuspocus, self-hosted

- **The protocol:** the web layer runs sync with `@hocuspocus/provider` (MIT). Each document is its own session on one shared socket.
- **The relay we ship:** `tools/notes-relay`, about 70 lines on `@hocuspocus/server` (MIT). Any Hocuspocus-compatible server works.
- **What our relay does:**
  - Checks the token in constant time.
  - Accepts only `mailbird/index` and `mailbird/note/<id>`.
  - Stores Yjs state files with an atomic rename.
- **Transport:** the app only connects over `wss://`, except to localhost. The token is kept in the system keychain (the native shell) under `notes-relay`.
- **Privacy:** the relay can read notes. They're encrypted in transit, not end to end. The sync dialog says so. End-to-end encryption of Yjs updates is a later decision.

### Links between notes and everything else

- **Stable keys:** a link stores a key every device shares (an event's iCalendar `UID`, a contact's vCard `UID`, or a conversation's first `Message-ID`) plus a label. It also stores this device's id for the target when the target is here. A link to something not synced yet still shows its label.
- **Where links show up:**
  - Events, contacts, and conversations each have a **Notes** section with **New note**. A note started there is titled after the item and linked to it.
  - Each link on a note opens its item: an event on its day, a conversation even if it's archived.
- **Navigating between areas:** the app keeps a small "jump" in its UI store. Each area reads it on open, so links work across Mail, Calendar, Contacts, and Notes.

### Import, not sync, with other apps

There is no Keep API and no Apple Notes API ([ADR-0005](0005-notes.md)). The importer reads exported files. The web layer reads the picked files or folder, and the core parses them.

| Source | What's read | What carries over |
|---|---|---|
| **Google Keep** (Takeout) | One `.json` per note | Title, text, checklists (as task lists), labels (as tags), pinned, archived, web links, timestamps. Trashed notes are skipped; the `.html` copies are ignored. |
| **Markdown folders** (Obsidian, Bear, Apple Notes exports) | `.md`, `.markdown`, and `.txt` files | YAML front matter (`title`, `tags`, `created`, `updated`/`modified`, `pinned`), Bear-style `#tags` (not inside code or headings), and the folder path as a tag. A file whose text doesn't start with its title gets the file name as a heading. Dot-folders like `.obsidian` and `.trash` are skipped. |

- **Re-importing is safe:** importing the same files again adds nothing (each note remembers where it came from).
- **Attachments:** images, recordings, and drawings aren't brought over yet. The report counts them.

## Verified

- **Rust:** 102 core tests (+10 for notes).
  - Titles and snippets.
  - Search across title, text, and tags.
  - Tag clean-up.
  - Saves that don't change the order.
  - Archive, delete, and restore.
  - Stable-key links resolving locally (and not, for unsynced targets).
  - Newest-record-wins merges.
  - Keep Takeout, front matter, inline tags, folders, Apple-style first-line titles.
  - Re-import dedup.
- **Relay (in CI):** two clients merge concurrent edits; a wrong token and an unknown document are refused; documents survive a restart.
- **Playwright, notes (31 checks):**
  - Pinned first, prefix search, tag filters.
  - The first line becomes the title.
  - Checklists through the format bar, and the exact Markdown that gets saved.
  - Tags and pins, empty new notes thrown away, archive, delete with undo.
  - Event → note → event, meeting notes from an event, a person's notes, notes from a conversation.
  - Keep and Markdown import, and re-import.
  - The phone layout.
- **Playwright, two devices through a real relay (13 checks):**
  - Unencrypted relay addresses refused.
  - Seeded notes merged without duplicates.
  - A new note and its text arriving.
  - Live edits in both directions.
  - Simultaneous typing kept on both sides.
  - Pins and deletes syncing.
- Every earlier suite still passes.

## Not yet

- End-to-end encryption between devices and the relay.
- Images and attachments in notes (and from imports).
- Linking an existing note to an event, contact, or conversation from the note itself. Links are made from those items today.
- Note folders or nested tags beyond `a/b` names, and sharing a note with someone else.
- Exporting all notes as a folder of Markdown files.
