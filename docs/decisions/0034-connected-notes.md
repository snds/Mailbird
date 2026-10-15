# ADR-0034 · Connected notes: [[links]], Linked from, and export (Phase 24)

- **Status:** Accepted
- **Date:** 2026-10-15
- **Builds on:** [ADR-0012](0012-notes.md) (notes, Markdown at rest, Yjs sync)

The [competitive analysis](../research/competitive-analysis.md) §3 credits three notes features this app lacked:

- **Backlinks and [[wikilinks]]** (Obsidian, Bear): ideas connect without folders.
- **Local-first Markdown files** (Obsidian): your notes are files you can take anywhere.
- **Markdown import and export** (Apple Notes 26, Bear): import existed, but export didn't. ADR-0012 listed "exporting all notes as a folder of Markdown files" as a follow-up.

Notes could already link to events, contacts, and conversations. They couldn't link to each other.

## Decisions

### `[[Title]]`, exactly as Obsidian and Bear write it

A link to another note is written `[[Title]]` in the note's Markdown. `[[Title|shown text]]` and `[[Title#Heading]]` work too. The syntax is the de facto standard, so notes imported from Obsidian or Bear keep their links, and exported notes open there with links intact.

In the editor, a link is an **inline element** with its own Markdown reader and writer. It isn't plain text, because the Markdown writer escapes plain brackets (`\[\[Title\]\]`), which would break links in every other app. A test parses and re-saves Markdown with links, aliases, headings, checklists, and code, and gets the same text back.

Links in code (`` `[[not a link]]` ``) stay code.

### Three ways to make one

- **Type `[[`.** A list of matching notes opens beside the cursor. Use ↑↓ and Enter, or click or tap. Esc closes it and leaves the brackets as typed. When no note has the exact title, the list ends with **New note "…"**.
- **Type the whole thing.** Typing the closing `]]` turns `[[Title]]` into a link, for people who know the title already.
- **Paste or tap.** Pasted `[[Title]]` text becomes a link. On phones, where brackets are hard to reach, the format bar has **Link to a note**, which types `[[` and opens the list.

Older notes, and notes synced from a device that hasn't updated yet, can hold `[[Title]]` as plain text. Those become links when the note opens.

### Following a link

- **Click or tap a link,** or select it and press Enter, to open the note with that title. Matching ignores case, as in Obsidian. Archived notes open too.
- **A link to a note that doesn't exist yet starts it,** titled from the link, with a "Started …" confirmation. This is how Obsidian and Bear let you link first and write later.
- **Links look like notes, not the web.** They use the notes accent on a light tint, not the underlined link color, so the two kinds read differently. The color comes from two component tokens, `--c-note-wikilink-text` and `--c-note-wikilink-bg`.

### Linked from

Every note lists the notes that link to it, as chips under its tags: **Linked from** *Design review agenda*. One tap opens that note. The core finds them by parsing each note's Markdown for links to this title, so `[[Trip]]` doesn't count as a link to "Trip plan", and a link to itself or in a deleted note doesn't count.

In note lists, a link reads as its text: "Background: Icon axis ideas", not `[[Icon axis ideas]]`. Markdown escapes (`\[`) read as plain characters too.

### Export: Markdown files with front matter

**Export all as Markdown**, in the Notes menu, writes one file per note:

- **The file name is the title,** because Obsidian resolves `[[Title]]` by file name. Characters file systems refuse (`/ \ : * ? " < > |`, and `# ^ [ ]`, which break Obsidian links) become spaces. Duplicate titles get a number ("Budget 2.md"). An untitled note is "Untitled.md".
- **Front matter** holds the title, tags, created and updated times (ISO 8601, UTC), and `pinned: true` or `archived: true` when they apply.
- **The body** is the note's Markdown as stored, links included.

On the **desktop**, the export is a new folder in Downloads (**Notes**, then **Notes (1)**), never mixed into an old one. In a **browser** (the gateway and the demo), it's a zip with one folder (**Notes 2026-10-15**). The zip is written by a small built-in writer. It stores files uncompressed, which is fine for text this size.

**The export reads back in.** This app's Markdown importer now also reads `archived: true`. Importing an export brings back the same titles, text, tags, pins, archive state, and times. A core test checks this round trip.

## Verification

- **Core (`cargo test -p pim-core`, 201 tests):**
  - link parsing: aliases, headings, code, and broken brackets;
  - list text without brackets or escapes;
  - Linked from: case-insensitive, exact title, not itself, not deleted notes;
  - finding by title;
  - export: file names, uniqueness, front matter;
  - the export-and-import round trip.
- **App (`cargo test -p pim-app`):** backlinks, finding, export, and the desktop's folder in Downloads, through the dispatcher.
- **Browser, demo (`phase24`, 26 checks):**
  - a sample link opens its note, Linked from goes back, and the list shows link text;
  - `[[` suggests notes and Enter links one; an unknown title offers a new note; Esc closes the list; typing `]]` links;
  - a link to a missing note starts it, already listed as linked; an archived note opens;
  - the zip is valid, with one folder of 7 notes, front matter, plain `[[links]]`, and archived notes marked;
  - on a phone, the format bar button opens the list, which fits, and a tap links.

  All earlier demo suites pass, including both notes sync suites against the relay. `notes` and `notes-sync` now find "Icon axis ideas" by its exact title, because a sample note links to it.
- **Browser, gateway (`gateway-p24`):**
  - a link opens through the gateway, and Linked from comes from the core;
  - a link to a missing note starts it in the core;
  - the export downloads as a zip with front matter and links, including the started note.

## Consequences

- **Renaming a note doesn't update links to it.** Obsidian rewrites them. Here, notes edit as Yjs documents, so the core can't safely rewrite another note's text behind an open editor. Old links then open a new note with the old title. A later phase can rewrite links through each note's own Yjs document. *(Done in [ADR-0035](0035-links-that-keep-up.md).)*
- **Links name titles, not ids.** That's what keeps them portable. Two notes with the same title open the most recently changed one.
- **Linking an existing note to an event, contact, or conversation from the note itself** is still a follow-up from ADR-0012. *(Done in [ADR-0035](0035-links-that-keep-up.md).)*
- **Graph and canvas views** (Obsidian) can now be built on the same links. They aren't in this phase.
