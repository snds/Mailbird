# ADR-0039 · Note reminders (Phase 29)

- **Status:** Accepted
- **Date:** 2026-10-15
- **Builds on:** [ADR-0011](0011-calendar-depth.md) (event reminders and notifications), [ADR-0019](0019-connected-calendar.md) (reminders missed while closed), [ADR-0038](0038-note-cards.md) (the note record and cards)

The [competitive analysis](../research/competitive-analysis.md) §3 credits **location and time reminders** to Google Keep: a note comes back when it matters, instead of waiting to be found. This phase adds the time half.

## Decisions

### One reminder engine for events and notes

- **A note's reminder is a time on its record** (`remind_at`, schema version 14). It syncs with the record, like pinned and color, so every device knows about it.
- **It fires from the same loop as event reminders.** The core's `due_reminders` returns note reminders alongside event alarms. A note reminder carries a `note_id` and has no event. That one change gives note reminders three things events already had:
  - the OS notification on desktop,
  - the in-app reminder event (web and gateway),
  - the "missed while closed" catch-up at launch.
- **Missed note reminders are always shown**, however long ago they came due. A missed event reminder is dropped once the event has long started; a note doesn't go stale that way. The catch-up still looks back a week at most.
- **Archived and deleted notes stay quiet.**

### It stays until you're done with it

- **After it fires, the reminder stays set**, and the note shows as **due**.
- **Due notes rise to the top** of Notes, in a **Due** section above Pinned. This is what "resurfaces when relevant" means here. A notification is easy to dismiss and forget; the list keeps showing the note.
- **Done** on the note's chip puts it away. **Remove reminder** in the menu clears one that hasn't fired yet.

### Setting one

- **The bell in the note's toolbar** offers the snooze presets: Later today, Tomorrow, This weekend, and Next week. Each shows its exact time, so "Tomorrow" is never vague, the same rule as mail snooze.
- **Pick a date and time…** opens the send-later time picker.
- **The time is spelled out wherever the note appears:**
  - on the note's chip,
  - on the bell button ("Reminder: Today, 12:00 PM"),
  - on its row,
  - on its card.
- **When it fires, the toast says "From your notes"** and offers **Open**, which jumps to the note from anywhere in the app.

### Location reminders wait for the device spike

Keep's other half is reminding at a place. That needs the phone's geofencing, which the web and desktop shells can't do. It belongs with the mobile device spike (ADR-0002, `docs/mobile-spike.md`), not here.

## Verification

- **Core:** a reminder is set, survives other changes, and fires once in the reminder window. It stays set after firing. A missed one is kept however long ago it was due. Archived notes stay quiet; `0` clears; the record syncs both ways. The schema migrates to version 14.
- **Dispatcher:** `set_note_meta` with `remindAt`, and `0` to clear.
- **Browser, demo (`phase29`, 15 checks, on a fake clock run forward three hours):**
  - presets show exact times; setting one confirms when;
  - the chip, the button, and the row show the time;
  - from Mail, the reminder appears when due, and **Open** jumps to the note, marked due;
  - the Due section sits above Pinned; **Done** clears it;
  - any date and time can be picked, and **Remove reminder** clears it;
  - cards show the reminder; the toolbar fits a phone;
  - no console errors.

  All earlier demo suites still pass.

## Consequences

- **One reminder per note, and no repeats.** Keep allows a daily or weekly reminder. A repeat rule could reuse the calendar's recurrence later.
- **Every open device notifies.** Event reminders already behave this way. "Done" on one device clears the reminder on the others through sync.
