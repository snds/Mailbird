# ADR-0031 · Change a booking: the booker's own page to reschedule or cancel (Phase 21)

- **Status:** Accepted
- **Date:** 2026-10-15
- **Builds on:** [ADR-0026](0026-scheduling-links.md) (scheduling links), [ADR-0030](0030-meeting-services.md) (booking tools' manage links)

Phase 16's booking pages let someone take one of your free times. If their plans changed, they had to write to you, and you moved the event by hand. Calendly, Cal.com, and every tool Phase 20 learned to read give the booker their own link to reschedule or cancel. This phase gives ours the same.

## Decisions

### Every booking gets a private code

Booking mints a 32-character random code (as unguessable as the link's own token). `/book/<token>/b/<code>` opens that one booking's page.

- **No account or sign-in.** The code is the key, like the link itself.
- **Both parts must match.** A code works only with its own link, so a booker can't use their code on someone else's link. A wrong code finds nothing ("This booking link isn't active"), the same answer as an unknown link.
- **The core keeps a small record** per booking (code, link, event, time, name, email, how often it moved, whether it was cancelled), in settings beside the links. Records are forgotten 30 days after the booking ends.

### Where the booker gets the link

- **On the confirmation page,** always: "Change or cancel this booking", with Copy link.
- **In the invitation's description,** when the gateway knows its own public address (`GATEWAY_PUBLIC_URL`). The booking is then like a Calendly one in the booker's calendar, and Phase 20's parser shows Reschedule and Cancel for it (as "Mailbird", on any https host).
- **The address comes from configuration, never from the request.** A booker could otherwise book with someone else's email and point the real host's invitation at a site of their choosing. Without `GATEWAY_PUBLIC_URL`, invitations carry no link; the confirmation page still does.

### What the page does

- **Shows the booking** in the visitor's time zone, and who it's with.
- **Pick a new time:** the link's own free times, with the booking's current event counted as free (so the next half hour can be taken) and its current time left out. The event moves in your calendar, and the guest's invitation is updated, as for any edit you make.
  - **At most five moves.** After that the page says to write to the host. A booking can't wander forever, and the same rate limit as new bookings applies to every change.
- **Cancel booking,** after a second "Yes, cancel it". The event is deleted (the guest's invitation is cancelled), and the page says "This booking is cancelled" from then on.
- **Not after it starts.** A booking that has started, or that the host deleted, can't be changed: the page says so.

### Owners see it too

In the owner's **Preview**, the confirmation has **See their page**, which opens the booker's page right there. The demo uses this, since its bookings live in memory.

## Tradeoffs

- **Anyone with the link can change the booking.** That's how every scheduling tool works. The page shows only this booking (the booker's own name and time) and the link's free times, nothing else about the calendar.
- **Bookers can't add a note when they move or cancel.** The host sees the change in their calendar; a reason would need a mail to the host, which is a later step.

## Verification

- **Core (`cargo test -p pim-core`, 194 tests):**
  - The manage link in the invitation's description.
  - Codes work only with their own link; a made-up code finds nothing.
  - The page leaves out its own time and offers the half hour right after it.
  - A move moves the event and frees the old time; only free slots are taken.
  - Cancel deletes the event and stays cancelled. A host-deleted event reads as cancelled.
  - The change JSON shape (`{"action":"reschedule","start":…}`).
  - Phase 20's parser reads another Mailbird's booking link.
- **Gateway (`cargo test -p mailbird-gateway`):**
  - The public routes: the invitation carries `GATEWAY_PUBLIC_URL`'s address.
  - A wrong code gets 404, and a change without the header gets 403.
  - Reschedule, then cancel, and the event leaves the owner's calendar.
- **Browser, demo (`phase21`, 10 checks):**
  - From Preview, See their page; move to a new time; Keep it backs out of cancelling; cancel.
  - The event moves, then leaves your calendar.
  - Phone width, and Keep the current time.
  - All earlier demo suites still pass. Phase 20's list check now uses tomorrow's call: today's had ended, and ended calls rightly drop Join.
- **Browser, gateway (`gateway-p21`):**
  - A never-signed-in phone books and gets its own link; the owner's event carries it.
  - The phone moves the booking (the same event moves), and a made-up code opens nothing.
  - It cancels; the event goes, and it stays cancelled on reload.
  - The page only talks to its own booking's endpoint.
