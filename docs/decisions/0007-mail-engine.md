# ADR-0007 · Mail engine (Phase 1)

- **Status:** Accepted
- **Date:** 2026-10-13

## Decision

### Store and network stay separate

- `pim-core::store` is synchronous SQLite. `pim-core::net` is async IMAP and SMTP.
- Network functions take config and return data, and they never touch the store.
- The shell reads a cursor, releases the lock, syncs, then locks again to apply the result. No lock is held across a network call.

### Search uses SQLite FTS5 for now

- We use SQLite FTS5 (bundled with rusqlite), not Tantivy.
- One file, one dependency, and transactional consistency with the messages it indexes.
- We'll revisit Tantivy when mailboxes reach hundreds of thousands of messages or need ranking beyond BM25. This supersedes the "Tantivy" line in [architecture](../architecture.md) for Phase 1.

### Field ownership during sync

- **Server-owned:** content, `\Seen`, and `\Flagged`.
- **Device-owned:** snooze, resurfacing order, and archive state.
- Local changes go into `pending_ops`. They are pushed first on the next sync, and server flags never overwrite a pending local change.
- If the server's UIDVALIDITY changes, the local copy of that mailbox is reset.

### Snooze is local

IMAP has no server-side snooze (`Capabilities::server_side_scheduling = false`), so a 1-second worker wakes snoozed mail. It comes back unread, at the top. It works while the app is running. Cross-device snooze needs JMAP or our own sync (Phase 1b+).

### Undo send is a real outbox

- Send queues the message with `send_at = now + 10s`.
- The worker *claims* due items by flipping them to `sending` first, so Undo can never race an in-flight send. Undo returns the draft to the composer.
- After SMTP, a copy is filed in the server's `\Sent` mailbox (RFC 6154). Gmail and Microsoft are skipped because they file their own copy.

### Archive

Archive moves mail to the server's `\Archive` mailbox if it has one. Otherwise it stays local-only. Archived mail keeps its local copy after it leaves INBOX.

### Secrets

- Passwords live in the OS keychain (`keyring` 3.6), keyed by account id.
- Accounts are verified against IMAP and SMTP before anything is saved.
- Unencrypted connections are refused unless the host is localhost.

### Email HTML is untrusted

- DOMPurify strips scripts and forms.
- The iframe sandbox has no `allow-scripts`.
- A CSP plus attribute rewriting blocks remote images until the reader clicks **Load images**, so tracking pixels never fire by default.

### The web build runs a demo transport

`src/core/demo.ts` follows the same rules in memory. Real accounts need the desktop app until the gateway exists.

## Verified

- **Core:** 23 unit tests covering store lanes, sync edge cases, op collapsing, snooze, the outbox race, search syntax safety, and MIME.
- **Integration:** an end-to-end test against Dovecot and an SMTP sink (`tools/test-mail-servers`), in CI as `mail-integration`.
- **Browser:** Playwright checks of the triage, compose, and undo flows, plus the tracker blocking.

## Not yet (Phase 1b)

- **Sync coverage:** only INBOX syncs. Archive and Sent are written to but not read back. Backfill beyond the newest 500 messages, and CONDSTORE/QRESYNC incremental flags, are still to come.
- **Push:** IMAP IDLE push. Sync currently runs every 2 minutes and after local changes.
- **JMAP:** the JMAP adapter (Fastmail, Stalwart).
- **Mail features:** attachments, threads/conversations, and a rich-text composer.
- **Phone gestures:** swipe actions.
- **Connection testing:** not yet tested against a real TLS provider from CI. The adapters are tested over plaintext localhost only. TLS uses rustls with webpki roots.
