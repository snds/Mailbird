# ADR-0020 · Contacts depth: signatures, labels, Recently deleted, and sharing (Phase 10)

- **Status:** Accepted
- **Date:** 2026-10-14
- **Builds on:** [ADR-0010](0010-calendar-contacts.md) (contacts over CardDAV), [ADR-0014](0014-microsoft.md) (Outlook contacts), [ADR-0019](0019-connected-calendar.md)

The [competitive analysis](../research/competitive-analysis.md) lists the contact features people praise in Cardhop and Google Contacts. This phase takes four of them:

- **Signature parsing and enrichment:** a contact made from an email signature, and details kept current without retyping.
- **Labels:** one person can sit in several groups.
- **Restore:** a safety net for deletes and merges.
- **vCard and QR sharing:** hand a card to someone in person.

## Decisions

### Signatures: a heuristic, and always reviewed

`signature::parse_signature` reads a block of text into a card: name, title, company, emails, and phones. `from_message` first finds the block at the end of a message:

- **Quotes are cut off first:** `>` lines, "On … wrote:", forwarded and "Original Message" headers. A quoted signature belongs to someone else.
- **Where the signature starts:** after a `-- ` line; else after a sign-off ("Best,", "Thanks,", "Cheers,"); else the last short paragraph, but only if it has a phone or an email.
- **Lines split on `|`, `·`, and `•`,** so "m: +1 555 0100 · priya@studio.example" is two fields.
- **Phones** need 7 to 15 digits and a phone's characters. The prefix gives the label (m/mobile/cell → cell; o/office/tel/direct → work). Fax numbers are skipped.
- **Lines with leftover digits are dropped** (street addresses, legal text), as are links.
- **The name** is the sender's display name if a line says it, or a line with just their first name ("Ana"). Otherwise it's the first line that reads like a name (2 to 4 capitalized words, no job-title word).
- **Title and company** come from the lines after the name: "Lead | Studio", "Lead at Studio", "Lead, Studio", or two lines. A lone line is a title if it has a job-title word ("Founder", "Engineer"), otherwise a company.
- **When unsure, a field is left empty rather than guessed.**

Nothing is saved from a signature without the editor. **Paste a signature** fills the new-contact editor. **Under a message**, `contact_suggestion` offers what it would add, and **Add** or **Review** opens the editor:

- **A new contact** when the sender isn't one.
- **Missing details for one you have:** a phone, an email, a title, a company. Matched by address, or by the exact name when it's the only contact with it, so Sam writing from a new address gets "add the email", not a duplicate.
- **It only fills blanks.** A signature never overwrites a title or company you typed.
- **It stays quiet for** newsletters and notifications (their category isn't People), your own mail, read-only address books, and a signature that adds nothing new.
- **"Not now"** hides it for the session.

**Why a heuristic, and not a model:** the reasons are the ones ADR-0018 gave for categories. It runs on every device, offline, explains itself, and the editor catches its mistakes. The Rust tests are the reference. The web demo has a TypeScript copy of the same rules.

### Labels are vCard CATEGORIES

Schema version 10 adds `contacts.labels` (JSON, indexed from the card) and backfills it on upgrade.

- **Labels live in the card itself** (`CATEGORIES`, RFC 6350 §6.7.1), so they sync with CardDAV (Fastmail, Nextcloud) and come back on any device. Outlook contacts map them to Graph `categories` both ways.
- **Cleaned when saved:** trimmed, commas removed, no empties, and no repeats that differ only in case. The editor reuses an existing label's spelling, so "clay club" joins "Clay club".
- **An edit that doesn't mention labels keeps them** (`labels: None`). Older callers can't erase them by accident.
- **The list filters by one label at a time** (chips with counts), together with search. Merging keeps both cards' labels.
- **Not covered:** iCloud and Google keep groups as separate group cards (`X-ADDRESSBOOKSERVER-KIND:group`, Google's contact groups) rather than `CATEGORIES`. Their groups don't show as labels yet, and labels added here stay in the card.

### Recently deleted: 30 days, same UID

A `contacts_trash` table keeps the full card of every deleted contact, and of every card a merge folds away, for 30 days. Older entries are purged when the list is read.

**Restore** puts the card back with its **original UID**, so note links (keyed by UID) find it again. It goes back to its address book:

- **If the server hasn't been told about the delete yet,** the delete is simply called off. The row goes back to `changed` and re-uploads over the server copy (same href, same etag).
- **If the book is gone or now read-only,** it returns to "On this device".
- **If a sync already brought it back,** restore just clears the trash entry.

Deleting shows an **Undo** that restores from the trash. The card closes before the delete, because the refresh that follows would otherwise make the open card ask for itself again (this produced the stray 400s the gateway test caught).

### Sharing: the file is the card, the QR is short

- **Save as vCard file** is the stored card exactly as the server has it. On the desktop and phones the app writes it to Downloads. In a browser (the gateway and the demo) the browser downloads it. Where the browser can share files (most phones), **Share…** hands the `.vcf` to the system share sheet.
- **Show QR code** is made in the core (`qrcode` crate, SVG). It holds a short vCard 3.0 with the name, company, title, phones, and emails. It leaves out the photo, notes, and labels, which are too big to scan or not for sharing. It's shown as an image, so the SVG never runs in the page.

## Verification

- **Core (`cargo test -p pim-core`, 159 tests):**
  - Signatures in five shapes (sign-off with `|` and `·`, `-- ` with two role lines, a quoted reply, pasted text, nothing useful).
  - Labels: round trip, filtering, counts, keep vs replace on edit. Outlook categories both ways.
  - Recently deleted: restore with the same UID, the 30-day purge, calling off a pending server delete, a book that's gone, merges.
  - The vCard file name and the QR SVG.
  - Suggestions: new, missing details, a new address under a known name, nothing new, a newsletter, your own mail.
- **App (`cargo test -p pim-app`):** every command routes. Pasted signature → labeled contact → labels, file, QR, delete, and restore, all through the dispatcher.
- **Browser, demo (`phase10`, 25 checks):**
  - Label chips and filtering; adding and removing labels in the editor (Enter adds, doesn't save); a label nobody has leaving the chips.
  - Paste a signature filling every field.
  - The vCard download and QR image.
  - Undo and Recently deleted; a merged card restored.
  - Suggestions: a new phone for Ana, Sam's new address, a first-time sender, nothing on a newsletter, Not now.
  - Phone width without sideways scroll.
  - All 15 earlier suites still pass.
- **Browser, gateway with real Dovecot (`gateway-p10`):** a signed message over IMAP → the suggestion → a labeled contact → label filter → the vCard downloaded from the server (with `CATEGORIES`) → QR → delete → restore with labels, and no failed requests.
- **Found and fixed while testing:**
  - The open card refetched itself after a delete (400s on the gateway).
  - The Edit button didn't pass labels to the editor, so saving would have erased them.

## Consequences

- Signature parsing is English-leaning (the sign-off and job-title words). Other languages still get phones and emails, and the editor fills the rest.
- Labels on iCloud and Google accounts stay in the card and don't become those services' groups (a follow-up).
- Recently deleted is per device: a contact deleted on the phone is restorable there, not on the desktop.
