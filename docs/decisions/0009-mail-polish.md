# ADR-0009 · Mail polish (Phase 1c)

- **Status:** Accepted
- **Date:** 2026-10-13

## Decisions

### Sync covers INBOX, Archive, and Sent

The store keeps three mailboxes per account: `INBOX`, `Archive`, and `Sent`. Every message in `Archive` counts as archived, so the Archive lane shows mail archived on other devices too.

- **IMAP:** one pass maps each store mailbox to the server's special-use mailbox (RFC 6154) and skips any the server doesn't have. Work happens in two phases:
  1. Push every pending op on every mailbox.
  2. Fetch.

  That ordering keeps an unarchived message from disappearing for a pass. In the old order, its Archive row was dropped before INBOX had fetched its new copy.
- **Moves:** UIDs that a push moved out of a mailbox are dropped locally (`moved_out`). The copy arrives with a new UID in its new mailbox, and a stale local stand-in with the same `Message-ID` is replaced, never duplicated.
- **JMAP:** sync is account-wide, with one `Email/changes` state for the whole account. A message that changes mailbox comes back as a *move*: the store updates the row in place, with no re-download. `cannotCalculateChanges` resets the account's server copies.
- **Unarchive** is a real op. From Archive it moves mail back to INBOX on the server.
- **Sent copies:** the local copy written at send time is replaced by the server's copy when it syncs. Matching works because we now set our own `Message-ID`. Its domain is the sender's domain, never the machine's hostname, which lettre would otherwise leak.

### JMAP push uses EventSource

- The supervisor keeps one push connection per account, so JMAP accounts no longer wait for the 2-minute poll.
- **JMAP accounts:** an `EventSource` on the session's `eventSourceUrl` with `types=Email&closeafter=no&ping=60`. A state that differs from the stored one triggers a sync. Pings and our own state are ignored.
- **IMAP accounts:** IDLE, as before.
- **Connection:** a separate HTTP client with only a connect timeout, so the long-lived stream isn't cut by the 30 s request timeout.

### Attachment previews are in-app, and conservative

Clicking a chip opens a preview. A separate **Save** button keeps the old save-and-open path. The bytes come over IPC as a raw binary response (`attachment_data`), not base64 JSON.

| Type | Rendered as | Why it's safe |
|---|---|---|
| `image/*` | `<img>` from a blob URL | `<img>` never runs script, even in an SVG. |
| `application/pdf` | The webview's PDF viewer, in an iframe | The bytes must start with `%PDF-`, so HTML mislabeled as PDF never reaches a frame. |
| `text/*` (not HTML), JSON, XML ≤ 1 MB | A `<pre>` | Decoded as text. |
| Everything else | Save and open | — |

- **Thumbnails:** image chips show one for files under 8 MB.
- **Cleanup:** blob URLs are revoked when the preview closes.

### The composer writes rich text with Tiptap (MIT)

- **Formatting:** StarterKit without headings or code blocks, plus a placeholder and a link mark. The toolbar has bold, italic, link, bulleted and numbered lists, and quote. Markdown-style input rules and the standard shortcuts also work.
- **Every message carries both parts.** `Draft.bodyHtml` goes out with the plain-text `body` as `multipart/alternative`, nested inside `multipart/mixed` when files are attached.
  - The text part is generated from the HTML. Quotes become `> `, list items become `- ` or `1. `, and links keep their address.
  - The HTML part is wrapped with a charset and *inline* quote styling, since many clients drop `<style>`.
- **Replies** start above a real `<blockquote>`. The quote is rebuilt from the original's text part. The sender's HTML is untrusted, and the editor's schema would drop most of it anyway.
- **Links** are limited to `http(s):` and `mailto:`. Bare domains get `https://`, and bare addresses get `mailto:`. A refused scheme keeps the link field open and says why.
- **Focus:**
  - Format buttons don't take focus, so the phone keyboard stays up.
  - `Mod-Enter` sends without inserting a line break.
  - The dialog focuses the first field: To for new mail, the body for replies.
  - For the composer's first second, focus that lands outside it is pulled back. This covers Sonner handing focus back to the page as an Undo toast closes.
- **Pinned version:** Tiptap is pinned to 3.31.3. 3.32.0 was published the day this landed, and we don't adopt releases that new.

## Verified

- **Rust unit tests:** 47 in core and 2 in the shell.
  - Archive mailbox semantics and unarchive.
  - Moved-out rows are replaced by the Archive copy.
  - Sent stand-ins are replaced by the server copy.
  - JMAP moves happen without re-download, and a reset replaces every server copy.
  - Explicit Message-ID domain, EventSource parsing, and `multipart/alternative` with and without attachments.
- **IMAP integration (Dovecot):**
  - The archive lands in the server's Archive, and the unarchive round-trip leaves no duplicate.
  - A single Sent copy, from the server.
  - The HTML body survives alongside an attachment.
- **JMAP integration (Stalwart):**
  - The archive comes back as a move, and the unarchive round-trip works.
  - Push wakes on a server-side import.
  - Sent dedupe, and the server copy keeps the HTML body.
- **Playwright:**
  - Previews: text, PDF (blob, magic-checked), image thumbnails and full view, and Save. The dialog fits a phone.
  - Composer: blockquoted reply, toolbar bold and lists, `https://` added to links, `javascript:` refused, Escape closes only the link field, Ctrl+Enter sends without a break, Undo restores formatting and focus, and the sent copy renders as HTML. The format bar fits a phone.
  - Every Phase 1 and 1b suite still passes.

## Not yet

- CONDSTORE/QRESYNC for cheaper IMAP flag sync.
- Drafts synced to the server's Drafts mailbox. Drafts live only in the outbox today.
- Inline images pasted into the composer. Attachments only for now.
- Office-document previews. These save and open in their app.
- The PDF viewer's title bar shows the blob id for PDFs without a `/Title`.
