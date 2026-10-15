# ADR-0029 · Travel and time zones: travel time, "time to leave", and events set in another zone (Phase 19)

- **Status:** Accepted
- **Date:** 2026-10-15
- **Builds on:** [ADR-0011](0011-calendar-depth.md) (reminders), [ADR-0021](0021-calendar-planning.md) (find a time), [ADR-0026](0026-scheduling-links.md) (free times on booking pages)

The [competitive analysis](../research/competitive-analysis.md) §3 lists two calendar rows this phase takes:

- **Travel time and leave-now alerts** (Apple Calendar): blocks reflect real-world logistics.
- **Time-zone-aware event creation** (Fantastical): prevents off-by-hours errors when traveling.

## Decisions

### Travel time is Apple's property, so the two apps agree

An event gets **Travel**: None, 5 minutes up to 2 hours, or any value it already has. Travel time is stored as `X-APPLE-TRAVEL-DURATION;VALUE=DURATION:PT30M`. That's the property Apple Calendar writes and iCloud keeps.

- **iCloud and Apple devices interoperate.** Travel time you set on an iPhone shows here, and the reverse. There's no standard iCalendar property for this, and inventing our own would mean neither side sees the other's.
- **Other servers keep the property and ignore it.** Unknown `X-` properties survive a CalDAV round trip, so nothing breaks.
- **Read leniently, write plainly:** any ISO 8601 duration (`PT1H30M`, `P0DT0H45M0S`), capped at a day. All-day events don't have travel time; making an event all-day drops it.
- **One occurrence can have its own.** Moving a single occurrence across town is common, so an override may carry its own value; otherwise occurrences take the series'.
- **`EventInput.travel` follows the reminders rule:** `None` keeps it, `0` removes it.

Microsoft Graph has no travel field, so Outlook calendars don't get one yet.

### Travel time is busy time

**Find a time** and **booking pages** treat the travel window before an event as busy, so nothing gets suggested or booked into the hour you're driving. Clash checks on invitations still compare the events themselves. They answer "do these overlap?", and a guest's invitation shouldn't be refused because of your commute.

### "Time to leave" comes from the core

An event with travel time raises an alert when the travel time begins, as **Time to leave: ⟨title⟩**, with how long until it starts and where. It works with no reminders set, like Apple's. If a reminder already fires at that exact moment, that reminder stands in for it, so you never get two alerts at once.

The core's existing reminder worker produces it (`DueReminder.leave`). That means the desktop's OS notifications, the web gateway's live events, and missed-while-closed catch-up all handle it with no extra work. A new indexed `travel` column (schema version 12) lets the reminder check skip events that can't fire, instead of parsing every event. Existing events are reindexed on upgrade.

We deliberately don't estimate drive times. That needs a maps service, which would learn where you're going. You set the travel time; the app does the rest.

### How it looks

- **The time grid** draws a hatched band above the event, in its calendar's color and the same width. It's lighter than an event, so it reads as "blocked" rather than as a second appointment. The event's accessible name ends "30 min travel before".
- **The event page** says "30 min travel · leave by 7:45 AM".
- **The editor** says when the alert will come.

### Events can be set in another time zone

The editor gets a **Time zone** row for timed events. It shows your own zone first ("Yours · Lisbon (WEST)"), then every zone the browser knows. When you pick another zone:

- **The times you type are that zone's clock.** A 9 AM call in Tokyo is written `DTSTART;TZID=Asia/Tokyo:…T090000`. When Tokyo or your own zone changes its clocks, the event stays at 9 AM Tokyo time.
- **A line under the zone says what that is for you:** "That's Sat, Oct 17, 1:00 AM–2:00 AM your time (Lisbon)."
- **Find a time** still works: its free times are converted into the event's zone.

Editing an event now opens it **in the zone it was written in**. Before this, the editor showed device-local times and saved them back in the device's zone, which quietly moved other-zone events (and DST-sensitive ones) to your zone. Zones the browser can't name (Windows names from Outlook) fall back to yours, as before. The event page says "Scheduled in Tokyo time: 9:00 AM–10:00 AM GMT+9".

## Tradeoffs

- **Changing the zone keeps the clock time, not the moment.** Picking Tokyo for a 9 AM event makes it 9 AM in Tokyo. That's what you mean when you set a zone (Fantastical does the same), and the line under the picker shows the moment it lands on for you.
- **Travel time isn't a separate event.** Other people's free/busy lookups (on servers that publish it) don't see it; only this app treats it as busy. Making it a real event would clutter every other calendar app.

## Verification

- **Core (`cargo test -p pim-core`, 188 tests):**
  - Apple's property read in hours and minutes, on every occurrence, the moved one included. Durations parsed in several forms.
  - Writing in Apple's form; `None` keeps it, a new value replaces it (never two), `0` removes it, over a day is refused, all-day drops it.
  - One occurrence with its own travel time.
  - "Time to leave" with no reminders set; one alert, not two, when a reminder fires at the same moment; a two-hour lead found across midnight.
  - Find a time skips the hour spent travelling.
- **Browser, demo (`phase19`, 20 checks):**
  - The band above the ferry ends where the event begins; the event's name and page say it.
  - Editing travel updates the page and the editor's alert time.
  - A Tokyo 9 AM call shows at 1 AM on a Lisbon clock, its page says the Tokyo time, and editing opens it in Tokyo time and saves it unchanged.
  - A real "Time to leave" alert with the place, about a minute before the travel time begins; the editor fits a phone.
  - All earlier demo suites still pass.
- **Browser, gateway (`gateway-p19`):**
  - The core stores the travel time; `find_times` skips 1–2 PM before a 2 PM visit an hour away.
  - A Tokyo-time event is stored at midnight UTC.
  - The core's own reminder worker raises "Time to leave" over live events.
