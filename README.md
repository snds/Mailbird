# Mailbird _(working name)_

**One calm, ad-free app for mail, calendar, contacts, and notes, on every platform.** It is mobile-first and runs on the web, Windows, macOS, Linux, iOS, iPadOS, and Android, built from permissively licensed open-source parts.

> ⚠️ **"Mailbird" is a placeholder.** It collides with an existing commercial email client. See [ADR-0006](docs/decisions/0006-product-name.md).

## Why

- **Windows mail is ads or archaeology.** Outlook's free tier shows ads, and Thunderbird's UX is dated.
- **The best-designed apps don't travel.** Apple's apps stop at Apple devices, and Fantastical and Cardhop skip Android.
- **Nobody combines all four** (mail, calendar, contacts, notes) in one well-designed, provider-agnostic, open-source app.

Full research: [competitive analysis](docs/research/competitive-analysis.md).

## Principles

1. **One capture surface, four destinations.** Natural-language quick-add routes to an event, contact, note, or message.
2. **Cross-vertical objects are the product.** Meeting notes attach to their event, and a contact card shows your threads.
3. **Calm by default.** A screener for new senders, bundles, tracker blocking, and no ads ever.
4. **Keyboard-first on desktop, thumb-first on phone, one action grammar.**
5. **Honest capability states.** Each account's provider limits are shown, never hidden.
6. **Local-first and portable.** Markdown notes, full export, and mail kept on your device.

## Stack

| Layer | Choice |
|---|---|
| UI | React 19 · Vite 8 · Tailwind CSS v4 · **shadcn/ui** (Base UI, Nova) |
| Icons | **Google Material Symbols** (Rounded variable font, live axes) |
| Shells | **Tauri 2** (desktop now, mobile spike) · PWA for the web |
| Core | Rust `pim-core`: IMAP/SMTP, Gmail API, Graph, JMAP, CalDAV/CardDAV, SQLite, Tantivy |

Every shipped dependency is MIT, Apache-2.0, BSD, or ISC. See [docs/oss-stack.md](docs/oss-stack.md) for versions, licenses, and open-core traps to avoid. Architecture: [docs/architecture.md](docs/architecture.md).

## Getting started

```bash
pnpm install
pnpm dev                    # web app at http://localhost:5173
pnpm build                  # type-check + production build
cargo test -p pim-core      # Rust core
pnpm tauri dev              # desktop shell (needs the Tauri prerequisites for your OS)
```

**Web vs. desktop.** In a browser the app runs on sample mail, so you can try every flow. Connecting real accounts needs the desktop app: iCloud, Fastmail (JMAP), or any IMAP/SMTP or JMAP server, with calendars and contacts over CalDAV/CardDAV. Gmail and Outlook need OAuth, which is Phase 4.

**Mail integration tests (Linux).** These run real round trips against IMAP + SMTP and against JMAP:

```bash
sudo apt-get install -y dovecot-imapd && pip install aiosmtpd
sudo tools/test-mail-servers/start.sh
MAILBIRD_IT_SMTP_OUT=/tmp/mbtest/smtp-out cargo test -p pim-core --test imap_smtp -- --ignored

tools/test-mail-servers/start-jmap.sh      # builds Stalwart once (5–15 min), then starts it
cargo test -p pim-core --test jmap -- --ignored
```

The desktop shell needs [Tauri's prerequisites](https://v2.tauri.app/start/prerequisites/): WebView2 on Windows, Xcode CLT on macOS, and WebKitGTK plus libdbus on Linux (for the keychain).

### Adding shadcn components

The shadcn CLI can't install Material Symbols, so components come through a local transform:

```bash
git clone --depth 1 https://github.com/shadcn-ui/ui /tmp/shadcn
node tools/shadcn-material/transform.mjs /tmp/shadcn apps/web/src/components/ui calendar command drawer
```

If a component uses a Lucide icon that isn't mapped yet, the script stops. Add the mapping to `tools/shadcn-material/icon-map.json`.

## Roadmap

| Phase | Scope |
|---|---|
| **0 · Foundation** ✅ | Adaptive shell, tokens, shadcn + Material Symbols pipeline, Tauri desktop shell, capability matrix |
| **1 · Mail MVP** ✅ | IMAP/SMTP adapters, local store + FTS5 search, unified inbox lanes, composer, undo send, snooze, archive, tracker-safe HTML, keychain ([ADR-0007](docs/decisions/0007-mail-engine.md)) |
| **1b · Mail depth** ✅ | Conversations, attachments, IMAP IDLE push, progressive backfill, JMAP sync + send, swipe gestures ([ADR-0008](docs/decisions/0008-mail-depth.md)) |
| **1c · Mail polish** ✅ | JMAP push, Sent/Archive sync-back, rich-text composer, attachment previews ([ADR-0009](docs/decisions/0009-mail-polish.md)) |
| **2 · Calendar + Contacts** ✅ | CalDAV/CardDAV sync, agenda/day/week views, natural-language quick add, event and contact editors, duplicate merge, recipient autocomplete ([ADR-0010](docs/decisions/0010-calendar-contacts.md)) |
| **2b · Calendar depth** ✅ | Month view, edit one occurrence or this-and-following, reminders with desktop notifications, meeting invitations (answer, send, cancel) ([ADR-0011](docs/decisions/0011-calendar-depth.md)) |
| **3 · Notes** ✅ | Tiptap editor with checklists, Markdown storage, live Yjs sync through a self-hosted relay, links to events, people, and conversations, Apple Notes/Keep/Markdown import ([ADR-0012](docs/decisions/0012-notes.md)) |
| **4 · Google** ✅ | Browser sign-in (OAuth + PKCE), Gmail API sync and send, Google Calendar and Contacts over CalDAV/CardDAV, verification checklist ([ADR-0013](docs/decisions/0013-google.md), [guide](docs/google-verification.md)) |
| **4b · Microsoft** ✅ | Outlook and Microsoft 365 sign-in, Graph mail sync and send, Outlook calendars and contacts translated to iCalendar and vCard ([ADR-0014](docs/decisions/0014-microsoft.md), [guide](docs/microsoft-setup.md)) |
| **5 · Mobile** | Tauri mobile spike → iOS/Android builds (Capacitor fallback) |

## License

[Apache-2.0](LICENSE). Third-party notices are in [NOTICE](NOTICE).
