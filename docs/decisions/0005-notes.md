# ADR-0005 · Notes

- **Status:** Accepted
- **Date:** 2026-10-13

## Decision

- **Format:** Markdown at rest. Notes are portable, diffable, and exportable at any time.
- **Editor:** Tiptap 3 core (MIT). **No Tiptap Pro.**
- **Sync:** a Yjs CRDT for conflict-free multi-device editing, through an optional, self-hostable relay. A Hocuspocus-compatible relay is MIT.
- **Import paths:**
  - Apple Notes: the Markdown export in iOS/macOS 26.
  - Google Keep: Google Takeout.
  - Obsidian and Bear: a folder of Markdown files.

## Why

There is no consumer Keep API and no Apple Notes API. Owning the format is the only way to deliver notes that actually sync, and local-first Markdown is the open-source trust story.

## Cross-vertical hooks

Notes can attach to an event (meeting notes), a thread, or a contact. The links are stored by the core, not inside the Markdown.

_Built in Phase 3. See [ADR-0012](0012-notes.md)._
