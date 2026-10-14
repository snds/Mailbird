# OSS stack and licensing

_Versions and licenses verified 2026-10-13 against the npm registry and crates.io. **Rule:** every dependency we ship must be permissive (MIT, Apache-2.0, BSD, ISC, or 0BSD). MPL-2.0 is allowed only unmodified (file-level copyleft). GPL, AGPL, EUPL, SSPL, and BSL code never ships inside the client. Copyleft servers can run beside us as separate network services._

**Status key**

- ✅ **In scaffold:** installed in this repo today.
- 🟦 **Chosen:** chosen, but added in the phase that needs it.
- ⚪ **Alternative:** evaluated and kept as an option.
- ⛔ **Avoid:** do not use.

## Front end (web, shared by every shell)

| Package | Role | Version | License | Status | Notes |
|---|---|---|---|---|---|
| react | UI runtime | 19.x | MIT | ✅ | — |
| vite | Build | 8.3 | MIT | ✅ | v8 runs on Rolldown. |
| typescript | Language | 6.0 (7.0 available) | Apache-2.0 | ✅ | TS 7 is the Go-native compiler. Upgrade once the tooling catches up. |
| tailwindcss | Styling | 4.3 | MIT | ✅ | CSS-first config. All tokens live in `src/styles/tokens.css`. |
| shadcn (CLI) | Component source | 4.21 | MIT | ✅ | Base UI base + Nova style. Icons swapped to Material Symbols by `tools/shadcn-material` (see [ADR-0003](decisions/0003-material-symbols.md)). |
| @base-ui/react | Headless primitives | 1.9 | MIT | ✅ | Replaces the deprecated `@base-ui-components/react`. |
| material-symbols | Icon font | 0.48 | Apache-2.0 | ✅ | Variable font with FILL, wght, GRAD, and opsz axes. |
| class-variance-authority, clsx, tailwind-merge | Variant plumbing | latest | MIT / Apache-2.0 | ✅ | Standard shadcn utilities. |
| @tanstack/react-router | Routing | 1.170 | MIT | 🟦 | Typed routes and deep links across shells. |
| @tanstack/react-query | Server-state cache | 5.104 | MIT | ✅ | Wraps calls to the core. |
| @tanstack/react-virtual | Long lists | 3.14 | MIT | ✅ | The mail list renders only visible rows and pages in 200 at a time. |
| zustand | UI state | 5.0 | MIT | ✅ | — |
| @tiptap/react, pm, core, starter-kit, extensions, extension-list | Composer and notes editor | 3.31.3 (pinned) | MIT | ✅ | **Avoid Tiptap Pro** (paid). Transitive menu packages are pinned to the same release in `pnpm-workspace.yaml`. |
| @tiptap/markdown | Notes ↔ Markdown | 3.31.3 (pinned) | MIT | ✅ | Uses `marked` (MIT). Also runs headless for sync. |
| @tiptap/extension-collaboration, @tiptap/y-tiptap | Editor ↔ Yjs binding | 3.31.3 / 3.0.9 (pinned) | MIT | ✅ | — |
| yjs, y-protocols | CRDT for notes sync | 13.6.33 / 1.0.7 (pinned) | MIT | ✅ | See [ADR-0012](decisions/0012-notes.md). |
| @hocuspocus/provider, @hocuspocus/server | Notes sync client and relay | 4.7.0 (pinned) | MIT | ✅ | The relay is `tools/notes-relay`. Hocuspocus Cloud and Tiptap Collab are paid hosted options; not needed. |
| @schedule-x/calendar | Calendar views | 4.9 | MIT core | ⚪ | Not used: Phase 2 built its own agenda/day/week views on our tokens ([ADR-0010](decisions/0010-calendar-contacts.md)). |
| ical.js | iCal / vCard parsing (web) | 2.2 | MPL-2.0 | ⚪ | Not needed: the Rust core parses everything and the UI gets typed rows. |
| chrono-node | Natural-language dates (quick add) | 2.10.1 (pinned) | MIT | ✅ | “Lunch with Ana tomorrow 1pm”. |
| dompurify | Sanitize email HTML (web) | 3.4 | Apache-2.0 option | ✅ | Elect Apache-2.0. Rendered inside a sandboxed iframe. |
| temporal-polyfill | Dates and time zones | 1.0 | MIT | 🟦 | Prefer Temporal over date-fns for time-zone-correct calendar math. |
| cmdk | Command palette | 1.1 | MIT | 🟦 | shadcn Command. |
| sonner | Toasts / undo | 2.0 | MIT | 🟦 | — |
| react-hook-form + zod | Forms | 7.90 / 4.6 | MIT | 🟦 | — |
| i18next | Localization | 26 | MIT | 🟦 | — |
| vite-plugin-pwa | Installable web app | 2.0 | MIT | 🟦 | Confirm Vite 8 compatibility. |
| vaul | Drawer | 1.1 | MIT | ⚪ | **Unmaintained.** Prefer the Base UI Drawer. |
| lexical | Editor | 0.52 | MIT | ⚪ | Still 0.x. |
| fullcalendar | Calendar | 7.1 | MIT core | ⚪ | Premium views are paid. |
| @blocknote/core | Editor | 0.55 | MPL-2.0 | ⛔ | `@blocknote/xl-*` is GPL-3.0 or proprietary. |

## Native shells

| Package | Role | Version | License | Status | Notes |
|---|---|---|---|---|---|
| tauri, @tauri-apps/cli, @tauri-apps/api | Desktop + mobile shell | 2.12 | MIT OR Apache-2.0 | ✅ | Windows, macOS, and Linux now. iOS and Android are a spike (see [ADR-0002](decisions/0002-shells.md)). |
| tauri-plugin-opener | Open saved attachments | 2.7 | MIT OR Apache-2.0 | ✅ | — |
| tauri-plugin-notification | Reminder notifications | 2.4.0 (pinned) | MIT OR Apache-2.0 | ✅ | Sent from Rust; the web layer needs no JS package. Plugin 3.0 alphas exist, so expect churn. |
| tauri-plugin-deep-link, biometric | Shell plugins | 2.4–2.6 | MIT OR Apache-2.0 | 🟦 | — |
| @capacitor/core, ios, android | Mobile fallback shell | 8.5 | MIT | ⚪ | Used only if the Tauri mobile spike fails on background sync or push. |

## Rust core

| Crate | Role | Version | License | Status |
|---|---|---|---|---|
| tokio, serde | Runtime, serialization | 1.x | MIT / MIT OR Apache-2.0 | ✅ |
| async-imap (or imap-next) | IMAP | 0.12 | MIT OR Apache-2.0 | ✅ |
| lettre | SMTP | 0.11 | MIT | ✅ |
| mail-parser | MIME parsing | 0.11 | Apache-2.0 OR MIT | ✅ |
| mail-auth | DKIM/SPF/DMARC checks | 0.13 | Apache-2.0 OR MIT | 🟦 |
| jmap-client | JMAP client | 0.4 | Apache-2.0 OR MIT | ⚪ (not used: defaults to aws-lc-rs; our small client covers what we need, ADR-0008) |
| calcard | iCalendar + vCard, recurrence, VTIMEZONE | 0.3.14 (pinned) | Apache-2.0 OR MIT | ✅ |
| libdav | CalDAV / CardDAV client | 0.11 | ISC | ⚪ (not used: brings its own hyper stack; our small client on reqwest covers it, ADR-0010) |
| quick-xml | WebDAV multistatus parsing | 0.42 | MIT | ✅ |
| chrono | Date math (calcard's types) | 0.4 | MIT OR Apache-2.0 | ✅ |
| rusqlite (bundled) | Local store | 0.40 | MIT | ✅ |
| SQLite FTS5 (in rusqlite) | Full-text search | — | Public domain | ✅ |
| tantivy | Full-text search at scale | 0.26 | MIT | ⚪ (deferred, ADR-0007) |
| oauth2 | OAuth (Google, Microsoft) | 5.0 | MIT OR Apache-2.0 | ⚪ |
| ring | PKCE (SHA-256) and OAuth state; sealing secrets in the push relay and the gateway (AES-256-GCM); APNs/FCM JWTs | 0.17 | Apache-2.0 AND ISC | ✅ |
| axum | HTTP for the push relay (`tools/push-relay`) and the web gateway (`apps/gateway`) | 0.8 | MIT | ✅ |
| tower-http | The gateway's static web app and security headers | 0.6 | MIT | ✅ |
| keyring | OS keychain | 3.6 (4.x for Android later) | MIT OR Apache-2.0 | ✅ |
| ammonia | HTML sanitize (native) | 4.2 | MIT OR Apache-2.0 | ⚪ (UI sanitizes with DOMPurify today) |
| tokio-rustls + rustls (ring) + webpki-roots | TLS for IMAP | 0.26 / 0.23 / 1.0 | MIT/Apache-2.0/ISC; webpki-roots CDLA-Permissive-2.0 | ✅ |
| futures, thiserror, uuid, serde_json, base64 | Plumbing | — | MIT OR Apache-2.0 | ✅ |
| reqwest (rustls, no default provider) | JMAP over HTTPS | 0.13 | MIT OR Apache-2.0 | ✅ (uses our rustls/ring config) |
| email-lib (Pimalaya) | Mail library | 0.27 | MIT | ⚪ |
| uniffi | Swift/Kotlin bindings | 0.32 | MPL-2.0 | ⚪ (only with the Capacitor fallback) |
| vstorage / pimsync | DAV sync | 0.11 | EUPL-1.2 | ⛔ |
| tauri-plugin-stronghold | Secrets | 2.4 | MIT/Apache | ⛔ (uncertain upstream; use `keyring`) |
| tauri-plugin-keyring (3rd party) | Secrets | 0.1 | MIT | ⛔ (abandoned) |

## Servers (separate services only, never linked)

| Server | License | Use |
|---|---|---|
| Stalwart Mail Server | AGPL-3.0 / SELv2 | JMAP integration test server (`tools/test-mail-servers/start-jmap.sh`). Built from source, run unmodified as a separate process. Test-only. |
| Radicale | GPL-3.0 | Lightweight CalDAV/CardDAV for tests. |
| Dovecot | MIT + LGPL-2.1 | IMAP server for the mail integration test (`tools/test-mail-servers`). Test-only. |
| aiosmtpd | Apache-2.0 | SMTP sink for the integration test. Test-only. |
| Nextcloud | AGPL-3.0 | Integration target only. |

## Watch-outs

1. **Open-core traps:** Tiptap Pro, Schedule-X Premium, FullCalendar Premium, Dexie Cloud, Ionic Appflow, and Hugeicons Pro are all paid. Stay on the MIT cores.
2. **MPL-2.0 files** (ical.js, uniffi, BlockNote core) are fine if we never patch them. Send fixes upstream.
3. **Stalwart:** the *server* is AGPL, but its *libraries* (mail-parser, calcard, jmap-client) are permissive.
4. **Dead or deprecated:** `@base-ui-components/react`, `vaul`, `rrule` (stale, time-zone bugs; do recurrence in Rust with calcard), the `wa-sqlite` npm package, and `tauri-plugin-keyring`.
5. **Font weight:** the full Material Symbols Rounded variable font is about 5.4 MB of woff2. Subset it before shipping (see [ADR-0003](decisions/0003-material-symbols.md)).
