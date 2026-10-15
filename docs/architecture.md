# Architecture

**One web UI, one Rust core, several thin shells.** The interface is a mobile-first React app built on shadcn/ui and Material Symbols. Everything that touches a network protocol, a credential, or the local database lives in a Rust core. Each platform wraps the same UI and calls the same core.

```
                ┌──────────────────────────────────────────────┐
                │  apps/web — React + shadcn/ui + Material      │
                │  Symbols. Mobile-first, adaptive layouts.     │
                └───────────────┬──────────────────────────────┘
                                │  one typed "core client" API
        ┌───────────────────────┼─────────────────────────────┐
        ▼                       ▼                             ▼
  Tauri 2 (desktop)      Tauri 2 mobile*               Web / PWA
  Win · macOS · Linux    iOS · iPadOS · Android        any browser
  IPC → core in-process  IPC → core in-process         HTTPS → apps/gateway
        │                       │                             │
        └───────────────┬───────┴─────────────────────────────┘
                        ▼
           crates/app (pim-app): commands, workers, one dispatcher
                        │
           crates/core (pim-core, Rust)
  accounts · capability matrix · sync engine · SQLite + FTS5 search
  adapters: IMAP/SMTP · Gmail API · Microsoft Graph · JMAP · CalDAV/CardDAV
```

\* If the mobile spike fails on background sync or push, mobile moves to Capacitor + UniFFI with the same core ([ADR-0002](decisions/0002-shells.md)).

## Why this shape

| Constraint | Consequence |
|---|---|
| Browsers can't open raw TCP sockets, so they can't speak IMAP or SMTP. | Protocols live in Rust. The web build talks to a small gateway that runs the same core. |
| Google's CASA security assessment applies when restricted Gmail data touches *our servers*. | Native shells keep mail on the device. The gateway is self-hosted only: it's the user's own server, and we run none. |
| Providers differ: labels vs. folders, notes availability, contact groups. | The core publishes a **capability matrix** per account (`Provider::capabilities()`). The UI designs honest states from it. |
| One design system across six platforms. | One React tree with three layout postures, all driven by tokens. |

## Layout postures

| Posture | Width | Frame |
|---|---|---|
| Phone | < 768 px | Bottom tab bar, stacked list → detail, FAB in the thumb zone |
| Tablet | 768–1279 px | Nav rail with create button, list + detail split |
| Desktop | ≥ 1280 px | Nav rail, list, and reading pane, plus a context panel (planned) |

All three come from `AppShell` + `MasterDetail` (`apps/web/src/app/shell.tsx`, `apps/web/src/components/master-detail.tsx`). Breakpoints are Tailwind `md` and `lg`. Safe-area insets are respected for notches and home indicators.

## Design system

- **Components:** shadcn/ui source on **Base UI** primitives, **Nova** style. It is generated into `apps/web/src/components/ui` by `tools/shadcn-material`, which swaps every Lucide icon for a Material Symbol ([ADR-0003](decisions/0003-material-symbols.md)).
- **Tokens:** `apps/web/src/styles/tokens.css`, in three tiers:
  - **Global** (`--g-*`): raw OKLCH ramps, radius, and motion.
  - **Semantic**: shadcn's contract (`--background`, `--primary`, …) plus app roles such as `--surface-chrome` and `--vertical-mail`. Only this tier changes between light and dark.
  - **Component** (`--c-*`): shell sizes, list-row anatomy, and icon axes.
- **Icons:** the `Icon` component (`apps/web/src/components/icon.tsx`) renders the Material Symbols variable font inside an `<svg>`. Its four axes are tier-3 tokens (`--c-icon-fill/wght/grad/opsz`), registered with `@property` so they animate. A nav item fills its icon on selection, and dark mode drops grade by 25.
- **Vertical wayfinding:** each app area has one accent hue (Mail blue, Calendar coral, Contacts green, Notes amber), used sparingly on the active icon and on data markers.

## Data and sync

- **Local store:** SQLite (rusqlite, bundled) per device, with FTS5 for full-text search. Tantivy is deferred ([ADR-0007](decisions/0007-mail-engine.md)).
- **Mail:** provider adapters (IMAP/SMTP and JMAP) sync into the local store. Lists are grouped into conversations, and attachments are decoded on demand from the stored raw message ([ADR-0008](decisions/0008-mail-depth.md)). Local changes queue as ops and are pushed first. Snooze, undo send, and send-later use the server where supported, and a local scheduler otherwise (`server_side_scheduling`). Details: [ADR-0007](decisions/0007-mail-engine.md).
- **UI data flow:** the web app talks to one `CoreClient` (`apps/web/src/core/client.ts`). It runs over Tauri IPC natively and over an in-memory demo in the browser. TanStack Query caches the results, and core events (`mail:changed`, `outbox:changed`, `accounts:changed`, `pim:changed`) invalidate the cache, so nothing polls.
- **Calendar and contacts:** CalDAV/CardDAV through a small client on the same `reqwest` stack as JMAP (Google signs in with OAuth and uses the same client; Outlook has no DAV, so Graph sits behind the same contract). `calcard` parses iCalendar and vCard, expands recurrences, and writes VTIMEZONEs. Each row keeps the server's resource verbatim, and edits splice into it, so nothing we don't model is lost ([ADR-0010](decisions/0010-calendar-contacts.md)).
- **Notes:** Markdown at rest. Yjs CRDT for multi-device sync through an optional, self-hostable Hocuspocus relay (`tools/notes-relay`). Import from Apple Notes (Markdown export), Google Keep (Takeout), and Markdown folders ([ADR-0005](decisions/0005-notes.md), [ADR-0012](decisions/0012-notes.md)).
- **Secrets:** OS keychain via `keyring`. Never in SQLite, never in web storage.

## Repo layout

```
apps/web/               React app (Vite) — the UI for every platform
apps/web/src-tauri/     Tauri 2 shell (desktop now, mobile next)
crates/core/            pim-core — store, MIME, IMAP/SMTP adapters, capability matrix
tools/shadcn-material/  shadcn → Material Symbols transform
tools/test-mail-servers/ local Dovecot + SMTP sink, and Stalwart (JMAP), for integration tests
docs/                   research, stack, decisions (ADRs)
```

## Decisions

| ADR | Decision |
|---|---|
| [0001](decisions/0001-web-ui-stack.md) | React + Vite + Tailwind v4 + shadcn/ui on Base UI |
| [0002](decisions/0002-shells.md) | Tauri 2 shells; Capacitor as the mobile fallback |
| [0003](decisions/0003-material-symbols.md) | Material Symbols variable font inside an SVG wrapper |
| [0004](decisions/0004-protocols.md) | Rust core with protocol adapters and a capability matrix |
| [0005](decisions/0005-notes.md) | Notes as Markdown + Yjs; import instead of Keep/Apple sync |
| [0006](decisions/0006-product-name.md) | "Mailbird" is a working name only; rename before release |
| [0007](decisions/0007-mail-engine.md) | Mail engine: store/net split, FTS5, local snooze, outbox undo, safe HTML |
| [0008](decisions/0008-mail-depth.md) | Conversations, attachments, IDLE, backfill, JMAP, swipe gestures |
| [0009](decisions/0009-mail-polish.md) | Sent/Archive sync-back, JMAP push, attachment previews, rich-text composer |
| [0010](decisions/0010-calendar-contacts.md) | Calendars and contacts over CalDAV/CardDAV; splice edits into server resources |
| [0011](decisions/0011-calendar-depth.md) | Occurrence edits, reminders, iTIP/iMIP invitations, month view |
| [0012](decisions/0012-notes.md) | Notes: Markdown + Yjs, whole-record index sync, Hocuspocus relay, stable-key links, import |
| [0013](decisions/0013-google.md) | Google: OAuth for installed apps, Gmail API on the JMAP contract, CalDAV/CardDAV with bearer tokens |
| [0014](decisions/0014-microsoft.md) | Microsoft: localhost sign-in, Graph mail per-folder delta with immutable ids, Graph calendars and contacts behind the DAV contract |
| [0015](decisions/0015-mobile-groundwork.md) | Mobile groundwork: periodic checks or a self-hosted push relay, platform seams, virtualized paging list, keyboard inset |
| [0016](decisions/0016-web-gateway.md) | Web gateway: one command layer (`crates/app`) for every shell, a single-person self-hosted server, SSE events, sealed secrets |
| [0017](decisions/0017-mail-power.md) | Send later on the outbox, follow-ups keyed by Message-ID and cleared by replies, RFC 8058 unsubscribe with address checks, signatures and templates in the core, ⌘K |
| [0018](decisions/0018-calm-inbox.md) | Senders across accounts: the Screener (opt-in, new mail only), header-only People/Updates/Newsletters, screen out and block as server archives |
| [0019](decisions/0019-connected-calendar.md) | Meeting links from known hosts, birthdays computed from contacts (read-only calendar), contact activity across mail and meetings, a per-viewer second zone, missed reminders handed to the UI once |
| [0020](decisions/0020-contacts-depth.md) | Signatures read by a header-free heuristic and always reviewed in the editor, labels as vCard CATEGORIES (Outlook categories), a 30-day contacts trash that restores with the same UID, QR from the core |
| [0021](decisions/0021-calendar-planning.md) | Invitation clashes from the store, COUNTER/DECLINECOUNTER over iMIP, find a time in your own calendars (guests' free/busy deferred), calendar sets as saved visibility |
| [0022](decisions/0022-inbox-your-way.md) | Splits as saved rules evaluated in SQL over the Inbox lane (nothing moves on the server), exclusive by default; newsletters bundled at two or more; bundle Undo keyed on Message-ID |
| [0023](decisions/0023-contacts-that-keep-themselves.md) | Smart groups as saved rules evaluated on read; trigger-recorded contact history (30 days) for restore to a point in time with Undo by mark; thread memory by Message-ID so conversations survive server moves |
| [0024](decisions/0024-interesting-calendars.md) | Holidays (13 countries, observed and substitute days) and moon phases (Meeus) computed in the core as read-only device collections; no feeds fetched |
| [0025](decisions/0025-one-action-grammar.md) | One mail action vocabulary for swipes, keys, toolbar, and ⌘K; four swipe slots (short/long) stored and validated in the core; Apple Mail defaults |
| [0026](decisions/0026-scheduling-links.md) | Booking links in core settings with unguessable tokens; the gateway's only sessionless routes (`/api/book/{token}`: one read, one write, capped and CSRF-checked); free times recomputed on every booking |
| [0027](decisions/0027-faces-and-sources.md) | Photos validated in the core and written per vCard version; copies across books by shared email/phone (linked, not merged); one email→photo map for mail avatars, never fetched remotely |
| [0028](decisions/0028-tasks-on-the-calendar.md) | Tasks are notes' checklist items (no separate store); "planned" = the note links to an event titled with the task; checking off edits the note's Yjs document by index confirmed by words; checked items sort down (a core setting) |
| [0029](decisions/0029-travel-and-time-zones.md) | Travel time as `X-APPLE-TRAVEL-DURATION` (indexed, schema v12), busy for find-a-time and booking pages, "time to leave" from the core's reminder worker; editor writes times in the event's own TZID and edits reopen in it |
| [0030](decisions/0030-meeting-services.md) | Parse invitations, don't connect accounts: conference props, then location/URL/description → service, app link (`zoommtg:`, `msteams:`), ID, passcode, `tel:` dial-ins, booking-tool manage links; `open_meeting` allowlist; app-vs-browser pref in the core |
| [0031](decisions/0031-change-a-booking.md) | Per-booking 32-hex code (must match its link) opens `/book/<token>/b/<code>`; reschedule within the link's free times (own event counted free, five moves max) or cancel; invitation link only from `GATEWAY_PUBLIC_URL`, never from the request |
