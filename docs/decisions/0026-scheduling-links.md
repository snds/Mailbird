# ADR-0026 · Scheduling links: a public page for your free times, served by the gateway (Phase 16)

- **Status:** Accepted
- **Date:** 2026-10-15
- **Builds on:** [ADR-0016](0016-web-gateway.md) (the web gateway), [ADR-0021](0021-calendar-planning.md) (find a time)

The [competitive analysis](../research/competitive-analysis.md) §3 lists **scheduling links / booking pages** (Google, Morgen, Thunderbird Appointment): they end the back-and-forth email about times. This is the first feature with a page for people who aren't you, so most of this ADR is about what that page can and can't reach.

## Decisions

### A link is a saved offer

A booking link holds:

- a title ("Intro call") and a length (10 minutes to 4 hours);
- the hours you offer (in your calendar's time zone), and whether weekends count;
- how far ahead people can book (1–14 days);
- the calendar bookings go to (one you can edit);
- an optional note for the page ("On video; I'll send the link").

It lives in the core's settings, with an unguessable token (128 random bits) as the page's address. Editing keeps the address. Deleting stops the page at once.

### The page shows free times and nothing else

`public_booking` returns the title, length, note, host name, time zone, and a list of free half-hour starts.

- **Free means** free across every calendar you show, with all-day items ignored (as in Find a time). It starts at least two hours from now, inside the offered hours, and within the days ahead.
- **Nothing else leaves:** not your event titles, not which calendars exist, not who you meet. A visitor can't tell a busy hour from one outside your hours.
- **Times are shown in the visitor's own time zone,** and the page says which.

### Booking is one narrow write

`book_slot` checks, in order:

1. The link exists.
2. A name, and an email address that looks like one.
3. A daily cap: 10 bookings per link per rolling day, so a leaked link can't fill your week.
4. The chosen start is still one of the link's free times. It's recomputed, so two people can't book the same time and a stale page can't book a busy hour.

Then it creates an event titled "Intro call with Rui Costa", with a note saying who booked it, their email, and their message. **If the calendar is on a mail account,** the booker is added as a guest, so the existing invitation flow (ADR-0011) emails them a real invitation. A device-only calendar can't send mail, and the confirmation says so honestly.

### The gateway's only routes without a session

`GET /api/book/{token}` and `POST /api/book/{token}` are the gateway's first unauthenticated routes. They're kept small:

- **Tokens are checked for shape** (32 hex characters) before reaching the core. An unknown and a deleted link look the same (404).
- **Each route calls exactly one command** (`public_booking`, `book_slot`). They never reach the general command route, the event stream, or attachments.
- **Booking needs the `X-Mailbird` header,** like every other write: another site's form can't book in someone's name.
- **A global limit of 30 booking attempts per 10 minutes** sits on top of the per-link cap.
- **Responses aren't cached** (`no-store`).

The page is `/book/{token}`, served by the same web app. It skips the sign-in gate, never opens the event stream, and only calls the booking routes. The gateway test checks that by recording every request the page makes.

### Where links can be shared

- **The gateway** has an address other people can reach, so there the sidebar's **Booking links** section offers **Copy link**.
- **The desktop and phone apps** have no public address. Rather than offer a link nobody can open, they say booking pages are set up on the gateway.
- **Preview** works everywhere, including the demo, by showing the real page in a dialog.

## Verification

- **Core (`cargo test -p pim-core`):**
  - Validation (title, length, hours, days, read-only calendar), editing keeps the token, and deleting kills the page.
  - Free times only: inside the hours, two hours out, on the half hour, with a busy event removed.
  - Booking validation (name, email, a time that isn't free, an unknown token), the event and its note, no double booking, weekdays only, the daily cap, and a whole day running to midnight.
- **Gateway HTTP test (`cargo test -p mailbird-gateway`):** visitors can't list links; the page and an unknown or malformed token; booking needs the header; a bad email; booking; a second booking of the same time refused; the event in the owner's calendar.
- **Browser, demo (`phase16`, 15 checks):**
  - Validation; the link listed with its hours, and no Copy in the demo.
  - The preview shows title, length, note, host, and only times inside the hours.
  - A bad email is refused in plain words; the confirmation shows the time.
  - The event, with who booked it and their note; the booked time leaves the page.
  - Edit and delete; an unknown link's page; phone width.
  - All 21 earlier suites still pass.
- **Browser, gateway (`gateway-p16`):**
  1. The owner makes a link and can copy it.
  2. A separate, never-signed-in phone browser opens it, isn't asked to sign in, books, and sees a confirmation. Its page touched only `/api/book/…` and logged no errors.
  3. The event is in the owner's calendar and counts toward the cap.
  4. The same time can't be booked twice, and a request without the header is refused.
- **Found and fixed while testing:** a day offered until 24:00 had no times (midnight isn't a clock time), and the preview kept stale times after a booking.

## Consequences

- Guests' own calendars aren't checked: the page offers your free times, not mutual ones.
- Bookings can't be rescheduled or cancelled from the page. The booker replies to the invitation, or emails you.
- One person per gateway (ADR-0016) means one host per page. Team or round-robin links are out of scope.
- The gateway is now reachable without a password for these two routes. Anyone exposing it to the internet should keep it behind HTTPS, as the [gateway guide](../../apps/gateway/README.md) already says.
