# ADR-0030 · Meeting services: reading the call out of an invitation, and opening the right app (Phase 20)

- **Status:** Accepted
- **Date:** 2026-10-15
- **Builds on:** [ADR-0019](0019-connected-calendar.md) (Join buttons from meeting links), [ADR-0011](0011-calendar-depth.md) (invitations)

Sean asked for Zoom, Calendly, Teams, and other meeting services to fit in two ways:

- **Parse** an invitation's details into the calendar event.
- **Open** the right app (or the browser version) for the call.

Phase 9 found a meeting link and gave it a Join button that opened in the browser. This phase reads everything else an invitation says about its call, and opens it where you want.

## Decisions

### Read the invitation; don't connect accounts

We parse what the invitation already carries. We don't sign in to Zoom, Teams, or Calendly.

- **It works for every invitation, from anyone,** including meetings you're only a guest at, which no API on your side could see.
- **It needs no accounts, OAuth apps, or keys.** Nothing about your calendar goes to those services.
- **Creating Zoom or Teams meetings from here would need their OAuth apps.** That's left for later, behind the same kind of setup as Google and Microsoft sign-in. For a call link today, **Add video call** in the editor makes a Jitsi room: no account, an unguessable name, and anyone with the link joins.

### What we read (`meeting::meeting_info`, `manage_links`)

From the event's conference properties first, then its location, URL, and description:

- **Where the link comes from:** RFC 7986 `CONFERENCE`, Google's `X-GOOGLE-CONFERENCE`, and Microsoft's `X-MICROSOFT-SKYPETEAMSMEETINGURL` / `X-MICROSOFT-ONLINEMEETINGCONFLINK`. These are each server's own record of the call, so they win over links in the text.
- **The service:** Zoom, Google Meet, Teams, Webex, Jitsi, Whereby, FaceTime, GoTo, or Chime. Only known meeting hosts count, as in Phase 9; look-alike hosts don't.
- **The meeting ID and passcode,** from labeled lines ("Meeting ID: …", "Passcode: …"), or Zoom's ID from its link. A label must be followed by a colon, so `?pwd=` inside a link is never read as a passcode.
- **Dial-in:** "one tap" lines (`+16699006833,,850…#,,,,*123456#`), "PIN:" lines (Google Meet), and plain numbers under a "Dial by your location" heading.
  - Each becomes a `tel:` link that dials the number, waits, then enters the meeting ID and PIN. Up to three are kept, with their place ("US (San Jose)").
- **Booking tools' links:** Calendly's `/reschedulings/` and `/cancellations/`, Cal.com's `/reschedule/` and `/booking/`, SavvyCal, Acuity, and Doodle.
  - These open the tool's own page to change or cancel the booking. We can't change a booking you didn't create here by editing our copy, and those pages are where the organizer hears about it.

Lists (agenda, contact cards) now find a call link in the description too, so a Zoom or Teams invitation gets Join in the agenda, not only on its page. Occurrences carry `meeting_url` and `meeting_app_url`; the event page and invitations carry the full `meeting` and `manage`.

### Opening the right app

- **Zoom and Teams get app links:**
  - Zoom: `zoommtg://<host>/join?action=join&confno=<id>&pwd=<pwd>`
  - Teams: `msteams:/l/meetup-join/…`
- **Join uses the app link by default.** The browser link sits beside it as **Open in browser**. The other services' web links already hand off to their apps when installed, or run in the browser (Meet, Jitsi), so they need nothing more.
- **Settings has Open video calls in their apps.** Off, every Join opens the browser in a new tab. The setting lives in the core (`meeting_prefs`), so every browser on a gateway agrees.
- **On the desktop, Join asks the core to open the link with the system,** which knows which app claims `zoommtg:` or `msteams:`.
  - `open_meeting` accepts only known meeting links, those two app schemes, and booking tools' manage links. A `file:` link, `javascript:`, or another app's scheme is refused, so a crafted invitation can't make the app open something else.
  - In a browser, Join is an ordinary link: the browser asks before it opens an app.

### Where it shows

- **The event page** has a call panel under the title:
  - Join (in the app) and Open in browser.
  - The meeting ID and passcode, each with Copy.
  - Call in buttons.
  - "Booked with Calendly", with Reschedule and Cancel booking.
- **Invitations in mail** show the same panel in compact form, before you answer. A hybrid invite ("room 2, or join online") gets its Meet link even though its location is a room.
- **The editor** notes when pasted text has a call ("Zoom call · Join shows on the event · Meeting ID …").

## Tradeoffs

- **Text parsing is heuristic.** Services change their wording, and other languages label things differently ("Kenncode", "Contraseña"). A miss only loses the ID or passcode row: Join still works from the link, and the full text is in the notes. Each label list is easy to extend.
- **App links can't tell us whether the app is installed.** In a browser, a missing Zoom app shows the browser's own "no app" message, so Open in browser is always beside Join, and the setting turns app links off for good.
- **No cancel without the tool.** For a Calendly booking, Cancel opens Calendly; it doesn't delete our copy first. Calendly then sends a cancellation, and the invite handling we already have updates the event.

## Verification

- **Core (`cargo test -p pim-core`, 193 tests):**
  - A real-shaped Zoom invitation: link, app link, ID, passcode, three dial-ins with `tel:` codes and places. A bare Zoom link gives its ID from the URL.
  - Teams (app link, ID, passcode, dial-in with its place) and Google Meet (no app link, PIN dial-in); no call in plain text.
  - Calendly and Cal.com manage links; booking pages and look-alikes ignored.
  - `openable` refuses `file:`, `javascript:`, other schemes, and non-meeting pages. Prefs default to apps.
  - Conference properties (Google's, RFC 7986, Microsoft's) on masters and moved occurrences.
  - Event details carry the meeting and manage links; lists find a link in the description and carry Teams' app link.
- **Browser, demo (`phase20`, 21 checks):**
  - Join in the agenda and on the event opens Zoom's app, with Open in browser; ID and passcode, Copy to the clipboard, one-tap dial-in.
  - A Calendly-booked Teams call: Join Teams in its app, Reschedule and Cancel booking to Calendly's pages.
  - The setting turns app links off.
  - A mail invitation's Meet link and PIN dial-in.
  - The editor recognizes a pasted Zoom invitation; Add video call makes a Jitsi room, which joins in the browser.
  - Phone width.
  - All earlier demo suites still pass. Two older tests were updated: Phase 9's now expects Join Zoom to open the app, and editor tests click the exact "Add".
- **Browser, gateway (`gateway-p20`):**
  - The real core reads a Teams call, its dial-in, and Calendly's links from a description; lists get Join and the app link.
  - `open_meeting` takes a Teams app link and refuses `file:`.
  - With apps off (set through the core), Join opens the browser, and the event page shows the booking and the call-in number.
