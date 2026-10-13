# ADR-0008 · Mail depth (Phase 1b)

- **Status:** Accepted
- **Date:** 2026-10-13

## Decisions

### Conversations are built from headers only

Threads come from `Message-ID`, `In-Reply-To`, and `References`.

- A reply that arrives before its parent joins the parent's thread once the parent lands.
- Siblings that share an ancestor merge into one thread.
- We do not guess by subject. That's what makes clients merge every "Invoice" or "Hello" into one conversation.

Lists show one row per conversation. The row is the newest *matching* message, with thread-wide totals: message count, unread if any message is unread, starred if any is starred, and attachments if any has them.

### Triage acts on conversations

- **Archive and snooze** move every received message in the thread, so no older message is left behind in the inbox.
- **Star** marks the newest message; **Unstar** clears the whole thread.
- **Read** and **Unread** only queue server ops for the messages that actually change.

### Sent copies live locally, in mailbox `Sent`

After a send, the shell stores the raw message with no server key. Replies then appear inside their conversation right away, before Sent is ever synced.

Sent copies never make a thread count as "in the inbox", so replying from an archived thread doesn't resurrect it.

### Attachments: metadata in a table, bytes from the raw message

- The raw RFC 5322 message is stored in `messages.raw`.
- Attachment rows record each file's name, type, size, and index.
- Bytes are decoded on demand.
- `cid:` images under 3 MB are inlined as `data:` URLs, so they show inside the sandboxed frame with no network access.

Opening a file saves it to Downloads under a sanitized, unique name, then opens it with the default app (`tauri-plugin-opener`). The name sanitizing blocks path traversal like `../../.ssh/…`, and an existing file is never overwritten.

Outgoing attachments travel as base64 in the draft. There is a 25 MB total guard. Undo send restores them along with the draft.

### Backfill is progressive

- The first pass fetches the newest 500 messages, so the inbox is usable in seconds.
- Each later pass takes the next 200 older ones. A backfill worker repeats every 3 seconds until nothing is left.
- IMAP finds older mail by UID below the lowest one stored; JMAP pages `Email/query` by position.

### Push

- **IMAP:** IDLE runs one connection per account, re-issued every 25 minutes (RFC 2177 requires under 29). A change triggers a sync.
- **Servers without IDLE:** fall back to the 2-minute poll.
- **JMAP:** syncs on the poll for now. JMAP push over EventSource is next.

### JMAP is a first-class protocol

- **Store:** a migration (schema v3) adds `remote_id` beside IMAP's `uid`, plus the server's `state` string. Inserts take one `ServerKey`: UID, server id, or local-only.
- **Sync:** a pass runs `Email/changes` since the last state, then one `Email/query` page for backfill, and stores raw messages downloaded as blobs.
- **Local changes:** one `Email/set` pushes them. Archive moves mail to the `archive` role mailbox.
- **Send:** upload the message, `Email/import` it into Sent, then `EmailSubmission/set` with the matching identity. A JMAP account never needs IMAP or SMTP.
- **HTTP client:** `reqwest` with the same rustls/ring TLS config as IMAP. We dropped `jmap-client` because it pulls in aws-lc-rs by default, which needs cmake and nasm on Windows. Plain `http://` is refused except for localhost.
- **Fastmail** uses JMAP with an API token (the Email + Email submission scopes; not on Basic plans).

### Swipe gestures (phone)

Rows use Apple Mail's grammar: swipe left to archive, swipe right to toggle read.

- **Inputs:** touch and pen only. A mouse keeps normal click and text selection.
- **Scrolling:** `touch-action: pan-y` gives vertical movement to the browser, so a swipe never fights a scroll.
- **Feel:** the action commits past 35% of the row width, with a haptic tick as it arms. The tap that ends a swipe is swallowed, so it doesn't also open the row.
- **Accessibility:** every swipe action also exists as a button and a shortcut.

## Verified

- **Rust:** 42 unit tests (40 core, 2 shell) cover threading in any arrival order, thread merges, rollups, thread triage, Sent copies, attachments and `cid:` inlining, migrations v1→v3, JMAP store semantics, URL handling, and attachment-name safety.
- **IMAP integration** (Dovecot + SMTP sink): IDLE wakes on a new message, an attachment survives send, and 560 messages backfill as 500 + 60.
- **JMAP integration** (Stalwart):
  - Sync, plus local seen/flag/archive pushed up.
  - Changes made elsewhere via `Email/changes`, and server-side deletes.
  - Send via `EmailSubmission`, with the copy filed in Sent.
- **Playwright:**
  - Conversations: a thread opens with old messages collapsed, newest expanded.
  - Reply-in-thread: the reply joins the conversation.
  - Attachments: download, and attach in the composer (Undo keeps the file).
  - Thread archive.
  - Swipes on a touch viewport.
  - All Phase 1 flows and the tracker-blocking test still pass.

## Not yet

_Phase 1c delivered JMAP push, Sent/Archive sync-back, the rich-text composer, and attachment previews. See [ADR-0009](0009-mail-polish.md)._

- JMAP push (EventSource).
- Syncing Sent and Archive back from the server.
- CONDSTORE/QRESYNC for cheaper IMAP flag sync.
- A rich-text composer.
- Attachment previews (Quick Look style).
