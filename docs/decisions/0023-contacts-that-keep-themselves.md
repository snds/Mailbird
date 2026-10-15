# ADR-0023 · Contacts that look after themselves: smart groups, restore to a point in time, and conversations that survive a server move (Phase 13)

- **Status:** Accepted
- **Date:** 2026-10-15
- **Builds on:** [ADR-0020](0020-contacts-depth.md) (labels, Recently deleted), [ADR-0022](0022-inbox-your-way.md) (bundle Undo)

The [competitive analysis](../research/competitive-analysis.md) §3 lists two contact rows this phase takes:

- **Smart groups (rule-based)** from Apple Contacts: lists maintain themselves.
- **Restore to a point in time** from Google Contacts: a safety net for bulk edits and sync accidents.

Phase 12 also left a follow-up: the ordinary Undo after Archive could lose its conversation once the server moved the message. That's fixed here at the root.

## Decisions

### Smart groups are saved rules over your cards

A smart group is a name plus a rule, stored in the core's settings (shared by every browser on the gateway). A card must match everything filled in:

- **Has any of these labels** (from ADR-0020).
- **Company contains** words, in any case.
- **Email at** a domain, which also takes its subdomains.
- **Has a phone number**, **Has a birthday**.
- **In touch in the last N days:** mail from them, or mail you sent to them (To or Cc).

Membership is computed when the list is read (`contacts_in`), so people join and leave by themselves as their cards and mail change. Deleting a group changes nobody. Groups sit as chips under the labels, each with a count; picking one narrows the list, and search works inside it.

**Why rules and not a stored list:** a stored list is a label, and labels already exist. The value of a smart group is that nobody maintains it.

**Validation speaks plainly:** "give the group a name", "say who belongs in it: a label, a company, a domain, or one of the checks", and "“studio” isn't a domain like example.com".

### Restore to a point in time keeps a history of every card

Schema v11 adds `contacts_history`. **SQLite triggers** on the contacts table record each change as the card before and after. Triggers rather than calls in each write path, because contacts change in many places: edits, merges, deletes, restores from Recently deleted, and DAV sync. A trigger can't be forgotten by a future write path. History is kept 30 days.

**Restore contacts** (the history button in Contacts) picks a point: 10 minutes, an hour, yesterday, a week, or 30 days ago. It previews by name before it changes anything:

- **Puts back** cards edited since, as they were.
- **Brings back** cards deleted since, with their UID, so note links find them again. Their Recently deleted copies go.
- **Removes** cards added since. They go to Recently deleted, so nothing is lost.
- **Leaves alone** read-only address books, and says how many changes that was.

Changes that came from a sync count too: a server that lost cards is the "sync accident" the feature exists for. The restore pushes its result to the server like any edit.

**A restore can be undone.** It's recorded like any other change, and it returns a mark (the last history row before it). Undo restores to that mark.

### Conversations survive a server move

Phase 12 found that once the server files a message in Archive, sync drops the Inbox row and the Archive pass brings the message back as a new row. For a one-message conversation that meant a new conversation id, so anything keyed by conversation (Undo, snoozes, reminders, the open thread) lost track of it.

A trigger on message deletes now remembers each row's conversation by Message-ID (`thread_memory`, kept 7 days). When the copy comes back, it rejoins that conversation, which wins over threading by references. The ordinary Undo after Archive now works after the move, tested against real Dovecot. The bundle's Message-ID Undo from ADR-0022 stays, since it's already robust.

## Verification

- **Core (`cargo test -p pim-core`, 173 tests):**
  - Smart groups: by domain with subdomains, company words, labels (any), phone and birthday together, membership following new cards, search inside a group, delete.
  - In touch: mail received and mail you sent count; old mail doesn't.
  - Validation: a name, a rule, a real domain, and an unknown id.
  - Restore: an edit, a delete, and an add in the last hour, previewed by name, then restored, with Recently deleted updated and the UID kept. Undo by mark. Nothing to do is nothing.
  - Restore covers a card removed by sync, and skips (and counts) read-only books.
  - Thread memory: the Archive copy rejoins its conversation, and Undo by conversation works after the move.
- **App (`cargo test -p pim-app`):** every command routes; smart groups and restore with Undo through the dispatcher.
- **Browser, demo (`phase13`, 16 checks):** validation, a domain group with its count, labels plus a phone check, in touch, edit and delete; restore after a delete and an add (preview, restore, Undo); phone width. All 18 earlier suites still pass.
- **Browser, gateway with real Dovecot (`gateway-p13`):**
  1. Archive moves a message on the server, the server's copy comes back in the same conversation, and Undo by conversation moves it back to the Inbox.
  2. An "in touch" group reads the real mail store.
  3. Restore removes the cards added since, and Undo brings them back without leaving stale copies in Recently deleted.
  4. The group survives a reload.
  - `gateway-p12` still passes.

## Consequences

- Smart groups are views here. CardDAV has no rule-based groups, so other apps don't see them. Labels are what syncs.
- History grows with sync churn. It's bounded at 30 days; a server that rewrites every card on each sync would make it large, which is worth watching on real servers.
- Restore goes back at most 30 days, and its choices are presets. A custom date can come later.
