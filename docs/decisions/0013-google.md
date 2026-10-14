# ADR-0013 · Google accounts (Phase 4)

- **Status:** Accepted
- **Date:** 2026-10-14
- **Builds on:** [ADR-0004](0004-protocols.md)

Phase 4 brings Google. Microsoft Graph follows as Phase 4b and reuses the OAuth layer built here.

## Decisions

### OAuth for installed apps, hand-rolled on our HTTP stack

- **The sign-in pattern:** the authorization-code flow with PKCE (RFC 7636) and a loopback redirect (RFC 8252 §7.3).
- **How a sign-in runs:**
  1. The shell binds a random port on `127.0.0.1`.
  2. It opens the provider's page in the **system browser**. Never an embedded webview: providers block those, and a webview could see the password.
  3. When the browser comes back with a `code`, the shell checks `state`.
  4. It trades the code and the PKCE verifier for tokens.
- **While waiting:** a second sign-in, **Cancel**, or five minutes ends the wait.
- **Why hand-rolled:** about 300 lines on the `reqwest` + rustls/ring stack we already ship. The `oauth2` crate would add a second HTTP abstraction for very little. PKCE uses `ring`'s SHA-256 and system RNG, which rustls already depends on.
- **Tokens:**
  - The keychain entry for an OAuth account holds its token set (access, refresh, expiry) as JSON.
  - Every protocol asks the shell for a current access token. The shell refreshes two minutes before expiry, one refresh at a time.
  - `invalid_grant` (revoked, expired, or the password changed) shows as **Sign in again** on the account.
  - Removing the account revokes the token with Google first.
- **Clients:** an OAuth client ID is a registration with Google, not a secret we can bundle for everyone yet.
  - **Built in:** builds may include one at compile time (`MAILBIRD_GOOGLE_CLIENT_ID` / `_SECRET`).
  - **Your own:** anyone can paste their own in the app, and that takes precedence over the built-in one. See [google-verification.md](../google-verification.md).
  - **The client secret:** Google requires one for Desktop clients, and says it isn't confidential in an installed app.

### Gmail API for mail, with the same contract as JMAP

The Gmail adapter returns the same `RemoteBatch` the JMAP adapter does. The store, the outbox, and the UI didn't change.

- **Labels classify each message into one store mailbox:**
  - **Not tracked:** `TRASH`, `SPAM`, `DRAFT`, or `CHAT`.
  - **Inbox:** `INBOX`.
  - **Sent:** `SENT` without `INBOX`.
  - **Archive:** anything else ("All Mail").
- **Local changes become label changes:**
  - Read: remove `UNREAD`.
  - Star: add `STARRED`.
  - Archive: remove `INBOX`.
  - Changes are grouped into one `batchModify` per label change. If a batch fails because a message was deleted meanwhile, each message is retried alone and the gone ones are skipped.
- **Incremental sync:**
  - `history.list` from the last `historyId` gives the messages that changed.
  - `messages.get` then reads their labels, plus the raw RFC 5322 bytes for new ones, eight at a time.
  - A history id too old to diff (404) starts over, without duplicating anything.
- **Backfill:** the first pass takes the newest 500 inbox messages and a page of Sent and Archive. Later passes page backwards with Gmail's page tokens, which are kept in the cursor next to the history id.
- **Send** goes through `messages.send`. Gmail files the Sent copy itself, and that copy replaces the app's local one in the conversation.
- **No push, so we poll:** Gmail push requires a Cloud Pub/Sub topic and a server to receive it, which a local-first app doesn't run. The shell polls the profile's `historyId` every 30 seconds instead. That's one small request, and the change shows up within half a minute.
- **The scope is `gmail.modify`.** It can archive and mark read, but it can't permanently delete mail.

### Google Calendar and Contacts over CalDAV and CardDAV

- **No new client:** Google's CalDAV (`apidata.googleusercontent.com/caldav/v2/`) and CardDAV (`www.googleapis.com/carddav/v1/principals/{address}/`) accept the same OAuth token. The Phase 2 DAV client gained one constructor, `Dav::with_bearer`.
- **What we get for free:** discovery, sync, conflict handling, recurrence, invitations, and reminders all work unchanged.
- **What we give up:** Google contact groups (People API only) and Google Calendar colors beyond what CalDAV exposes. The capability matrix still says groups are possible for Google, so the People API is a follow-up rather than a dead end.

### Honest states in the UI

- **Gmail sign-in screen:**
  - Lists, in plain words, what Google will ask for.
  - Explains Google's "unverified app" warning before you see it.
  - Asks for a client when the build has none.
- **While waiting:** it says to finish in the browser, and **Cancel** works.
- **Microsoft:** still listed, with "Microsoft sign-in is coming in the next release." It isn't hidden.

## Verified

- **Rust:** 110 core unit tests (+8), plus the Gmail integration test below.
  - PKCE against the RFC 7636 test vector.
  - The sign-in URL.
  - Callback parsing, including cancel.
  - ID-token claims.
  - A real loopback round trip that rejects a mismatched `state`.
  - Label classification, op mapping, and cursor state.
- **Fake Gmail and token server (offline, in CI):**
  - Code exchange, refresh (the refresh token is kept when not rotated), a revoked refresh token, and expired access tokens refused.
  - First sync that skips drafts and spam.
  - Changes made elsewhere: new, archived, read, deleted, trashed.
  - Local read, star, and archive pushed as labels.
  - A change to a message deleted meanwhile.
  - A reply sent through Gmail joining its thread once.
  - Backfill, a history reset with no duplicates, and polling.
- **Playwright:**
  - Microsoft's "coming next" state.
  - The Gmail screen without a client, then saving one.
  - What Google will ask for, and the test-mode warning.
  - The demo's "needs the desktop app".
  - Changing or removing the client, and the phone layout.
  - Every earlier suite still passes.
- **Not verified:** a sign-in against Google itself. This cloud environment can't reach Google, and it needs a registered client. The protocol code follows Google's documented endpoints and is exercised end to end against the fake. The first real sign-in is on a desktop build.

## Not yet

- Microsoft Graph (Phase 4b): mail, calendar, and contacts.
- Google contact groups and calendar colors through the People and Calendar APIs.
- Gmail labels beyond Inbox, Sent, and Archive, shown as labels in the UI.
- Google verification itself ([checklist](../google-verification.md)). It depends on the product rename (ADR-0006).
