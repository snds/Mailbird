# ADR-0036 · Who's writing: the sender profile beside the mail (Phase 26)

- **Status:** Accepted
- **Date:** 2026-10-15
- **Builds on:** [ADR-0019](0019-connected-calendar.md) (mail and meetings on each contact), [ADR-0027](0027-faces-and-sources.md) (contact photos), [ADR-0035](0035-links-that-keep-up.md) (notes linked to people)

The [competitive analysis](../research/competitive-analysis.md) §3 credits **Superhuman's sender profile in the mail pane**: who someone is, and what you've done together, without leaving the message. Mailbird already had the pieces on each contact's card: photo, title, quick actions, recent mail, meetings, and notes. But reading their mail meant going to Contacts to see any of it. And people who aren't contacts had nothing at all.

## Decisions

### Beside the conversation when there's room, a tap away when there isn't

- **Wide reader:** a column on the right of the open conversation shows the person on the other side. That's whoever sent the newest message you didn't send.
- **The width that counts is the reader's own,** measured with a container query, not the window's. On a laptop with the list showing, the column folds away before it squeezes the message.
- **Narrow reader or phone:** an **About [name]** button in the conversation's toolbar opens the same profile in a sheet.

### What it shows

- **Their card, if they're a contact:** photo, name, title and company, and address. Otherwise it shows the name from their newest message, marked **Not in your contacts**.
- **One row of actions:**
  - **Email**;
  - **Call** and **Message** when the card has a phone number;
  - **Card**, to open the contact, or **Add**, which starts a new card with their name and address.
- **How long you've heard from them:** "3 messages from them since Oct 2026", counted from mail on this device.
- **What you've done together:**
  - upcoming meetings, with **Join**;
  - recent mail, which leaves out the open conversation, and where tapping a row opens it right here in Mail;
  - recent meetings;
  - their notes, with **New note**.

### Same person, same history

`sender_profile(email)` is one core call:

- **The card:** the card whose addresses include this one, ignoring case. When two cards share an address, the one whose name matches how they sign their mail wins; otherwise, the first by name.
- **The history:** comes from **all** the card's addresses, not just the one on this message. Mail from someone's work and personal accounts shows together.
- **Counts and the "since" date:** come from the messages table only. Nothing is fetched or guessed from the web, so there's no tracking and no social lookups.

## Verification

- **Core (`cargo test -p pim-core`, 202 tests):**
  - the card found by address, ignoring case, and by name when two cards share an address;
  - message count, first date, and the newest name;
  - a stranger, an unknown address, and refusing a non-address.
- **App (`cargo test -p pim-app`):** the command through the dispatcher, including the refusal.
- **Browser, demo (`phase26`, 13 checks):**
  - a contact's card with Email, Call, Message, and Card; how long you've heard from them; other mail but not the open conversation; a row opens in Mail; Card opens the contact;
  - a stranger is marked, and **Add** starts a card with their address;
  - a narrower window folds the column into a sheet; the sheet fits a phone.

  All earlier demo suites still pass.
- **Gateway (`gateway-p26`):**
  - either of a contact's addresses finds their card, with an empty history before any mail;
  - a stranger has no card;
  - a non-address is refused.

## Consequences

- **No outside enrichment:** no company logos, social profiles, or local time from a web service. Those would leak who writes to you. A contact's own fields are the only source.
- **Local time isn't shown.** Mail headers carry a sender's UTC offset, but the store keeps only the timestamp. Showing it would need a schema change, which can come later.
- **Group threads show the newest other sender,** not everyone. A people list for group threads can come later.
