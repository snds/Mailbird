# ADR-0004 · Protocol adapters and the capability matrix

- **Status:** Accepted
- **Date:** 2026-10-13

## Decision

`pim-core` (Rust) owns every account. Each provider gets an adapter:

| Provider | Mail | Calendar | Contacts | Auth |
|---|---|---|---|---|
| Google | Gmail API (labels, history sync, push) | Google Calendar API / CalDAV | People API (groups) | OAuth 2.0 |
| Microsoft 365 / Outlook.com | Microsoft Graph | Graph | Graph | OAuth 2.0 |
| iCloud | IMAP/SMTP | CalDAV | CardDAV | App-specific password |
| JMAP (Fastmail, Stalwart) | JMAP | JMAP / CalDAV | JMAP (RFC 9610) | OAuth / token |
| Generic | IMAP/SMTP | CalDAV (discovered) | CardDAV (discovered) | Password / OAuth |

- **No EWS** for Exchange Online. It is blocked by default from Oct 2026 and shuts down in Apr 2027.
- **No basic auth** anywhere it can be avoided.

`Provider::capabilities()` publishes what each account can do: labels vs. folders, notes support, contact groups, server-side scheduling, push, and auth method. **The UI must read this matrix instead of assuming**, and design explicit states for unsupported features.

## Why

Research ([§4](../research/competitive-analysis.md#4-protocol-and-integration-realities)) shows the providers differ in ways users can see. Hiding those differences produces silent failures, such as a snooze that never fires because the app was closed, or a "synced" note that never leaves the device.

## Consequences

- **Google OAuth verification and CASA:** the native apps keep mail on the device. Hosted use of the web gateway needs the annual assessment, so it is self-host first.
- **Crates:** lettre, async-imap, mail-parser, mail-builder, jmap-client, libdav, calcard, and oauth2. All are permissive.
