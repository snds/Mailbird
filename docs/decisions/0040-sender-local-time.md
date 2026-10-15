# ADR-0040 · The sender's local time (Phase 30)

- **Status:** Accepted
- **Date:** 2026-10-15
- **Builds on:** [ADR-0036](0036-sender-profile.md) (the sender profile), [ADR-0018](0018-calm-inbox.md) (People, Updates, and Newsletters from headers)

The [competitive analysis](../research/competitive-analysis.md) §3 credits the **sender profile in the mail pane** to Superhuman. Phase 26 built the profile. Superhuman also shows the sender's local time, which this phase adds. Knowing it's past midnight for someone changes how you read their silence, and when you'd write back.

## Decisions

### The time zone comes from their own mail

- **Every message's `Date` header carries the sender's UTC offset** (`-0700`, `+0530`). It's read once, when the message is stored, and kept with it (schema version 15).
  - This covers every provider at once: IMAP, JMAP, Gmail, and Outlook messages all pass through the same parser.
  - `-0000`, which RFC 5322 reserves for "local time unknown", counts as unknown.
- **The profile uses their newest personal message**, in the People category. A newsletter's or a booking system's `Date` is its server's clock, not anyone's day.
- **Messages from before this version are read on first use.** A few of the sender's newest messages are parsed, and the offset is kept for next time. Nothing is reprocessed in bulk.
- **Nothing is fetched or guessed.** No location lookup and no IP geolocation. If their mail doesn't say, the profile doesn't either.

### What the profile shows

- **Their time, live:** "12:30 AM", updated as the clock moves.
- **The offset and the gap from you:** "UTC+5:30 · 4½ h ahead of you", or "same time as you".
- **A word outside working hours:** "Night there" (10 PM to 5 AM, with a moon icon), "Early morning there", "Evening there", and "Weekend there". Between 8 AM and 6 PM on a weekday there's nothing extra, because nothing is unusual.
- **"as of" a month** when the message it came from is more than 90 days old. People move, and daylight saving shifts the offset.
- **Screen readers hear it as one sentence:** "Local time for Priya Raman: 12:30 AM, UTC+5:30, 4½ h ahead of you. Night there."

It appears in the profile wherever the profile shows: the column beside a conversation, and the sheet on narrower screens and phones.

## Verification

- **Core:**
  - Offsets parse from `-0700`, `+0530`, and `+0000`; `-0000` and a missing `Date` mean unknown.
  - The profile takes the newest personal message's offset and ignores a mailing list's.
  - A message stored before version 15 is read once and its offset kept.
- **Browser, demo (`phase30`, 9 checks, on a fixed clock in Lisbon):**
  - Priya in Bengaluru reads "12:30 AM, UTC+5:30, 4½ h ahead of you, Night there", as one sentence, and stays live ten minutes on.
  - Marcus in Toronto reads "3:10 PM, UTC−4, 5 h behind you", with nothing extra.
  - Automated mail has no local time.
  - On a phone, the sheet reads "same time as you, Evening there" for Ana in Lisbon.
  - No console errors.

  All earlier demo suites still pass.

## Consequences

- **The offset, not the zone.** A `Date` header says "+0100", not "Europe/Lisbon", so the time is right until their daylight saving changes. Their next message corrects it.
- **Next:** send later could offer "9:00 AM their time" when you write to someone whose offset is known.
