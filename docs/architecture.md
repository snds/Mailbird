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

- **Shared system:** the primitives and core tokens come from **unicron**, the design system Mailbird shares with Synapse and Lockdown ([ADR-0047](decisions/0047-unicron.md)). `apps/web` installs `@unicron/ui` and `@unicron/tokens` as versioned packages from unicron's release tarballs ([ADR-0052](decisions/0052-unicron-packages.md)).
- **Components:** shadcn/ui source on **Base UI** primitives, **Nova** style, owned in unicron (`@unicron/ui`). unicron's `tools/shadcn-material` (`pnpm regen`) swaps every Lucide icon for a Material Symbol ([ADR-0003](decisions/0003-material-symbols.md)).
- **Tokens,** in three tiers:
  - **Global** (`--g-*`): raw OKLCH ramps, radius, motion, and note-card hues (unicron core).
  - **Semantic**: shadcn's contract (`--background`, `--primary`, …), in the core, plus Mailbird's app roles such as `--surface-chrome` and `--vertical-mail` in `apps/web/src/styles/app-extension.css`. Only this tier changes between light and dark.
  - **Component** (`--c-*`): icon axes and the adaptive sheet in the core; shell sizes, list-row anatomy, notes, and calendar in the app extension.
- **Measured:** `dsa` (design-system analytics) scans `apps/web/src`, and CI's ratchet fails if `className`/style overrides, spread props, or look-alikes of unicron components grow.
- **Icons:** the `Icon` component (`@unicron/ui`) renders the Material Symbols variable font inside an `<svg>`. Its four axes are tier-3 tokens (`--c-icon-fill/wght/grad/opsz`), registered with `@property` so they animate. A nav item fills its icon on selection, and dark mode drops grade by 25.
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
| [0032](decisions/0032-your-keys.md) | Remappable single keys: one command table (`KEY_COMMANDS`) in core and web; per-area (Mail, Calendar) uniqueness; only differences from the defaults stored; a taken key swaps; Esc, ?, and ⌘K fixed |
| [0033](decisions/0033-regional-holidays.md) | One region per holiday calendar (`holiday_regions` setting); regional days as rules (`EXTRAS`) plus national days a region drops (`DROPS`), mirrored in the demo; only regions with fixed rules; calendar renamed for the region |
| [0034](decisions/0034-connected-notes.md) | `[[Title]]` wikilinks as an inline atom with its own Markdown tokenizer (plain brackets, Obsidian-compatible); backlinks parsed from bodies by title, case-insensitive; export as Markdown + front matter (desktop folder, browser zip), round-tripping through the importer |
| [0035](decisions/0035-links-that-keep-up.md) | Rename offers (never silent) to retarget `[[links]]`: each linking note's Yjs doc gets `wikiLink.target` set, then saved as an ordinary edit so sync carries it; "Link…" picker builds NoteLinks from events, contacts, and threads via `note_link_for` |
| [0036](decisions/0036-sender-profile.md) | `sender_profile(email)`: card by any of a contact's addresses (name-matched when two share one), message count and first date, activity across all the card's addresses; profile column by container width (`@4xl`), below it an adaptive sheet (bottom sheet with floating thumb-height close on phones, right panel from `sm`) |
| [0037](decisions/0037-quick-note.md) | Quick Note: views register what's open (`useQuickContext` → `quickContext`); one sheet (adaptive) saves on close via `createNote` with the `note_link_for` link; ⌥N global, ⌘K, and a button in every Notes section |
| [0038](decisions/0038-note-cards.md) | Note cards: `color` on the note record (schema v13, a Keep color name; shades are hue → tint tokens per theme); `NotesPrefs.grid`; `MasterDetail listFills`/`detailTint`; CSS columns with a container-query compact width |
| [0039](decisions/0039-note-reminders.md) | Note reminders: `remind_at` on the note record (schema v14); `due_reminders` also returns notes (`DueReminder.note_id`), so the one reminder loop notifies, emits `reminder`, and catches up; due notes stay set and sort into a Due section until Done |
| [0040](decisions/0040-sender-local-time.md) | Sender local time: `mime::Parsed.tz_offset` from the Date header (`-0000` = unknown) → `messages.tz_offset` (schema v15, lazy backfill from `raw`); `SenderProfile.local_offset`/`offset_seen` from the newest People-category message |
| [0041](decisions/0041-their-time.md) | Their time in the composer: `local_times(emails)` (same People-category rule as the profile); composer line outside their working hours; `SendLaterMenu theirs` group; `nextLocalHour` skips weekends |
| [0042](decisions/0042-smart-folders.md) | Smart folders: `note_folders.rs` (rules in the `notes.folders` setting); `NoteQuery.folder` adds clauses to `notes()`, the folder's words joining the search in one FTS MATCH; chips in Notes |
| [0043](decisions/0043-locked-notes.md) | Locked notes: `notes_lock.rs` (PBKDF2 key, AES-256-GCM `seal`/`open` bound to the note id; schema v16 `locked`, `sealed`); the key held in `AppState.notes_key` with a 10-minute idle lock; records carry `sealed` + `title`; `NotesSync.blank` empties the relay document; the lock setting syncs in the index |
| [0044](decisions/0044-images-in-notes.md) | Images in notes: `note_files.rs` (schema v17 `note_files`; Markdown `![alt](note-file:ID)`; sealed with the note via `reseal_note_files`); `NoteSummary.cover` from the text; import resolves `![](path)`, `![[name]]`, and Keep attachments, export writes `attachments/`; sync: a `files` map in the index plus a `file/<id>` document each; gateway body limit 16 MB |
| [0045](decisions/0045-scans-and-text-in-images.md) | Scans and text in images: Tesseract (tesseract.js) in a worker from the app's own `ocr/` files (a Vite plugin emits them); `ImageTextRunner` reads unread images while idle; schema v18 `note_files.text` + `notes.image_text` in `notes_fts`; text sealed with locked images; `lib/scan.ts` (page finding, perspective straightening, document filter) behind `ScanSheet`; CSP `wasm-unsafe-eval` |
| [0046](decisions/0046-sketches.md) | Sketches: `lib/sketch.ts` (perfect-freehand outlines → SVG with strokes in `<metadata>`), `SketchSheet` + `sketch-store.ts`; `crates/core/src/sketch.rs` allow-lists SVG (quick-xml, now unconditional) on add, sync, import, and sealed open; `--c-sketch-paper` |
| [0047](decisions/0047-unicron.md) | Shared design system: unicron as a pinned submodule (`vendor/unicron`, in the pnpm workspace; packages since 0052); `@unicron/ui` + `@unicron/tokens`; Mailbird's roles in `styles/app-extension.css`; `dsa` scan/patterns/ratchet with `.dsa/baseline.json` in CI; `shadcn-material --alias-mode package` |
| [0048](decisions/0048-design-system-cleanup.md) | Design-system cleanup: unicron#2 adds `IconButton`, `Button shape="pill"`, `ghost-muted` / `ghost-destructive`, `Icon tone`, `SheetContent fullscreen`, Back buttons in `DialogTitle`, and `DialogActions`/`DialogAction` (round icon buttons on phones); the app adopts them, keeps menus frosted glass, renames the two look-alikes (`InterestingCalendarsPicker`, `UnsubscribeAction`), and aligns notes tags with the chip recipe; ratchet 274 → 241 overrides, 2 → 0 look-alikes |
| [0049](decisions/0049-identity-crate.md) | The shared identity crate, `crates/identity` (`ecosystem-identity`): profile, personas, devices, key envelopes, recovery kit, in the layout every ecosystem app reads; built here first, then extracted to `snds/ecosystem-identity` and consumed by pinned commit |
| [0050](decisions/0050-identity-handshake.md) | Identity crate, part two: a local handshake that enrols a new app on the device behind a transport trait (verified peers, a six-digit code, commit-then-reveal); KDF parameters only rise (`Head.kdf`); app labels on app-key envelopes, bound into the AAD; `retire_envelope` with manifest tombstones |
| [0051](decisions/0051-identity-holds-the-notes-key.md) | The identity holds the locked-notes key: `pim_app::identity` wraps the `NotesKey` as Mailbird's App Data Key under the default persona on every passphrase unlock or change, and `unlock_notes_with_identity` opens notes with it (remembered envelope first, then `app_keys(persona, "mailbird")`); a passphrase change retires the old wrap; off unless the host enables it (desktop: `default_root()` + a `FileKeystore` in the data folder); the passphrase path is unchanged |
| [0052](decisions/0052-unicron-packages.md) | unicron as versioned packages: `@unicron/ui` 0.2.0 and `@unicron/tokens` 0.1.0 from GitHub release tarballs (hash-pinned in the lockfile, one tokens override); the `vendor/unicron` submodule, `deps:build`, and the local `tools/shadcn-material` copy are gone |
| [0053](decisions/0053-map-of-notes.md) | Map of notes: `note_graph` (the list's query → notes, `[[link]]` pairs resolved as `find_note` does, shared linked items); a deterministic, settled force layout (`graph-layout.ts`); `NotesPrefs.graph`; one Tab stop with arrow-key walking; `useOpenLink` shared with link chips |
| [0054](decisions/0054-menu-bar-calendar.md) | Menu-bar mini calendar: `pim_app::menu_bar` (prefs, next up, relative words, 30 s refresh) through new `Host::menu_bar` / `Host::show_app` hooks; the Tauri shell draws the tray (template icon on macOS), a borderless `?mini` window that hides on blur, and close-to-tray; `app:jump` opens events in the main window |
| [0055](decisions/0055-power-settings.md) | Power settings: `pim_core::MailPrefs` (images, mark read, quoting, check interval, receipts; snapped, defaults filled in); `Draft.request_receipt` → `Disposition-Notification-To` in `build_message` for every protocol; the mail check reads its interval every 30 s; Advanced mail settings dialog; identity device named "Mailbird on <host>" |
| [0056](decisions/0056-shared-notes.md) | Shared notes: `NoteShare` on notes and their sync records (schema v19), `share_note` / `unshare_note`, guest notes from links; the relay's `mailbird/shared/<id>` documents, HMAC share tokens, the index's `shares` list (checked per connection, read-only for view links, guests dropped on stop or demotion) and `/share` page; `SharedDocWatch` keeps shared notes connected, `GuestShares` syncs guests on the owner's relay; Share and Open-a-shared-note dialogs; link cards in mail |
| [0057](decisions/0057-raw-button-sweep.md) | Raw-button sweep: editor Cancel → `Button`, one chip × (`IconButton` on a pill `ghost-muted` `icon-xs` `Button`), agenda link → `Button variant="link"`; `tools/ds-raw-buttons.mjs` ratchets plain `<button>`s per file against `.dsa/raw-buttons.json` (with a reason each) in CI; four unicron/dsa proposals for the rest |
| [0058](decisions/0058-ds-additions-adopted.md) | Design-system additions adopted: `@unicron/ui` 0.3.0 (`Item` as a button for rows, `Button size="inline"` for text actions, `Chip` / `ChipAction` / `ChipRemove` for chips) and `@snds/dsa` 0.2.0 (`rawElements` in the one ratchet, replacing `tools/ds-raw-buttons.mjs`); Mailbird test hooks on `data-role`; 19 raw buttons left, each a whole surface or a row with its own buttons |
| [0059](decisions/0059-opt-in-ai.md) | Opt-in AI: `pim_core::ai` (`AiPrefs` in settings, address check, `thread_text` with quotes cut and a 24k budget, prompts, lenient answer readers); `net::ai` (OpenAI-style `/chat/completions` and `/models`, Anthropic `/v1/messages` with low effort and server-side fallback); `pim_app::ai_commands` (keys in the secret store as `ai:<provider>`, never returned); Summary card and suggested-reply `Item`s in the conversation; settings dialog |
| [0060](decisions/0060-team-conversations.md) | Shared conversations: `team_threads.rs` (schema v20 `team_threads`: owner/guest, link, revoked, saved Yjs state); `team_commands` (+ `team:changed`); web `features/team` (TeamSync per document on `mailbird/shared/<id>`, `meta`/`messages`/`comments` + Tiptap `draft`; owner's copy follows the thread); share links gain `kind: "thread"`; the index's `shares` lists `{ thread }` entries; Mail → Team tab |
| [0061](decisions/0061-presence-and-shared-files.md) | Presence: Yjs awareness `person` on shared documents (`rejoining(…, { onPeople })`, `here(name)`), `usePresence` store, `PeopleHere`; files: `mailbird/shared/<id>/files` (relay allows the suffix under the same share token), `SharedFiles` (`images` for notes → guest's `put_note_file`; `attachments` for conversations, owner-chosen, ≤ 10 MB) |
| [0062](decisions/0062-end-to-end-encrypted-sync.md) | Optional E2E: `RelayConfig.key` (keychain `notes-relay-key`); sealed docs `mailbird/x/…` as encrypted append-only logs over Hocuspocus stateless messages (`pull`/`push`/`compact`/`p`/`purge`), relay `.log` files; `SealedProvider` (AES-256-GCM, HKDF per document name); share keys on `NoteShare.key` / `team_threads.key` (v21), in links as `k`; shares list in readable `mailbird/registry`; relay `SEALED` mark refuses readable docs |
| [0063](decisions/0063-shared-inbox.md) | Gateway team: `members.json` (PBKDF2-SHA256 600k, hashed invite codes, 7 days), sessions carry `Who {id,name,owner}`, `MEMBER_COMMANDS` allowlist and `MEMBER_EVENTS` filter, `by`/`owner` injected from the session; core v22 `thread_assignees` + `thread_comments`, `MessageQuery.assignedTo`, event `inbox-team:changed`; presence `POST /api/here` → `inbox:here`; web `InboxTeamPanel`, "Assigned to me", `/join`, `isMember()` limits to Mail |
| [0064](decisions/0064-unicron-0-7.md) | `@unicron/ui` 0.7.1 / `@unicron/tokens` 0.5.0; `--vertical-*-text` roles (600 light / 300 dark) for area hues drawn as text, today-chip and badge pairs; `DialogContent size` replaces width overrides, built-in dialog scrolling; `ItemMain` rows for booking links, the newsletter bundle, and a contact's meetings; ratchet 211 overrides, 16 raw elements |
| [0065](decisions/0065-relay-key-secret-field.md) | Relay key in `SecretField`: read mode (hold to show, Copy with a 90 s clear, unconditional) when the device has it, edit mode to paste it; "Use a different key"; an empty field keeps the saved key |
