# ADR-0022 · Inbox your way: split inboxes and a newsletter bundle (Phase 12)

- **Status:** Accepted
- **Date:** 2026-10-14
- **Builds on:** [ADR-0018](0018-calm-inbox.md) (People / Updates / Newsletters)

The [competitive analysis](../research/competitive-analysis.md) §3 lists two inbox-shaping features this phase takes:

- **Split inbox (user-defined)** from Superhuman: users build their own lanes, so the inbox matches their job.
- **Bundles and grouped newsletters** from Inbox by Google and Gmail tabs: collapsing low-value volume makes the inbox feel smaller.

Phase 8's categories are fixed and come from headers. Splits are the user's own, and the bundle folds one of those categories into a single row.

## Decisions

### A split is a saved rule, not a folder

A split is a name plus a rule, stored in the core's settings (so on the gateway every browser shares them). Mail must match everything filled in:

- **From:** addresses, or a whole domain written `@studio.example`. Any one matches. A domain also takes its subdomains (`ci@build.studio.example`).
- **Subject contains:** words, in any case.
- **Only with attachments.**
- **Account:** one account, or any.

Nothing moves on the server. A split is a view over the Inbox lane, computed as SQL in the core when the list is read (`inbox_clauses`). So it works the same for IMAP, JMAP, Gmail, and Graph, and deleting a split loses nothing.

**Validation speaks plainly:** "give the split a name", "say what goes in it: a sender, a domain, or subject words", and "“studio.example” isn't an address or a domain like @example.com". Addresses are trimmed and lowercased.

### Kept out of All by default

Each split has **Keep out of All**. When it's on, the split's mail leaves the main inbox and shows only in its tab. That's the reason most people make a split, so new splits start with it on. Turned off, a split is a shortcut: its mail shows in both places.

Splits sit as chips after the category chips (All, People, Updates, Newsletters), each with its unread count from `inbox_overview`. Picking a split clears the category, and the reverse. **Edit split** opens the rule; **New split** starts one.

**From the sender menu:** "Make a split for @domain" fills in the sender's domain and a name from it ("Studio"). For mailbox providers (Gmail, Outlook, iCloud, and others) it offers "this sender" instead, since a split for `@gmail.com` would catch everyone.

### Newsletters fold into one row

In All, when two or more newsletter conversations are waiting, they leave the list and show as one **Newsletters** row at the top:

- **The row says** how many are new (or how many there are) and who sent them.
- **Opening it** goes to the Newsletters chip, with every issue listed.
- **Mark all read** and **Archive all** act on the whole bundle, on the server too.
- **A single newsletter stays a normal row.** A bundle of one hides mail without saving any space.
- **Search, a category, or a split turns bundling off,** so a search never hides results inside a row.

### Undo after Archive all keys on Message-ID

Archive all toasts with Undo, like every other action that moves mail out of view. The first version undid by message id, then by thread id. The gateway test against real Dovecot showed that neither survives: once the server files a message in Archive, sync drops the Inbox row and brings the message back as a new row, often in a new conversation.

So `bundle_archive` returns each message's **Message-ID header** (the row id when it has none), and `unarchive_bundle` finds the archived copies wherever they now live. If the server copy hasn't arrived yet, Undo says "those newsletters are still on their way to Archive; try again in a moment" instead of failing silently.

## Verification

- **Core (`cargo test -p pim-core`, 168 tests):**
  - Splits catch mail by sender, domain and subdomain, and subject words.
  - Exclusive splits leave the main inbox; shared ones don't.
  - Unread counts per split.
  - Validation: a name, a rule, and real addresses or domains.
  - The bundle: one newsletter stays a row, and two fold away only when asked.
  - Mark all read; Archive all queues server moves; Undo after the server re-files the messages as new rows; Undo with nothing to find says so.
- **App (`cargo test -p pim-app`):** every command routes; splits through the dispatcher.
- **Browser, demo (`phase12`, 21 checks):**
  - The editor's validation messages.
  - A split by domain opens on save, holds only its mail, counts unread, and leaves All. Turning off Keep out of All brings its mail back.
  - Deleting returns you to All.
  - The sender menu fills in the domain.
  - `?newsletters`: the bundle row, mark all read, opening it to Newsletters, Archive all and Undo.
  - Phone width with no sideways scroll.
  - All 17 earlier suites still pass.
- **Browser, gateway with real Dovecot (`gateway-p12`):**
  1. Mail arrives over IMAP, and two list messages fold into a bundle.
  2. A split for `@clients.example` takes `billing.clients.example` too and leaves All.
  3. Mark all read sets `\Seen` on the server.
  4. Archive all moves both to Archive on the server, and Undo moves them back.
  5. The split survives a reload.
- **Found and fixed while testing:** the Undo identity problem above.

## Consequences

- Splits are views. They don't file mail on the server, so another mail app sees a plain inbox. Server-side rules (Sieve, Gmail filters) are a separate feature.
- Splits apply to the Inbox lane only. Unread, Starred, and the rest show everything.
- The bundle covers newsletters only. Folding Updates the same way is a one-line change, but Updates hold receipts and alerts people do read, so it waits for feedback.
- The ordinary per-conversation Undo after Archive keys on the thread id. With a fast server it may hit the same identity change. Moving it to the same Message-ID key is the follow-up.
