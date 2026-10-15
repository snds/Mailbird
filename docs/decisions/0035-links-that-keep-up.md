# ADR-0035 · Links that keep up: renames and linking from the note (Phase 25)

- **Status:** Accepted
- **Date:** 2026-10-15
- **Builds on:** [ADR-0034](0034-connected-notes.md) (connected notes), [ADR-0012](0012-notes.md) (notes and their links)

ADR-0034 left two gaps:

- **Renaming a note broke links to it.** `[[Old title]]` then opened a new, empty note.
- **Links to events, people, and conversations could only start from those items.** You couldn't attach an existing note to a meeting from the note itself. ADR-0012 had listed this as a follow-up.

## Decisions

### A rename offers to update the links, and never does it silently

When a note's title changes and other notes link to the old title, a message appears:

> **2 notes link to "Icon axis ideas"**
> Point them at "Icon axes" instead? **Update links**

- **When it appears:** once the title has stopped changing for a moment (1.5 s), or right away when the note closes. Typing a title letter by letter doesn't ask once per letter.
- **Why it asks:** Obsidian updates links automatically, which is right when titles are file names. Here a title is just the first line, so a change can be a real rename or a typo fixed and undone. Asking keeps the choice visible, and ignoring the message leaves everything as it was.
- **Accepting** updates every link to the old title, matched as links are, ignoring case. `[[Old#Heading]]` becomes `[[New#Heading]]`, and shown text (`[[Old|shown]]`) stays. A confirmation then says how many notes changed.
- **No links, no message.** Renaming a note nobody links to says nothing.

### Each update goes through that note's own sync document

The core doesn't rewrite Markdown. Notes are edited as Yjs documents (the shared editing format that lets edits from several devices merge). Rewriting another note's text underneath would lose edits made on another device. So, for each note that links to the old title:

1. Load its Yjs document. A note never opened in an editor is first built from its Markdown, the same way the editor does.
2. Set the `target` of each matching link element.
3. Save the Markdown and the document as an **ordinary edit**. It counts as a change, so sync carries it to other devices and merges it with whatever else changed there.

The core adds one query: **notes linking to a title, except one.** "Linked from" now uses the same query.

### Link a note to an event, person, or conversation, from the note

Next to **Tag** on every note, **Link** opens a picker:

- **Before you search:** the nearest events first (a month back to three months ahead), then people and recent inbox mail.
- **When you search:** events by title, people by name or email, and conversations by text, across the inbox and the archive. Up to five of each.
- **Birthdays and holidays are left out.** They aren't events you can attach a note to.
- **Something already linked** shows "Linked already" and can't be picked twice.

A pick makes the same kind of link the item would have made itself (`note_link_for`). So the note now appears in that event's, person's, or conversation's **Notes** section, and the chip on the note opens the item.

## Verification

- **Core (`cargo test -p pim-core`):** notes linking to a title (case-insensitive, with or without excluding one note, an empty title), alongside the ADR-0034 tests.
- **App (`cargo test -p pim-app`):** the command through the dispatcher.
- **Browser, demo (`phase25`, 24 checks):**
  - a rename offers to update two notes, and accepting updates both; the links show and open the new title, keep `#Grade`, and Linked from still finds both;
  - ignoring the offer leaves links alone; renaming an unlinked note offers nothing;
  - the exported Markdown names the new title;
  - an event, a person, and a conversation link from the note; a repeat is refused; the event lists the note;
  - the picker fits a phone and shows nearby events before any search.

  All earlier demo suites pass, including `notes-sync` against the relay.
- **Browser, gateway (`gateway-p25`):** a rename through the gateway updates the stored Markdown and Linked from, and an event link from the note is saved in the core.

## Consequences

- **A link written as plain text in an old-style document** (before ADR-0034, and not yet opened) isn't renamed. It becomes a real link the next time its note opens, and the next rename updates it.
- **The offer goes away if you ignore it.** Renaming again offers again, from the title the links still use.
- **Two notes with the same title share their links,** as in ADR-0034. A rename updates links to that title, whichever note they meant.
