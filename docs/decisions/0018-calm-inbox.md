# ADR-0018 · A calmer inbox: the Screener, People/Updates/Newsletters, and blocking (Phase 8)

- **Status:** Accepted
- **Date:** 2026-10-14
- **Builds on:** [ADR-0007](0007-mail-engine.md) (store and ops), [ADR-0016](0016-web-gateway.md) (one command layer), [ADR-0017](0017-mail-power.md)

The [competitive analysis](../research/competitive-analysis.md) lists these as the strongest ways to cut overload:

- HEY's **Screener**, which removes spam anxiety.
- Spark's **smart inbox**, sorted by sender type.
- One-tap **block**.

All three decide by sender, so they share one model: a sender is an address you can decide about once.

## Decisions

### Senders, across accounts

Schema version 8 adds a `senders` table: lowercased address, `decision` (`allowed`, `screened_out`, or `blocked`), and an optional `category` override. A person is one sender whichever of your accounts they write to. Deciding once is the point.

- **Known senders,** who skip the Screener:
  - **Anyone you've written to.** Recipients are stored as `allowed` when your mail is stored: sent from this device, or synced from Sent. That doesn't override an earlier decision, so writing to someone you blocked doesn't unblock them.
  - **Anyone in your contacts.** This is checked at query time against the contacts' emails, so a new contact counts at once.
  - **Anyone you let in.**
- **`senders()`** lists screened-out and blocked senders, plus those you moved to a category, so every choice can be undone from Accounts. It leaves out the many senders allowed only because you wrote to them.

### The Screener: off by default, and only for new mail

When it's on, mail from a sender who isn't known waits in a **Screener** tab instead of the inbox.

- It applies only to mail that arrived after you turned it on (the `screener_since` setting).
- It isn't unread mail either, so phones don't notify about it: background notifications come from the Unread lane.
- **Let in** allows the sender, and their waiting mail joins the inbox. **Screen out** archives it.
- **Off by default:** turning it on silently would hide new people's mail from someone who never asked. Turning it on remembers everyone you've already written to, so on day one it only catches people who are truly new.
- **On the phone,** you can swipe in the Screener: right lets the sender in, left screens them out.

### Screening out and blocking act on the server

A screened-out sender's mail is **archived**, now and as it arrives:

- It's queued as a normal archive op, so the server's Archive holds it.
- Your other mail apps (the phone's built-in one, webmail) agree.
- **Blocking** also marks it read.
- Neither deletes anything: the mail is in Archive and in search.

This is enforced in `insert_message` for every account type. Before this, ops were pushed at the start of a sync pass, so an op created by an arriving message reached the server one pass later, up to 30 seconds. Now a pass that creates ops schedules a quick second pass. It counts ops before and after storing, so an op the server keeps refusing can't cause a loop.

### People, Updates, Newsletters

Each received message gets a `category` from its headers alone (`triage::classify`). The body is never read.

| Category | Signals |
|---|---|
| **Updates** | `Auto-Submitted` other than `no` (RFC 3834); `Precedence: junk`; a machine sender such as `no-reply`, `notifications`, `receipts`, `billing`, `alerts`, or `mailer-daemon`, including `noreply+tag@` |
| **Newsletters** | `List-Id` or `List-Unsubscribe` (RFC 2919, RFC 2369); `Precedence: bulk` or `list` |
| **People** | Everything else |

- **Updates are checked first,** because notification services add list headers too (GitHub does).
- **Moving a sender** ("Always in Updates" in the sender menu) overrides the headers for all their mail. Undo, or Reset in Accounts, goes back to the headers.
- **Mail stored before version 8** is classified when the store upgrades.
- **The inbox shows chips:** All, People, Updates, Newsletters. All stays the default, so nothing hides unless you ask.

### Why headers, and not a model

A header classifier runs on every device, offline, in microseconds. It's explainable: we can say why a message landed where it did, and moving the sender fixes it.

Learned classifiers (Gmail's tabs) do better on edge cases, but they need training data we won't collect and a model we'd have to ship to every shell. If one comes later, it fits behind `classify` and the sender override still wins.

## Verification

- **Core (`cargo test -p pim-core`, 141 tests):**
  - Classification across 11 header cases.
  - Categories with sender overrides and undo.
  - The Screener: old mail stays put; contacts and people you wrote to skip it; strangers wait outside Inbox and Unread; the waiting count; Let in; turning it off.
  - Screen out and block now and on arrival, with the server ops checked: archive for both, plus seen for blocked.
  - The senders list and undoing a decision; reclassifying on upgrade.
- **App (`cargo test -p pim-app`):** every command by its UI name, the Screener lane with a category filter, and bad arguments refused.
- **Browser, demo (`phase8`):**
  - The chips, moving a sender and Undo, and screening out (mail in Archive, the decision listed in Accounts, Let in again).
  - The Screener switch adding its tab, a stranger waiting with a count, Let in, and swipe-to-screen-out on a phone.
  - All 14 earlier suites still pass.
- **Browser, gateway with real Dovecot:**
  1. A `List-Id` message lands in Newsletters.
  2. With the Screener on, a new sender waits.
  3. Screen out moves their mail to Archive on the IMAP server.
  4. Their next message is archived on arrival, on the server too, and never shows in the inbox.
  5. No page errors.
- **Found and fixed while testing:**
  - Radio items in the sender menu left the menu open.
  - Undo of a category move pinned the sender to their old category instead of clearing it.
  - Screening out left the reader open on a conversation that had moved.
  - Rule-created ops waited a full sync pass.
  - The ⌘K menu could drop keystrokes typed right after opening (Phase 7, now fixed).

## Consequences

- Screener decisions and categories live in the local store. On a gateway they're shared by every browser; between the desktop app and a phone they're separate until sender data syncs (a follow-up).
- A message stays in its category's chip when you reply to it. The chips filter by the message the row shows, not by thread.
