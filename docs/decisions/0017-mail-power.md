# ADR-0017 · Send later, follow-ups, unsubscribe, signatures and templates, ⌘K (Phase 7)

- **Status:** Accepted
- **Date:** 2026-10-14
- **Builds on:** [ADR-0007](0007-mail-engine.md) (outbox and undo send), [ADR-0008](0008-mail-depth.md) (threading), [ADR-0016](0016-web-gateway.md) (one command layer)

The [competitive analysis](../research/competitive-analysis.md) lists the features that make mail feel fast and calm. After Phase 6, these were still missing:

- Send later (Gmail, Outlook).
- Follow-up reminders (Superhuman, Gmail Nudges).
- One-tap unsubscribe (Gmail, Apple Mail).
- Templates (Superhuman, Spark).
- A command palette with keyboard access to everything (Superhuman).

Each works the same on every account type, so all of them live in the core and the shared command layer. None of them depends on a provider feature.

## Decisions

### Send later is the outbox with a later time

Undo send already holds each message in the outbox until its undo window closes ([ADR-0007](0007-mail-engine.md)). A scheduled message is the same row with a later `send_at`.

- **`queue_send` takes an optional `send_at`.** It must be at least a minute out and at most a year.
- **`reschedule_send` moves a waiting message,** or sends it now. **`cancel_send` hands back the draft,** so Edit reopens the composer with its time.
- **Why not provider-side scheduling:** Gmail and Outlook can schedule on the server, but IMAP, JMAP, and iCloud can't. One mechanism for every account keeps the behavior identical.
- **The tradeoff:** the desktop app sends only while it runs. A message due while the app is closed goes out the next time it opens. The send-later dialog says so. A gateway runs all the time ([ADR-0016](0016-web-gateway.md)), so it sends on time. That's a reason to run one.

### Follow-ups are keyed by Message-ID and cleared by replies

"Remind me if no reply" applies to a message you sent.

- **Storage:** a `follow_ups` row holds the account, the sent message's `Message-ID`, and the due time.
  - It's keyed by Message-ID, not by row, because the local Sent copy is replaced when the server's copy arrives.
  - A store test covers the reminder surviving that swap.
- **A reply clears it.** Any received message whose `In-Reply-To` or `References` names that Message-ID deletes the reminder as it's stored. A reply that arrives in any sync, on any account type, counts.
- **Until it's due,** the conversation sits in a new **Waiting** lane.
- **Once it's due,** the conversation comes back to the inbox:
  - It's sorted at the time the reminder came due.
  - It's badged "No reply yet", with a banner offering "Remind me again" or "Done".
  - Your mail stays where it was: the inbox lane includes sent rows with a due reminder.
- **Archiving dismisses a due reminder,** so Done is an archive. Archiving while still waiting keeps the reminder, because "reply, archive, get nudged later" is the point.
- **Two ways to set one:** in the composer as a delay after sending (1 day, 3 days, 1 week), or on a conversation you've already sent in, as a time.
- **Notifications:** the worker posts "No reply yet" for each reminder that comes due while the app runs. Ones that came due while it was closed just show in the inbox.
- **Known limit:** reply detection depends on the recipient's client keeping `In-Reply-To` or `References`. Every mainstream client does. A reply written as a new message doesn't clear the reminder, and you'll see it come back.

### Unsubscribe: the quietest method the sender offers

`List-Unsubscribe` (RFC 2369) is read from the stored raw message when the message opens. No schema change is needed. The **Unsubscribe** button appears only when the sender offers a way, and its dialog says which way before acting.

1. **One-click (RFC 8058),** when the message also has `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. This is a single POST: no cookies, no redirects followed, a 15-second timeout, and https only.
   - **Address checks:** IP literals for loopback, private, link-local, and carrier-grade-NAT ranges are refused. So are `localhost`, `.local`, `.internal`, and names with no dot.
   - **Why:** the address comes from whoever sent the mail. A gateway on a home network must not become a way to reach the router.
   - **If one-click fails,** the next method is tried.
2. **Mail:** a message to the `mailto:` address, with its subject and body if given, sent from the account the mail came to, through the normal outbox.
3. **Web:** the page opens in the browser. On a gateway, it opens through the `open-url` event.

Afterwards, a toast offers to archive the conversation. Nothing is unsubscribed without a click.

### Signatures and templates live in the core

- **Signatures:** one per account, stored as HTML.
  - New messages, replies, and forwards add the signature under the first line, so a reply keeps it above the quote.
  - It goes in after the standard `-- ` delimiter.
  - Changing From swaps it.
  - It's normalized through the editor's own schema (`generateHTML(generateJSON(…))`), so it can be found in the editor's HTML and replaced exactly.
- **Templates** have a name, an optional subject (it fills an empty subject), and HTML.
  - Insert one from the composer's Templates menu.
  - Save the current message as one (the signature is left out).
  - Manage them under **Signatures and templates** (from Accounts, the composer, or ⌘K).
- **Why the core, not browser storage:** they're part of your setup. They move with the gateway's data and the desktop's database, and every shell sees the same ones. A `compose:changed` event keeps open windows current.

### ⌘K command menu

Ctrl+K or ⌘K opens a menu built on shadcn's Command component (cmdk) from anywhere except inside the composer.

- **What it lists:** every create action, every mail lane (including Waiting and Scheduled), the other apps, Accounts, Signatures and templates, and the light or dark switch.
- **Search:** typing also offers "Search mail for …". Its value never matches the typed text, so any command that does match ranks above it, and Enter runs that command.
- **Mail tab and search moved into the UI store** so the menu can set them. They reset when you leave Mail, as they did before.

## Verification

- **Core (`cargo test -p pim-core`, 136 tests):**
  - Follow-ups: waiting, due, archive dismisses, reply clears, surviving the Sent-copy swap, conversation reminders, time limits, the due window for notifications.
  - Scheduled sends and their limits; follow-up delay limits.
  - Templates and signatures.
  - Unsubscribe header parsing: folding, header block only, https-only one-click, `mailto` decoding.
  - The one-click address check, with 14 refused addresses.
- **App (`cargo test -p pim-app`):** unsubscribe by mail queues a message to the list's address with its subject, and by web opens the page. Also send later, reschedule, the follow-up error, and template and signature commands with their events.
- **Browser, demo (Playwright, `phase7`):**
  - The Waiting lane, cancelling and setting reminders, and a due reminder joining the inbox at the right place.
  - Done dismisses a reminder.
  - Template insert, the follow-up chip, send later, the Scheduled tab, Edit keeping its time and reminder, and Send now.
  - Signatures added, swapped on From change, and placed above a reply's quote.
  - One-click unsubscribe; ⌘K for lanes, search, and dark mode; the phone composer footer fitting at 390 px.
  - All 13 earlier suites pass.
- **Browser, gateway with real Dovecot and SMTP:**
  1. Unsubscribe by mail reaches SMTP with the list's subject.
  2. A message sent with a reminder carries the signature and waits.
  3. A reply appended over IMAP clears the reminder.
  4. A scheduled message survives a reload unsent, then goes out on Send now.
- **Two bugs found and fixed:**
  - The composer's first-second focus guard closed any menu or dialog opened from it in that second.
  - React submit events crossing portals would have let the send-later dialog's Schedule button send the composer. Both new dialogs stop propagation.

## Consequences

- Schema version 7 adds `follow_ups`, `signatures`, and `templates`.
- On the desktop, scheduled mail depends on the app running. Running a gateway gives on-time delivery.
- `cmdk` (MIT) joins the web dependencies, with four small Radix packages it uses internally.
