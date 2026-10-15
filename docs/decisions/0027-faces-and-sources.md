# ADR-0027 · Faces and sources: contact photos, where each card lives, and faces in mail (Phase 17)

- **Status:** Accepted
- **Date:** 2026-10-15
- **Builds on:** [ADR-0010](0010-calendar-contacts.md) (contacts over CardDAV), [ADR-0020](0020-contacts-depth.md)

The [competitive analysis](../research/competitive-analysis.md) §3 lists two contact rows this phase takes:

- **Contact photos** (Apple): fast visual recognition in lists.
- **Unified contacts with source badges** (Apple Contacts): shows where each record lives, so you don't edit the wrong copy.

Principle 2 (cross-vertical objects are the product) adds a third: the face you set on a card should show up in mail too.

## Decisions

### Photos are set on the device, small, and synced with the card

The contact editor gets **Add photo**, **Change photo**, and **Remove photo**.

- **The image is processed in the browser before it goes anywhere:** cropped to a centered square, resized to 256 px, and saved as JPEG at 0.85 quality (tens of KB). Phones and servers show contact photos small, and a large photo would slow every sync of the card.
- **The core checks it again:** only JPEG, PNG, or WebP data URLs, within the size the lists already show (`PHOTO_LIMIT`, 150 KB). Remote URLs are refused. The app never fetches remote photos (that would tell their host when you look), so it doesn't write them either.
- **Written per vCard version:** inline binary (`PHOTO;ENCODING=b;TYPE=JPEG`) for vCard 3.0, which is what most servers and phones read, and a data URI for 4.0.
- **"Leave it alone" is the default.** `ContactInput.photo` is `None` unless the editor changed the photo, and an empty string removes it. An edit made from anywhere else (a signature suggestion, a merge) never drops a photo by accident.

### Source badges: every row says where its card lives

With more than one address book showing, each contact row carries a small badge: the account's name, or "On this device". With one book there's nothing to tell apart, so no badge. The card's existing **Saved in** line stays.

### "Also in": the same person in other books

`contact_copies` finds cards in *other* address books that share an email or a phone number (normalized as for duplicates). The card lists them under **Also in**, by book, with the other card's name when it differs ("Work as Ana D."). Each opens that copy.

This is deliberately not a merge, and not a unified row:

- **Merging is for duplicates you created.** The Duplicates review already offers it.
- **Copies in different books often belong to different worlds:** your work address book and your personal one. Unifying them silently would make it unclear which server an edit goes to, the very problem source badges exist to solve.

### Faces in mail

`contact_photos` returns photos by lowercase email address, from visible address books. Mail rows and message headers show the photo instead of initials when the sender has one. It's one small query shared by every row (refreshed when contacts change), not a lookup per message. Senders without a card keep their initials, and nothing is ever fetched from the sender's side (no Gravatar, no BIMI): a face shows only if you put it on a card.

## Verification

- **Core (`cargo test -p pim-core`, 184 tests):**
  - Photos are written as inline binary for 3.0 and read back identical; an edit without a photo keeps it; an empty photo removes it; 4.0 keeps a data URI.
  - Remote URLs, GIFs, broken base64, and oversized images are refused.
  - Copies: the same address in another book counts; a card in the same book doesn't, and neither does a phone shared within one book. Photos by address.
- **Browser, demo (`phase17`, 14 checks):**
  - Source badges on rows.
  - A non-image refused in plain words; a photo resized to JPEG on the device and shown in the editor, card, and list.
  - The sender's face in mail rows and the message header, initials for others.
  - Removing the photo.
  - "Also in" with the other card's name, linking both ways.
  - Phone width.
  - All 22 earlier suites still pass.
- **Browser, gateway (`gateway-p17`):**
  1. Real IMAP mail from someone with no card shows initials.
  2. Adding a card with a photo stores a JPEG, the exported vCard carries `PHOTO;…ENCODING=b`, and `contact_photos` maps the address to it.
  3. The mail row then shows the face.

## Consequences

- No photo editing beyond the centered crop. A crop tool can come later if people ask.
- "Also in" matches on email and phone only. Two cards with just the same name aren't linked; the duplicate review still suggests those.
- Calendar guests and the composer's recipient chips still use initials. They can use the same photo map later.
