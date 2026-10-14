# ADR-0021 · Calendar planning: clashes, proposing a new time, finding free time, and calendar sets (Phase 11)

- **Status:** Accepted
- **Date:** 2026-10-14
- **Builds on:** [ADR-0011](0011-calendar-depth.md) (iTIP invitations), [ADR-0019](0019-connected-calendar.md)

The [competitive analysis](../research/competitive-analysis.md) lists the planning features of Outlook, Fantastical, and Notion Calendar. This phase takes four:

- **The invite in the thread shows conflicts:** decide without leaving mail.
- **Propose a new time:** negotiate inside the invitation instead of over email.
- **Availability before proposing:** here, your own free time.
- **Calendar sets:** switch contexts with one tap.

## Decisions

### Clashes on every invitation

An invitation (and a counter-proposal) lists the timed events in your visible calendars that overlap it. The core does this when it reads the message (`Invite.conflicts`).

- **Excluded:** all-day events, which don't block time (birthdays, holidays, "Cabin weekend"), and the invitation's own copy once you've accepted it.
- **The card always says something:** "Clashes with Kiln firing (2:30–4:00 PM)", or "Nothing else on your calendar then". Saying nothing would read as "you're free" either way.
- **Conversations now refresh when the calendar changes.** The card is part of the message, so adding an event elsewhere left a stale "nothing else" (found in testing).

### Proposing a new time is iTIP COUNTER

A guest's **Propose new time** sends `METHOD:COUNTER` (RFC 5546 §3.2.7) to the organizer by email (iMIP). It carries:

- the event's UID and SEQUENCE;
- the proposed DTSTART and DTEND (UTC);
- your ATTENDEE line;
- an optional COMMENT ("After the kiln, please").

**Your answer doesn't change.** You may still accept the original time if they say no. The card remembers what you proposed ("You proposed Fri · 4:00–5:00 PM"). That's stored per message in settings, since nothing in the calendar records it.

**Single events only.** Proposing a new time for a whole series isn't something people do, and Outlook doesn't either.

**As the organizer,** the card shows Now (struck through) beside Proposed, the guest's note, and what the new time clashes with:

- **Accept new time** moves your event through the normal edit. That bumps SEQUENCE and, without CalDAV scheduling, emails everyone the REQUEST. The proposer is marked accepted; everyone else goes back to "No reply", because the time they agreed to changed.
- **Keep original** sends `METHOD:DECLINECOUNTER` to the proposer.
- **Only the organizer can do either.** Your answer is recorded per message.
- **A DECLINECOUNTER you receive** reads "Priya kept the original time."

**Not covered:** servers with CalDAV scheduling (iCloud, Fastmail) also accept COUNTERs through the scheduling outbox. We email them for every account, which every client understands.

### Find a time: your calendars, on the device

`find_times` returns free stretches of the event's length in your visible calendars:

- **From the chosen day over the next two weeks,** never in the past.
- **Between working hours** (9 to 6, weekdays, in the editor).
- **On the half hour, at most two a day**, so suggestions spread over several days instead of filling one morning.
- **Local time** follows the store's time zone, so daylight-saving changes land on the right hours.

The editor's **Find a time** shows them as chips, and picking one fills in the start and end.

**Guests' availability isn't included yet.** It needs CalDAV free/busy (RFC 6638 VFREEBUSY through the scheduling outbox), Google's freeBusy API, and Graph `getSchedule`. Each needs a real server to test against, and none can be reached from this environment. It's the follow-up that makes this an Outlook-style Scheduling Assistant.

### Calendar sets are saved visibility

A set is a name plus the calendars that were showing when it was saved, stored in the core's settings. On the gateway every browser shares them.

- **Applying a set shows exactly those calendars and hides the rest,** using the same hidden flag as the checkboxes, so reminders follow too.
- **A calendar added later is hidden by every set** until a set is saved again. Explicit, and the same behavior as Fantastical.
- **The active set is highlighted** when what's showing matches it exactly. Toggling a calendar by hand turns the highlight off.
- **Saving under an existing name replaces that set.**

## Verification

- **Core (`cargo test -p pim-core`, 165 tests):**
  - COUNTER and DECLINECOUNTER builders: the UID, the proposed time, the note, one attendee; not for a series; nothing that ends before it starts.
  - Clashes: overlaps only, without the accepted copy.
  - Proposing: COUNTER queued to the organizer with the time in your zone in the text; your answer unchanged.
  - The organizer's side: now vs proposed, accept (event moved, SEQUENCE bumped, REQUEST to everyone, statuses reset except the proposer's), decline (DECLINECOUNTER to the proposer, time kept), and a non-organizer refused.
  - Find a time around busy hours, across a weekend, on future dates so the test doesn't age.
  - Calendar sets saved, replaced, applied, and deleted.
- **App (`cargo test -p pim-app`):** every command routes; find a time and calendar sets through the dispatcher.
- **Browser, demo (`phase11`, 18 checks):** a free slot and a clash; proposing (form, note, "You proposed", answer unchanged); `?counter` accept (event moved; Ana back to "No reply", Sam going) and keep-original; find a time skipping a busy day and filling the editor; sets (save, inactive after changes, one-tap switch, delete); the form at phone width. All 16 earlier suites still pass.
- **Browser, gateway with real Dovecot and SMTP (`gateway-p11`):**
  1. An invitation arrives over IMAP, and the core finds its clash.
  2. Propose new time sends a real `METHOD:COUNTER` email to the organizer, with the new time, the note, and the event's UID.
  3. Free times never overlap the busy event.
  4. A calendar set is saved on the server.
- **Found and fixed while testing:** conversations didn't refresh after calendar changes, so an invitation's clashes went stale.

## Consequences

- "Find a time" only knows your calendars. Guests' free/busy is the follow-up above.
- Counter-proposals are answered from mail. The calendar's own event view doesn't list pending proposals yet.
- Calendar sets hide calendars, which also pauses their reminders while hidden. That matches the checkboxes, but it's worth knowing for a "Work" set during the day.
