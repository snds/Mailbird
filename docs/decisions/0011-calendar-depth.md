# ADR-0011 · Calendar depth (Phase 2b)

- **Status:** Accepted
- **Date:** 2026-10-14

## Decisions

### Editing part of a series

Every occurrence now carries its **slot**: its `RECURRENCE-ID`, or its start when it hasn't been moved. One-occurrence edits and deletes address the slot, never the displayed time, so a moved occurrence can still be found, changed, or deleted.

| Scope | What we write |
|---|---|
| **This event** | An override `VEVENT` with `RECURRENCE-ID` at the slot. A new override inherits the master's attendees, alarms, and other properties, and gets its own copies of the alarms. Editing it again updates the same override. |
| **This and following** | The old series ends just before the slot: `UNTIL` in UTC, or a date for all-day series, and a `COUNT` becomes an `UNTIL`. Overrides from the slot on are dropped. A new series with its own UID starts at the slot and keeps the attendees, alarms, and rule (a `COUNT` shrinks by the occurrences already past). |
| **All events** | The series master, as in Phase 2, edited from its first occurrence. |

- **Deleting one occurrence** adds an `EXDATE` and removes any override that had moved it.
- **"This and following" from the first occurrence** is just "all events".
- **Limits:**
  - One occurrence can't move to another calendar.
  - It can't change the repeat rule or the guest list; those belong to the series.

Two calcard details matter here:

- **Overrides match their series only when both carry the same `SEQUENCE`.** Apple and Google routinely bump it on the override alone, which would show that occurrence twice. Expansion ignores `SEQUENCE`, and overrides we write keep the master's.
- **`TZID`s resolve through the object's own `VTIMEZONE`s first,** then IANA. Outlook writes names like "Romance Standard Time". Slots we write (`EXDATE`, `RECURRENCE-ID`) use the master's `DTSTART` form, and a TZID that contains spaces is quoted.

### Reminders are VALARMs, and fire from the store

- **What the editor owns:** display and sound alarms relative to the start. The editor offers presets from "at the start" to "1 week before".
- **What stays untouched:** email alarms, absolute-time alarms, and end-relative alarms. The input's `reminders: None` leaves alarms alone; `Some([])` removes the editor's alarms.
- **Indexing (schema v5):** each event's lead times go into `events.alarms`, and stores from before v5 are re-indexed when they upgrade. `due_reminders(after, until)` expands only the events with alarms that could fire in the window.
- **Firing:** the shell checks every 10 seconds and shows an OS notification (`tauri-plugin-notification`, pinned to 2.4.0). It also emits `reminder`, which the UI turns into a toast. The check starts a minute back at launch, so one firing during startup isn't lost, but hours of reminders missed while the app was closed are never replayed.
- **Overrides** use the series' lead times.

### Invitations follow the server's lead

- **Receiving:** invitations arrive as mail with a `text/calendar` part (iMIP, RFC 6047). `MessageDetail.invite` reads it on the fly from the stored raw message. A cheap byte scan skips mail with no calendar part.
- **Answering** sets your `PARTSTAT` on your line only. Matching is case-insensitive, and the organizer's other parameters (`ROLE`, `CUTYPE`, …) are kept.
  - The event is stored without `METHOD`, which CalDAV forbids in stored objects.
  - **Where it lands:** a writable calendar on the message's account by default, or the one you pick.
  - **Older invitations:** one older than your copy (a lower `SEQUENCE`) only changes your answer.
  - **Declining** a new invitation doesn't add it.
- **Cancellations and guest replies** are applied when you choose: "Remove from calendar" and "Update your event".
- **Organizing:** guests can be added in the editor. Saving sets `ORGANIZER` (you, from the calendar's account) and an `ATTENDEE` per guest. New guests get `RSVP=TRUE`, and guests already listed keep their answers. Removing every guest makes it a plain event again.

**Who sends the email** is the one real fork:

- **CalDAV scheduling servers** (RFC 6638, advertising `calendar-auto-schedule` in the `DAV` header: iCloud, Fastmail, Stalwart) send the iTIP messages themselves when an event they hold changes. Sending ours too would double every reply, so we send nothing. The scheduling flag is detected with one `OPTIONS` request per calendar home during discovery.
- **Everything else** gets iMIP from the store, through the outbox with no undo window:
  - a `REPLY` to the organizer when you answer;
  - a `REQUEST` to guests on save;
  - a `CANCEL` to removed guests, and to everyone when you delete an event you organize.
- **On-device calendars** can't send invitations: there's no account to send from.

Outgoing iMIP rides as the last `multipart/alternative` part (`text/calendar; method=…`), which Outlook, Apple Mail, and Gmail read as the invitation.

### Month view

- **Layout:** six weeks with all-day events first. Up to three chips fit per day, with "+N more" opening that day.
- **Times** appear only where a cell has room; the title always wins.
- **Navigation:** a day's number opens it in the day view. `m` is the shortcut.
- **On phones**, the view switch gets its own full-width row, so the four views fit without scrolling sideways.

## Verified

- **Rust:** 92 core tests.
  - Override slots under DST.
  - A bumped `SEQUENCE` not duplicating an occurrence.
  - Override inheritance and re-editing.
  - Deleting a moved occurrence.
  - Series end and split, with `COUNT` carried over.
  - Windows zone names.
  - VALARM read and write, with other alarms kept.
  - Due reminders that fire once, follow the series, and stay quiet for hidden calendars.
  - iTIP read, answer, `REPLY`, `REQUEST`, `CANCEL`, and guest lists.
  - The store: accepting, declining, scheduling servers, cancellations, and the organizer flow.
- **Integration:**
  - **CalDAV (Stalwart):** a moved occurrence and a series split round-trip between two devices.
  - **SMTP:** an iMIP `REPLY` arrives with its `text/calendar` part.
  - The IMAP and JMAP integration tests still pass.
- **Playwright** (23 new checks):
  - Answering an invitation, and changing the answer.
  - The accepted event in the calendar.
  - Month view, and opening a day from it.
  - This-event-only and this-and-following edits.
  - Delete this-and-following.
  - Reminder chips, guests with autocomplete and the "who sends invitations" note.
  - A reminder toast firing live.
  - The phone month layout.
  - All earlier suites pass. A composer focus race after Undo, seen about once in six runs, is fixed: 10 of 10 runs pass.

## Not yet

- Free/busy and finding a time.
- Proposing a new time (`COUNTER`), and delegating.
- Answering a single occurrence of a recurring invitation.
- Snoozing reminders, and catching up on reminders missed while the app was closed.
- Guest lists on single-occurrence overrides.
