# ADR-0019 · A connected calendar: Join, birthdays, contact history, a second time zone, and missed reminders (Phase 9)

- **Status:** Accepted
- **Date:** 2026-10-14
- **Builds on:** [ADR-0010](0010-calendar-contacts.md) (calendars and contacts), [ADR-0011](0011-calendar-depth.md) (reminders), [ADR-0016](0016-web-gateway.md) (one command layer)

The [competitive analysis](../research/competitive-analysis.md) credits the calendar apps people love (Fantastical, Notion Calendar, Cardhop) with joining the three verticals. A meeting is one tap from its call. A person's card shows what you have going on with them. Nothing that came due while the app was closed goes unseen. Mail, calendar, and contacts live in one store here, so these joins are queries, not integrations.

## Decisions

### Join: a meeting link is found, never typed

`meeting::meeting_link` picks the first video-call link out of an event's text.

- **Known hosts only:** Zoom, Google Meet, Microsoft Teams, Webex, Jitsi, Whereby, and FaceTime. Each needs a meeting path (Zoom's `/j/`, Teams' `/l/meetup-join/` …), so a pricing page, a settings link, or a look-alike host (`evil-zoom.us`) doesn't count.
- **https only.** Trailing punctuation from prose ("Join: https://meet.google.com/abc.") is dropped.
- **Where it looks:**
  - Lists (agenda, week, contact cards) read the **location** only. That keeps expanding hundreds of occurrences cheap.
  - The event view also reads the **URL** and the **description**, where invitations usually put the link among dial-in help and maps.
- **Join is a real link** (`<a target="_blank">`) styled as a button, not a button that opens a URL. It opens, copies, and reads as a link, and the service's app can claim it. In the agenda it sits beside the row, because a link can't go inside the row's button.
- **A bare meeting link as the location reads as its service** ("Google Meet"), not a long URL.

### Birthdays: a read-only calendar made from contacts

Schema version 9 adds `contacts.birthday` (the vCard `BDAY`, kept as text) and a fixed **Birthdays** collection (`id = 'birthdays'`, not writable, listed last).

- **Occurrences are computed** from contacts when a range is asked for, not stored as events. Editing a contact moves its birthday at once, and there is nothing to sync or clean up.
- **The title** is "Ana turns 34" when the year is known, and "Ana's birthday" without one.
- **Year-less birthdays** (`--07-02`) are valid vCard 4. The vCard library writes them but can't read them back, so a fallback reads the `BDAY` line itself (a bug that predated this phase).
- **A birthday opens the contact,** not an event view (`Occurrence.contactId`). Hiding the calendar hides them all.
- **Existing stores are backfilled** from their stored vCards on upgrade.

### Contact history: one query across mail and calendar

`contact_activity(id)` returns, for a contact's addresses:

- **Threads:** the newest message of the 5 most recent conversations where they're the sender or a recipient (To or Cc).
- **Meetings:** events naming them as attendee or organizer (`mailto:` in the iCalendar), expanded a year either side of now: the next 3 and the last 3.

The card shows Upcoming (with Join), Recent mail, and Met recently. Each item opens where it lives. It replaces the earlier "Recent mail", which searched the inbox for the first address and matched senders only. The query refreshes on mail and calendar changes.

### A second time zone, per viewer

The week and day views can show a second column of hours for another zone. It's for whoever is looking, not the account, so it's stored in this browser (`localStorage`, guarded: blocked storage keeps it for the session) rather than in the store.

- Half-hour zones show minutes ("10:30 PM"); the column is wider when shown.
- The header names both zones ("GMT+5:30", "UTC") and the column is labeled by city for screen readers.
- The picker is a native select grouped by region: on phones it's the system picker. Zone names come from the browser (`Intl.supportedValuesOf`), so Chromium lists India as "Calcutta".

### Missed reminders: caught up once, at launch

The reminder worker remembers how far it has checked (`reminders_checked`): about once a minute, and right after a reminder fires, so quitting straight after doesn't show it again.

At launch it looks from that point up to now:

- **What counts:** reminders for events that haven't been going more than an hour. A week back at most. One per occurrence, even with two reminders.
- **One OS notification:** "Missed reminder: Standup · Starts in 4 min", or "3 reminders while Mailbird was closed".
- **In the app:** the first 5 wait in the app state until the UI asks (`take_missed_reminders`), and each shows as a "Missed:" toast that stays until dismissed. At launch the window isn't listening yet, so an event would be lost. Each is handed over once.
- **First launch** (no record yet) catches nothing up and starts the live check a minute back, as before.

## Verification

- **Core (`cargo test -p pim-core`, 148 tests):** meeting links across hosts, paths, punctuation, and look-alikes; birthdays with and without a year, hidden, and as an event; contact activity across mail and meetings; missed reminders within the window, deduplicated, and skipping long-started events; year-less birthdays through a vCard round trip.
- **App (`cargo test -p pim-app`):** every command routes; the Birthdays calendar, a birthday occurrence pointing at its contact, empty activity, and missed reminders handed over once, all through the dispatcher.
- **Browser, demo (`phase9`, 27 checks):**
  - Join in the agenda and the event view (Meet from the location, Zoom from the description); no Join without a call.
  - Birthdays with the age, opening the contact, and hidden with the calendar.
  - The second zone with a half-hour offset, surviving a reload, removed by None, and working with storage blocked.
  - Contact history: conversations, upcoming and past meetings, each opening in Mail or Calendar; nothing for a stranger.
  - A missed reminder shown once; Join on a phone without sideways scroll.
  - All 15 earlier suites still pass.
- **Browser, gateway with real Dovecot (`gateway-p9`):**
  1. Mail from Rui arrives over IMAP; his card (year-less birthday) lists the conversation, which opens in Mail.
  2. His birthday shows on the Birthdays calendar and opens his card.
  3. An event with a Jitsi location gets Join.
  4. The gateway is stopped before the event's reminder and restarted after: the reminder shows as missed, once, and not again on reload.
  - The Phase 6, 7, and 8 gateway suites still pass.
- **Found and fixed while testing:**
  - Catch-up first stopped a minute before launch, so a reminder due in that minute went out live before the window listened. It now runs up to launch.
  - Rust: Birthdays sorted first and broke seven calendar tests; it now lists last.

## Consequences

- Meeting links in lists come from the location only. An event whose link is only in its description gets Join in the event view, not in the agenda.
- Contact activity reads the local store: mail older than what's synced isn't counted.
- The second time zone doesn't follow you between devices or browsers, by design.
- On a gateway, the first browser to load after a restart gets the missed-reminder toasts; others don't.
