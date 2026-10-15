# ADR-0032 · Your keys: remappable single-key shortcuts (Phase 22)

- **Status:** Accepted
- **Date:** 2026-10-15
- **Builds on:** [ADR-0025](0025-one-action-grammar.md) (one action grammar), [ADR-0017](0017-mail-power.md) (⌘K and shortcuts)

ADR-0025 left one gap open: *keys can't be remapped yet. The list is one table, so remapping is a contained change when needed.* The [competitive analysis](../research/competitive-analysis.md) §5 principle 4 asks for one grammar, keyboard-first on desktop. People arrive with Gmail, Superhuman, or Outlook habits, and a fixed key set makes everyone except one group relearn. The swipe-only actions also had no key, so on a desktop they were only reachable by mouse.

## Decisions

### One command table, in the core and the web

Every single-key command is a row in `KEY_COMMANDS`: an id (`mail.archive`, `calendar.week`), its area, and its default key. The core keeps the same list. Three things read the web table, so they can't drift apart:

- the key handlers in Mail and Calendar;
- the list in **Shortcuts and gestures**;
- the hints elsewhere (⌘K's **New message**, and `aria-keyshortcuts` on Calendar's Today and view buttons, so screen readers announce your key, not the default).

The defaults are the ones the app already had. Nobody's habits break on upgrade.

### Swipe-only actions can have keys now

**Snooze until next week**, **Remind me in 3 days if nobody replies**, and **Always in Newsletters** were swipes with no key. They now appear in the list with **Add key**. They start without one, because there's no widely shared default, and giving them a key by default could clash with a habit someone brought from another app.

### Changing a key: press the key, then the new one

Each row's key is a button. Press it, and it reads **Press a key…**; the next key you press becomes the shortcut.

- **A taken key swaps.** If another command in the same area has the key, that command takes your old one. A toast names both changes, for example: *X now does "Star or unstar". "Archive, or back to the inbox" moved to S.* Nothing loses its key without you being told.
- **Shift counts.** Shift+R is a different key from R. It's shown as ⇧R.
- **Refused, with the reason in place:** a key held with ⌘, Ctrl, or Alt (those belong to the browser and the system), Space and Enter (they press buttons), and ? (it opens this list). **Tab** moves on, as it always does, and cancels the change.
- **Esc cancels** the change and keeps the dialog open. **Remove key** appears while choosing, so each row is one control wide and fits a phone.
- **Reset keys** brings the defaults back. It's disabled while nothing differs.

### Two areas: Mail and Calendar

A key must be unique within its area, not across the app. **E** can archive in Mail and mean something else in Calendar, because only one of them is listening at a time. Calendar's keys (Today, Day, Week, Month, Agenda, previous, next) were previously undocumented; they're now listed and changeable too. **?** now opens the list from Calendar as well.

### What stays fixed

**Esc** (close the conversation), **?** (this list), and **⌘K** don't change. They're the way out and the way to help, so they stay where people expect them, and they're listed as fixed.

### The keys live in the core

Like swipes, keys are saved in the core's settings (`key_bindings`). Your keys follow you to every browser on the gateway and every device shell. The core enforces the same rules as the dialog: known commands, valid keys, and one key per command in each area. A refused change changes nothing.

The core stores **only the keys that differ** from the defaults. If a later version adds a command, it gets its default key, unless you already use that key in its area. In that case the new command starts with no key, so your choice wins.

## Verification

- **Core (`cargo test -p pim-core`):** defaults, a swap, Shift keys, the same key in two areas, each refusal leaving things unchanged, reset, only the differences being stored, and a new default yielding to a key you chose.
- **App (`cargo test -p pim-app`):** both commands through the dispatcher, including a clash and a reset.
- **Browser, demo (`phase22`, 20 checks):**
  - the list, with Calendar's keys;
  - a new key, a swap, refusing ? and Ctrl, Esc cancelling, Shift+R, and Remove key;
  - the new keys work and the old one doesn't, and ⇧R sets a reminder;
  - ⌘K shows the key;
  - in Calendar, ? opens the list, and a changed key switches the view and is announced;
  - Reset keys, and the list fits a phone.

  All earlier demo suites still pass. `phase15` reads the Mail section by its new name.
- **Browser, gateway (`gateway-p22`):**
  - the desktop changes a key, and a separately signed-in tablet shows it;
  - the gateway refuses a clash and an unknown command;
  - a reset on the tablet reaches the desktop.

## Consequences

- Keys are per person, not per account or per device. A laptop and a desktop keyboard share a mapping, which matches how people carry habits.
- Only single keys can be remapped. Sequences (Gmail's **g i** to go to the inbox) and modifier shortcuts are out of scope. The table could take them later if people ask.
- Presets (a "Gmail" or "Superhuman" set) aren't offered. The defaults are already Gmail and Superhuman's for the shared commands, so a preset would change only a key or two.
- Contacts and Notes have no single-key commands yet. When they get some, they become new areas in the same table.
