# ADR-0014 · Microsoft accounts (Phase 4b)

- **Status:** Accepted
- **Date:** 2026-10-14
- **Builds on:** [ADR-0013](0013-google.md)

Phase 4b adds Outlook.com and Microsoft 365: mail, calendars, and contacts, all through Microsoft Graph, on the OAuth layer from Phase 4.

## Decisions

### Sign-in: the same flow, with Microsoft's rules

- **A public client:** Microsoft's installed-app registration has no client secret. PKCE protects the code.
- **Redirect to `http://localhost`:**
  - Microsoft's portal registers `localhost` directly, and ignores the port.
  - Registering `127.0.0.1` would mean editing the app manifest.
  - Browsers may resolve `localhost` to either loopback address, so the sign-in listens on both `127.0.0.1` and `::1`, on the same port.
- **`prompt=select_account`,** so a browser signed in to several accounts doesn't pick one silently.
- **Identity:**
  - Personal accounts' ID tokens usually carry only a sign-in name, and Graph's `mail` field is often empty.
  - So the address comes from `/me` (`mail`, else `userPrincipalName`), and so does the display name.
- **Rotating refresh tokens:** Microsoft rotates them, and every refresh keeps the new one (the code already did; now it's tested).
- **No revoke:** Microsoft has no endpoint for an app to revoke itself. Removing an account deletes its tokens here, and the setup guide links the account pages that revoke access everywhere.

### Mail: Graph, on the JMAP and Gmail contract

The Graph adapter returns the same `RemoteBatch` as JMAP and Gmail. The store, the outbox, and the UI didn't change.

- **Folders:** Inbox, Sent, and Archive are the well-known folders `inbox`, `sentitems`, and `archive`. An account without an Archive folder skips it.
- **Immutable ids:** every request sends `Prefer: IdType="ImmutableId"`. Graph ids otherwise change when a message moves, so an archive would look like a delete plus a new message.
- **Sync per folder:**
  - Each folder runs its own `messages/delta`.
  - **First round:** the folder's mail, newest first, a page at a time. That's the backfill.
  - **After that:** the delta link returns only what changed.
- **Moves:** a message `@removed` from one folder and present in another during the same pass is a move. Removed from a folder and present nowhere tracked, it's gone.
- **New mail during the first round:** a long first round would hold back new inbox mail until it finished. While it pages (and on the pass that finishes it), each pass also checks the 25 newest inbox messages directly.
- **Expired delta links (410):** that folder starts its first round again. Known ids aren't downloaded twice.
- **Local changes:**
  - Read and flagged: `PATCH`.
  - Archive and unarchive: `move`.
  - A message deleted meanwhile is skipped.
- **Send:** `sendMail` with the MIME message the app built, so Message-ID threading works as everywhere else. Outlook files the Sent copy itself, and that copy replaces the local one.
- **No push, so we poll:** Graph change notifications need a public webhook, which a local-first app doesn't run. The app checks the inbox's counts every 30 seconds instead, and the regular sync covers everything else.

### Calendars and contacts: Graph behind the CalDAV/CardDAV contract

Outlook.com has no CalDAV or CardDAV, so a translator sits where the DAV client would. It speaks the same contract (`discover`, `pull`, `push`, with `DavPlan` and `DavResult`). On the way in, Graph events become iCalendar objects and Graph contacts become vCards. On the way out, the store's edits become Graph JSON. The store, the editors, reminders, and invitations didn't change.

- **Hrefs and ids:**
  - Hrefs are Graph paths: `/calendars/{id}/`, `/events/{id}`, `/contacts/{id}`.
  - Graph picks its own ids, so creating an item returns a new outcome, `DavOutcome::Created(href, etag)`, and the store moves the item to it. That's the one change to the shared contract.
- **Etags:**
  - Graph's `@odata.etag`, sent back as `If-Match`. A 412 is a conflict and the server wins, as with CalDAV.
  - A series also folds in a digest of its exceptions' etags, so an occurrence edited in Outlook is noticed even when the series' own etag doesn't move.
- **Sync:** list every item's id and etag, then fetch only what changed. That's CalDAV without `sync-collection`. It's simple and correct, but a large calendar is listed in full every five minutes; see "Not yet".
- **Times:**
  - Times are read in UTC, then written on the event's own clock, from `originalStartTimeZone`. calcard maps Windows names such as "Pacific Standard Time" to IANA.
  - So a weekly 9:00 stays 9:00 across daylight saving.
  - Times go out as wall-clock time in an IANA zone.
- **Recurrence:**
  - Every Graph pattern maps to an RRULE: daily, weekly, absolute and relative monthly and yearly, with numbered, end-date, and no-end ranges.
  - Parts that only restate the start are left out, so a plain "every week" stays editable as such.
  - The other way, rules Graph can't express (BYHOUR, several BYMONTHDAY values, …) leave the server's rule untouched.
  - Changing a rule makes Outlook drop the series' exceptions, so the rule is only sent when it really changed.
- **Occurrences:** cancelled occurrences become EXDATEs, and exceptions become RECURRENCE-ID overrides. Local occurrence edits and deletes go to Graph's instances, found by the slot they fill.
- **Invitations:**
  - Exchange sends invitations and replies itself, so Outlook calendars are marked as scheduling servers, and the app doesn't send iMIP mail for them.
  - Answering an invitation calls `accept`, `decline`, or `tentativelyAccept`. Only the reminder of someone else's event is edited.
- **What doesn't translate:**
  - **One reminder per event:** Outlook keeps the one closest to the start.
  - **Contacts:** at most three emails, two work and two home phones, and one mobile. Birthdays need a year.
  - **New items get new UIDs:** an event or contact created here takes Graph's UID once synced. A note linked to it before that first sync loses the link.
  - **Contact folders** other than the default aren't synced.

## Verified

- **Rust:** 122 core unit tests (+12).
  - The Microsoft sign-in URL, and the `localhost` redirect answering on IPv4.
  - Folder, op, and state mapping for mail.
  - A full Outlook series: its zone, the UNTIL at the end of the last day, a cancellation, an exception across the DST change, an attendee, and a reminder.
  - All-day and UTC events.
  - Recurrence both ways, including "every weekday", "the last Friday", and the rules Graph can't take.
  - Events going out on their own clock.
  - Contacts both ways.
  - Etags and hrefs.
  - The new `Created` outcome in the store.
  - Regression: the RRULE reader ignores VTIMEZONE rules.
- **Fake Graph and token server (offline, in CI, `tests/graph.rs`), two end-to-end tests.** The fake refuses any request without immutable ids.
  - **Sign-in:**
    - No secret is sent, and identity comes from `/me`.
    - A rotated refresh token is kept, and the spent one fails.
  - **Mail:**
    - First sync; changes made elsewhere (new, read, a move to Archive, deleted, moved to Deleted Items).
    - Local read, flag, and archive.
    - A reply joining its thread once.
    - Backfill, an expired delta link with nothing duplicated, new mail during a first round, and polling.
  - **Calendars and contacts:**
    - First sync of a series with an exception and a cancellation, a one-off event, and an invitation; a quiet pass.
    - Outlook edits, including one only an exception's etag reveals.
    - A weekly event created here that keeps 15:00 Lisbon across the clock change, without a duplicate.
    - One occurrence moved and one removed here, with the unchanged rule not resent.
    - A stale edit losing to the server.
    - Accepting an invitation.
    - Contacts created, edited, and deleted in Outlook.
- **Playwright:** the Outlook sign-in screen, with no secret field and Microsoft's own wording, alongside Gmail's. All earlier suites still pass.
- **Not verified:** a sign-in against Microsoft itself. This environment can't reach Microsoft, and it needs a registered app. Graph's documented behavior that the fake stands in for (delta ordering, `exceptionOccurrences`, IANA zones in `dateTimeTimeZone`) is the thing to watch on the first real sign-in. If `exceptionOccurrences` isn't available, the adapter falls back to fetching series without their exceptions.

## Not yet

- Calendar delta (`calendarView/delta`) instead of listing every event's etag.
- Contact folders beyond the default, and contact groups.
- Graph change notifications through a relay, for instant mail.
- Publisher verification and a built-in registration ([guide](../microsoft-setup.md)).
