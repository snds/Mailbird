# ADR-0055 · Power settings (Phase 43)

- **Status:** Accepted
- **Date:** 2026-10-17
- **Builds on:** [ADR-0017](0017-mail-power.md) (the composer and its menus), [ADR-0025](0025-one-action-grammar.md) (Mark read as a verb)

FairEmail earns its loyal users with depth: the choices most people never touch, there for the ones who care. Mailbird had none of them. This phase adds the ones that change how mail behaves for you, behind one Advanced screen, without crowding the main settings.

## Decisions

### One Advanced screen, private defaults

**Accounts and settings** gets a row, **Advanced mail settings**, next to Signatures and Shortcuts. It opens one dialog:

| Setting | Choices | Default | Why that default |
|---|---|---|---|
| Remote images | Ask · From contacts · Always | **Ask** | Images can tell a sender you opened their mail, and when |
| Mark as read | On open · After 3 s · Manually | **On open** | What most mail apps do; the others are for people who triage by glancing |
| Include the message you're replying to | on / off | **on** | Most mail is replied to with the quote |
| Write below the quote | on / off | **off** | Top-posting is what most people expect; mailing lists prefer below |
| Ask for a read receipt on everything I send | on / off | **off** | Receipts are a small intrusion on the other person |
| Check for new mail | 2, 5, 15, 30 minutes, or an hour | **2 minutes** | What it was before |

- **Three-way choices are a row of options** (a toggle group). The line under them says what the chosen one means, so the trade-off is read where it's made ("Images can tell a sender you opened their mail").
- **Write below the quote turns off when there's no quote,** because it has nothing to be below.
- **The settings live in the core** (`MailPrefs`, saved as one setting). Older saved settings fill in the defaults for anything new, and an interval Settings doesn't offer snaps to the nearest one.

### What each one does

- **Remote images:**
  - **Ask** keeps today's behavior: blocked, a banner, and Load images.
  - **Always** loads them with no banner.
  - **From contacts** loads them when the sender is one of your contacts (the same lookup the sender profile uses) and asks for everyone else.
  - While the setting is still loading, images stay blocked, so a slow start never leaks a pixel.
- **Mark as read:**
  - **After 3 s:** it's marked read only if the conversation is still open 3 seconds later. Moving on sooner leaves it unread.
  - **Manually:** opening never marks it read; Mark read (its button, swipe, or shortcut) does.
- **Replies:**
  - **Without the quote**, the reply starts empty, with the signature as usual.
  - **Below the quote**, the cursor starts after the quote, and the signature goes under your reply instead of above the quote.
- **Read receipts:**
  - Asking for one adds `Disposition-Notification-To` with your address (RFC 8098) to the message, for every kind of account. Whether a receipt comes back is up to the other person's app.
  - **Per message,** the composer's menu (the templates button) has **Ask for a read receipt**. It starts from the setting, and you can change it for this message.
  - **Mailbird never sends receipts** for mail you read. Asking is your choice; answering would give the sender information about you without asking. The setting's own text says so.
- **Checking for new mail:** for accounts without push, Mailbird checks on the chosen interval. It looks at the setting every 30 seconds, so a shorter interval takes effect without waiting out the old one. Push (IMAP IDLE, the relay) is untouched.

### Also in this phase: the identity's device name

The desktop now names its identity device **"Mailbird on <computer name>"** (with `.local` and `.lan` dropped), not just "Mailbird". Each app on a computer is its own device in the shared identity, a decision agreed with Lockdown (which names its own "Lockdown on …"). Without the computer's name, a person with two laptops would see two identical "Mailbird" devices.

## Verification

- **Core** (`cargo test -p pim-core`, 227 tests):
  - the defaults;
  - a round trip of every field;
  - intervals snapping to the nearest offered one;
  - older saved settings filling in defaults;
  - the receipt header present only when asked for, with the sender's address.
- **App:**
  - through the dispatcher: the defaults, a save, and snapping;
  - the device name from the computer name (`.local` dropped; a blank or missing name gives "Mailbird").
- **Clippy** is clean on the core, app, gateway, relay, and shell. The mail integration tests compile with the new draft field.
- **Browser** (`phase43`, 25 checks):
  - **The dialog:** its defaults and their explanations.
  - **Images:** a newsletter's pixel isn't fetched; From contacts still asks for a non-contact; Always fetches it with no banner.
  - **Mark as read:** Manually leaves a conversation unread; After 3 s is still unread at 1 s and read after 3.
  - **Replies:** you write above the quote by default; Write below is disabled without a quote; the quote can be left out; below the quote, typing lands after it.
  - **Read receipts:** off for a new message, the composer can turn one on, and the setting turns it on for every message.
  - **Check for new mail:** the interval is kept.
  - **Also:** the dialog fits a phone, and there are no console errors (apart from the pixel that Always loads on purpose, which can't reach the network here).
- **Regression:** all earlier browser suites pass. `tsc -b`, `oxlint`, and `vite build` are clean.
- **Ratchet:** the three settings rows now share one `SettingsRow`, so the count went down: `className` overrides 241 → 240. The baseline is lowered to match.

## Consequences

- **Answering read receipts is left out on purpose.** If people ask for it, it becomes a per-message "Send receipt" prompt, never automatic.
- **Not here yet:**
  - a sync window ("only the last 90 days on this device"), which needs date-bounded backfill in all four mail protocols;
  - per-account intervals.
  Both fit this screen when they come.
- **"From contacts" covers contacts only.** People you've written to but never saved are still asked about. The Screener's "known sender" notion could widen it later.
