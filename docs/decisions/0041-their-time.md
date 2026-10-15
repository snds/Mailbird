# ADR-0041 · Their time in the composer (Phase 31)

- **Status:** Accepted
- **Date:** 2026-10-15
- **Builds on:** [ADR-0040](0040-sender-local-time.md) (a sender's local time from their own mail), [ADR-0017](0017-mail-power.md) (send later)

The [competitive analysis](../research/competitive-analysis.md) §3 credits **send later** to Gmail and Outlook, because it "respects the recipient's time zone and the sender's working hours". Phase 7 built send later on your own clock. Phase 30 learned the recipient's clock from their mail. This phase joins the two, where you write.

## Decisions

### The composer knows who you're writing to

- **A new core lookup, `local_times(emails)`,** returns the clock of each recipient whose own mail says where they are. It's the same rule as the sender profile: the newest message in the People category, never a list's. Unknown addresses are left out, so a first message to someone shows nothing.
- **The composer asks for the To field, as you type** (up to ten addresses).

### It speaks up only outside their working hours

- **One line under the recipients:** "It's 12:30 AM for Priya · Night there · UTC+5:30".
  - It appears only for night, early morning, evening, and weekend; the words are the sender profile's.
  - During their working hours there's nothing to say, so the composer stays quiet.
- **A one-tap offer beside it:** **Send 9:00 AM for Priya** schedules the message for their next workday morning. The usual "Sends Fri, Oct 16, 4:30 AM" bar then shows it in your time, with **Send now instead**.

### Send later has "Their time"

- **The send-later menu gets a Their time group:** "9:00 AM for Priya", with your time beside it ("Fri 4:30 AM"). This works even in their working hours, when the composer line stays quiet.
- **One choice per time zone, and at most two,** so writing to a group doesn't flood the menu. Recipients in your own zone add nothing, because your presets already fit them.
- **"Their next workday" skips Saturday and Sunday** and is at least 15 minutes away. A message written on Friday night for Bengaluru goes out Monday at 9:00 there.

### On phones

The sentence takes the full width and the offer sits under it, aligned with the text, so neither is squeezed. The composer is a full-screen overlay there, so this follows the media query, as overlays do.

## Verification

- **Core:** `local_times` returns known clocks in the order asked, once each, and skips unknown and invalid addresses.
- **Dispatcher:** `local_times` routes and returns `[]` for someone who hasn't written.
- **Browser, demo (`phase31`, 12 checks, on fixed Lisbon clocks):**
  - replying to Priya at 8 PM Thursday says it's 12:30 AM and night for her;
  - one tap schedules 9:00 AM her time (4:30 AM yours), and the offer goes;
  - the menu lists her morning, with your time, under **Their time**;
  - an unknown address shows nothing, and the menu has no "their time";
  - Marcus in Toronto mid-afternoon gets no warning, but his morning is offered (2:00 PM yours);
  - Friday night skips to Monday;
  - the offer fits a phone;
  - no console errors.

  All earlier demo suites still pass.

## Consequences

- **9:00 AM is fixed.** Learning when someone usually reads mail (from when they reply) would beat a fixed hour, but that's a guess about a person, and needs more care.
- **Holidays aren't skipped.** Interesting calendars (ADR-0024) know them by country, but a time-zone offset doesn't say which country.
