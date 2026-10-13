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
  IPC → core in-process  IPC → core in-process         HTTPS → gateway → core
        │                       │                             │
        └───────────────┬───────┴─────────────────────────────┘
                        ▼
           crates/core (pim-core, Rust)
  accounts · capability matrix · sync engine · SQLite + FTS5 search
  adapters: IMAP/SMTP · Gmail API · Microsoft Graph · JMAP · CalDAV/CardDAV
```

\* If the mobile spike fails on background sync or push, mobile moves to Capacitor + UniFFI with the same core ([ADR-0002](decisions/0002-shells.md)).

## Why this shape

| Constraint | Consequence |
|---|---|
| Browsers can't open raw TCP sockets, so they can't speak IMAP or SMTP. | Protocols live in Rust. The web build talks to a small gateway that runs the same core. |
| Google's CASA security assessment applies when restricted Gmail data touches *our servers*. | Native shells keep mail on the device. The gateway is self-hostable and stateless where possible. |
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
- **UI data flow:** the web app talks to one `CoreClient` (`apps/web/src/core/client.ts`). It runs over Tauri IPC natively and over an in-memory demo in the browser. TanStack Query caches the results, and core events (`mail:changed`, `outbox:changed`, `accounts:changed`) invalidate the cache, so nothing polls.
- **Calendar and contacts:** CalDAV/CardDAV via `libdav`, Graph, and the Google APIs. iCalendar and vCard parsing uses `calcard`.
- **Notes:** Markdown at rest. Yjs CRDT for multi-device sync through our own optional, self-hostable relay. Import from Apple Notes (Markdown export) and Google Keep (Takeout) ([ADR-0005](decisions/0005-notes.md)).
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
