# ADR-0025 · One action grammar: configurable swipes, and one list of keys (Phase 15)

- **Status:** Accepted
- **Date:** 2026-10-15
- **Builds on:** [ADR-0017](0017-mail-power.md) (⌘K and shortcuts), the Phase 1b swipe rows

The [competitive analysis](../research/competitive-analysis.md) §5 principle 4 reads: *keyboard-first on desktop, thumb-first on mobile, one grammar. ⌘K and single-key shortcuts on desktop, configurable swipes on touch, mapped to one shared action vocabulary.* §3 credits **configurable swipe gestures** to Spark and Outlook mobile: one-thumb triage that respects different mental models. Swipes were fixed until now (right toggles read, left archives).

## Decisions

### One vocabulary, three ways in

Mail actions are defined once (`features/mail/vocabulary.ts`): their name, icon, color, what they do, and the key that does the same thing. Swipes, the keyboard, the toolbar, and ⌘K draw on it. Two rules follow:

- **Nothing is gesture-only.** Every action a swipe can do also has a key or a button, so swipes are a shortcut, never the only way in.
- **New: H snoozes until tomorrow** (Superhuman's key), so the snooze swipes have a key too.

### Four swipe slots, short and long

You set four slots: **swipe right**, **swipe right all the way**, **swipe left**, and **swipe left all the way**.

- **Thresholds:** a short swipe commits past a third of the row (as before). Past two thirds the long action takes over, with its own label and color, and a vibration tick at each stage.
- **"Same as a short swipe"** is the long default, so one action per side stays the simple case.
- **"Nothing"** turns a side off: the row doesn't move that way.

The actions are read or unread, archive, star, snooze until tomorrow, snooze until next week, remind me in 3 days if nobody replies, and always in Newsletters. Undo still covers everything that moves mail out of view.

**Defaults are Apple Mail's,** unchanged from before: right toggles read, left archives. Nobody's muscle memory breaks on upgrade.

**The Screener keeps its own swipes** (right lets a sender in, left screens them out). There, the question is about the sender, not the message.

### The mapping lives in the core

Swipes are saved in the core's settings (`swipe_actions`), validated against the action list, and not in browser storage. Change them on the desktop and the phone signed in to the same gateway swipes the same way. That matters because the phone is where you swipe, while the desktop is where you're likely to change settings.

### Shortcuts and gestures, findable three ways

One dialog lists every Mail key and holds the swipe settings. It opens three ways: **?** on a keyboard, **Shortcuts and gestures** in ⌘K, and a row in **Accounts and settings** for phones, which have no ? key. The key list and the dialog come from the same table as the handlers, so they can't drift apart.

## Verification

- **Core (`cargo test -p pim-core`):** defaults, saving, and refusing an unknown action without changing anything.
- **App (`cargo test -p pim-app`):** both commands through the dispatcher, including the camelCase shape and the refusal.
- **Browser, demo (`phase15`, 12 checks):**
  - ? lists the keys, and the defaults are Apple Mail's.
  - H snoozes the selected conversation.
  - ⌘K opens the dialog.
  - On a phone, from Settings: change swipes; a short right swipe stars; a long left swipe snoozes; a short left swipe still archives; the dialog fits the width.
  - All 20 earlier suites still pass, including the original swipe tests.
- **Browser, gateway with real Dovecot (`gateway-p15`):** the desktop saves a mapping to the core, a separately signed-in phone shows it, a right swipe stars real mail, and a long left swipe snoozes it until next week.

## Consequences

- Swipes are per person, not per account or lane. Per-lane mappings (Spark has them) can come later if people ask.
- Keys can't be remapped yet. The list is one table, so remapping is a contained change when needed.
- Long swipes need a wide enough row. On very narrow screens two thirds is still short enough to reach with a thumb.
