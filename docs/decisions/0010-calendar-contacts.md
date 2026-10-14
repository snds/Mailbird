# ADR-0010 · Calendars and contacts (Phase 2)

- **Status:** Accepted
- **Date:** 2026-10-14

## Decisions

### Keep the server's resource; splice edits into it

Every event row stores its iCalendar object verbatim. Every contact row stores its vCard verbatim. Each row also holds a few indexed fields for lists:

- **Events:** title, location, first start, last end, all-day, recurring.
- **Contacts:** name, sort key, company, emails, phones, embedded photo.

Edits never rebuild a resource from our model:

1. Parse the original with `calcard`.
2. Replace only the properties we own.
3. Write it back.

| | We own | Kept as-is |
|---|---|---|
| **Events** | `SUMMARY`, `LOCATION`, `DESCRIPTION`, `DTSTART`/`DTEND`, and `RRULE` when it's simple. Bumps `SEQUENCE`, `DTSTAMP`, `LAST-MODIFIED`. | Alarms, attendees, overrides, and X- properties. |
| **Contacts** | `FN`, `N`, `EMAIL`, `TEL`, `ORG`, `TITLE`, `NOTE`, `BDAY` | Addresses, related people, photos, and X- properties. |

New contacts are written as vCard 3.0, the version every CardDAV server, iCloud included, accepts. An existing card keeps its version.

### Recurrence and time zones come from `calcard`, in Rust

- **What calcard handles:** `calcard` (Stalwart's library, Apache-2.0 OR MIT) expands `RRULE`s with `EXDATE`s and `RECURRENCE-ID` overrides, across DST. On write it generates the `VTIMEZONE` that a `TZID` needs (`add_missing_timezones`).
- **How we write times:** timed events go out in the device's IANA zone, such as `DTSTART;TZID=Europe/Lisbon`, never as UTC. That keeps a weekly 9:30 at 9:30 after the clocks change.
- **All-day and floating times:** these sit on the device clock. The webview reports its zone on launch (`set_time_zone`), and the store re-indexes all-day rows when that zone changes. Window queries widen by a day, so a zone change can't hide anything.
- **The editor's vocabulary:** none, daily, weekly, monthly, or yearly. Anything richer from another app shows as **Custom** and is kept untouched on edit.
- **Deleting one date of a series** adds an `EXDATE`. Editing one occurrence on its own is not offered yet.
- **Series edits** start from the series' first occurrence, never the one you tapped, so changing the title doesn't silently move the series start.

`rrule.js` stays off the stack (stale, with time-zone bugs). The web demo has its own small expander for its sample data only.

### A small DAV client on the stack we already have

CalDAV/CardDAV is hand-rolled on the same `reqwest` client and rustls/ring TLS as JMAP, with `quick-xml` for multistatus responses. We didn't adopt `libdav`, which brings its own hyper/tower stack.

- **Discovery** follows RFC 6764: a bare host means `/.well-known/caldav` (or `carddav`), then `current-user-principal`, then the home set, then collections.
  - Redirects are followed by hand so PROPFIND stays PROPFIND.
  - A redirect to plain `http://` off-device is refused.
  - Task-only lists (VTODO) aren't treated as calendars.
- **Sync** uses `sync-collection` (RFC 6578). When the server lacks it or forgets the token, it falls back to comparing etags. Bodies arrive through `calendar-multiget` or `addressbook-multiget` in chunks of 50.
- **Writes are conditional:** `If-Match` with the etag we last read, or `If-None-Match: *` for new resources.
- **XML parsing ignores namespace prefixes:** servers disagree on prefixes, never on local names.

### Local changes push first; the server wins conflicts

- **Edits** apply to the local row at once, so the UI is instant. The row is marked `changed`; a delete marks it `deleted` and hides it.
- **A sync pass** pushes each collection's changes, then pulls.
- **Conflicts:** a `412` (changed elsewhere since we read it), or a `404` on an edit, comes back as a conflict. The row drops its etag, and the next pull restores the server's version.
  - We don't merge, and a stale edit never overwrites someone else's.
  - Tested with two devices editing one event.
- **Pulls never overwrite a row** that still has a local change pending.

### Separate status, separate schedule

- **Status:** calendar and contacts sync is tracked apart from mail (`dav_last_sync`, `dav_error`), so one can fail visibly while the other works. Errors show in the account list and above the calendar list.
- **Schedule:** CalDAV has no push we can rely on, so it polls every 5 minutes and runs shortly after each local edit. Mail push doesn't trigger it.

### Accounts

| Provider | Calendars | Contacts | Password |
|---|---|---|---|
| iCloud | `caldav.icloud.com` | `contacts.icloud.com` | Same app-specific password as mail |
| Fastmail | `caldav.fastmail.com` | `carddav.fastmail.com` | Separate app password, stored in the keychain under `{account}:dav`. Fastmail's JMAP API token can't do CalDAV. Optional when adding the account. |
| Other IMAP/JMAP | Optional server URL | Optional server URL | Same password |

An account added without calendars can connect them later ("Connect calendars and contacts"). Credentials are verified against the servers before anything is saved.

Calendars and address books **on this device** always exist, so events and contacts work with no account at all. They never sync.

### Views built on our tokens, not Schedule-X

- **The views:** agenda, day, and week are our own components on tier-3 tokens (`--c-event-*`, `--c-calendar-*`). One input, the calendar's server color (`--event`), derives an event's fill, edge, and text with `color-mix`, so any server color stays legible in both themes.
- **Week view:** overlapping events share a cluster and split its width into columns. Short events collapse to one line.
- **Phones:** the agenda is the default, and today always shows ("Nothing planned").
- **Quick add:** `chrono-node` (MIT) parses natural language with forward-looking dates. A trailing "at …" or "@ …" becomes the location.

### Contacts

- **Sorting:** the list sorts by family name from `N`, with A–Z sections. Companies file under their own name.
- **Search** covers names, companies, emails, and phone numbers.
- **Duplicates:** cards that share an email (case-insensitive), a phone (last 10 digits), or a full name are grouped as possible duplicates. Single-word names like "Mom" don't count.
  - **Merging** keeps the chosen card and adds the other cards' missing emails, phones, and fields. Nothing merges without a person choosing.
- **Photos:** only embedded photos are shown. A remote photo URL is never fetched, because fetching it would tell the host when you look.
- **Cross-vertical:**
  - The card shows recent mail with the person, and **Email** opens the composer addressed to them.
  - The composer's To and Cc fields suggest contacts (a WAI-ARIA combobox: Enter or Tab picks, Escape closes only the list).

## Verified

- **Rust:** 76 tests (74 core, 2 shell).
  - Recurrence with `EXDATE`, overrides, and DST.
  - All-day events on the device clock.
  - `VTIMEZONE` generation.
  - Edits that keep alarms and custom rules.
  - vCard 3/4 reading, writing, merging, and phone normalization.
  - Store windows, hiding, time-zone re-indexing, the push queue, conflicts, and duplicate grouping.
  - Multistatus parsing (prefixes, entities, CRLF in calendar data).
- **DAV integration (Stalwart, in CI):** two devices on one account.
  - Discovery, create, edit, and delete in both directions.
  - A concurrent edit resolved to the server's version.
  - A stale `If-Match` refused.
  - A weekly series with a skipped date.
  - Contact create, merge, and delete.
- **Playwright:**
  - **Calendar:** week view and overlap layout, quick add, detail, edit keeps the duration, delete, skip one occurrence, read-only calendars, hiding a calendar, keyboard views, click-to-create, all-day, and the phone agenda, editor, and detail.
  - **Contacts:** sort and sections, search, card actions, Email to composer, autocomplete, create, edit, merge, and delete, plus the phone layout.
  - Every earlier suite still passes.

## Not yet

_Phase 2b delivered occurrence edits, invitations, the month view, and reminders. See [ADR-0011](0011-calendar-depth.md)._

- Editing a single occurrence (a `RECURRENCE-ID` override), and "this and following".
- Invitations: sending and answering iTIP/iMIP, and free/busy.
- Month view.
- Reminders and notifications from `VALARM`.
- Contact groups, and editing addresses or photos.
- Google and Microsoft calendars (Phase 4, with OAuth).
- A JMAP Calendars/Contacts adapter, once Fastmail ships them.
