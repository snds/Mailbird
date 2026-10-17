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
| UI | React 19 · Vite 8 · Tailwind CSS v4 · **shadcn/ui** (Base UI, Nova) through **unicron**, the shared design system ([ADR-0047](docs/decisions/0047-unicron.md)) |
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

**Web vs. desktop.** On its own, the web app runs on sample mail, so you can try every flow. For real accounts in a browser, run the [web gateway](apps/gateway/README.md) on a machine you own: it syncs your accounts with the same code as the desktop app and serves the web app (`docker compose up -d` in `apps/gateway`).

**Mail integration tests (Linux).** These run real round trips against IMAP + SMTP and against JMAP:

```bash
sudo apt-get install -y dovecot-imapd && pip install aiosmtpd
sudo tools/test-mail-servers/start.sh
MAILBIRD_IT_SMTP_OUT=/tmp/mbtest/smtp-out cargo test -p pim-core --test imap_smtp -- --ignored

tools/test-mail-servers/start-jmap.sh      # builds Stalwart once (5–15 min), then starts it
cargo test -p pim-core --test jmap -- --ignored
```

The desktop shell needs [Tauri's prerequisites](https://v2.tauri.app/start/prerequisites/): WebView2 on Windows, Xcode CLT on macOS, and WebKitGTK plus libdbus on Linux (for the keychain).

### The design system (unicron)

Primitives and core tokens come from [unicron](https://github.com/snds/unicron), as the versioned packages `@unicron/ui` and `@unicron/tokens`, installed from its GitHub release tarballs ([ADR-0052](docs/decisions/0052-unicron-packages.md)). Mailbird's own roles are in `apps/web/src/styles/app-extension.css`. A new or changed primitive goes to unicron first: it ships in a release, and Mailbird moves to it by changing the version in two URLs (`apps/web/package.json`, and the tokens override in `pnpm-workspace.yaml`).

Components come from shadcn/ui through unicron's Material Symbols transform (`pnpm regen` in unicron; see its `tools/shadcn-material/README.md`).

Design-system analytics: `pnpm ds:scan`, `pnpm ds:patterns`, and `pnpm ds:ratchet` (CI fails if misuse of unicron components grows past `.dsa/baseline.json`).

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
| **5 · Mobile groundwork** ✅ | New mail on phones (periodic checks, or a self-hosted push relay in Docker), background pass and push seams, 10k-row virtualized list, keyboard-safe composer ([ADR-0015](docs/decisions/0015-mobile-groundwork.md), [relay](tools/push-relay/README.md)) |
| **5b · Device spike** | iOS and Android builds against ADR-0002's exit criteria ([checklist](docs/mobile-spike.md)), Capacitor fallback |
| **6 · Web gateway** ✅ | Real accounts in the browser through a self-hosted server (Docker): one command layer shared with the desktop app, password sign-in, live events, sealed secrets ([ADR-0016](docs/decisions/0016-web-gateway.md), [guide](apps/gateway/README.md)) |
| **7 · Mail power** ✅ | Send later, follow-up reminders (Waiting lane, "No reply yet"), one-tap unsubscribe, signatures and templates, ⌘K command menu ([ADR-0017](docs/decisions/0017-mail-power.md)) |
| **8 · Calm inbox** ✅ | The Screener for first-time senders, People / Updates / Newsletters from headers, screen out and block (archived on the server) ([ADR-0018](docs/decisions/0018-calm-inbox.md)) |
| **9 · Connected calendar** ✅ | Join buttons from meeting links, a Birthdays calendar from contacts, mail and meetings on each contact card, a second time zone, reminders missed while closed ([ADR-0019](docs/decisions/0019-connected-calendar.md)) |
| **10 · Contacts depth** ✅ | Contacts from email signatures (pasted or suggested under a message), labels, Recently deleted for 30 days, share as a vCard file or QR code ([ADR-0020](docs/decisions/0020-contacts-depth.md)) |
| **11 · Calendar planning** ✅ | Clashes on every invitation, propose a new time (iTIP COUNTER) and answer proposals, find a time in your calendars, calendar sets ([ADR-0021](docs/decisions/0021-calendar-planning.md)) |
| **12 · Inbox your way** ✅ | Split inboxes from your own rules (senders, domains, subject words), kept out of All or not; newsletters folded into one row with mark-all-read and archive-all ([ADR-0022](docs/decisions/0022-inbox-your-way.md)) |
| **13 · Contacts that look after themselves** ✅ | Smart groups from rules (labels, company, domain, phone, birthday, in touch lately), restore contacts to a point in time with a preview and Undo, conversations that survive a server move ([ADR-0023](docs/decisions/0023-contacts-that-keep-themselves.md)) |
| **14 · Interesting calendars** ✅ | National holidays for 13 countries and moon phases, computed on the device (nothing fetched), shown like any read-only calendar ([ADR-0024](docs/decisions/0024-interesting-calendars.md)) |
| **15 · One action grammar** ✅ | Configurable swipes (short and long, each way) from one shared action vocabulary, saved in the core so every device agrees; a Shortcuts and gestures list on ?, ⌘K, and Settings ([ADR-0025](docs/decisions/0025-one-action-grammar.md)) |
| **16 · Scheduling links** ✅ | Booking links whose public page (served by the web gateway) shows only your free times; a booking lands in your calendar and invites the booker from mail-account calendars ([ADR-0026](docs/decisions/0026-scheduling-links.md)) |
| **17 · Faces and sources** ✅ | Contact photos (resized on the device, synced in the vCard), a source badge on every row, "Also in" links to the same person in other address books, and contact photos as sender faces in mail ([ADR-0027](docs/decisions/0027-faces-and-sources.md)) |
| **18 · Tasks on the calendar** ✅ | Checklist items from every note listed beside the calendar, planned into free time as linked blocks, checked off from either side; checked items move down their list ([ADR-0028](docs/decisions/0028-tasks-on-the-calendar.md)) |
| **19 · Travel and time zones** ✅ | Travel time before events (the same property Apple Calendar uses), drawn above the event and counted as busy, with a "time to leave" alert; events set in another time zone, showing what that is on your clock ([ADR-0029](docs/decisions/0029-travel-and-time-zones.md)) |
| **20 · Meeting services** ✅ | Calls read from the invitation (Zoom, Meet, Teams, Webex, and more: link, meeting ID, passcode, one-tap dial-in), Join in the service's app or the browser, Calendly and Cal.com reschedule and cancel links, Add video call (Jitsi) ([ADR-0030](docs/decisions/0030-meeting-services.md)) |
| **21 · Change a booking** ✅ | Everyone who books gets a private link to pick a new time or cancel (on the confirmation, and in the invitation when the gateway knows its address); the event moves or goes, and the guest's invitation follows ([ADR-0031](docs/decisions/0031-change-a-booking.md)) |
| **22 · Your keys** ✅ | Every single-key shortcut in Mail and Calendar can be changed (press the key, then the new one); a key that's taken swaps, swipe-only actions can get keys, and your keys follow you to every device ([ADR-0032](docs/decisions/0032-your-keys.md)) |
| **23 · Regional holidays** ✅ | Pick a region of an added country (40 across Germany, the UK, Canada, Australia, France, and Portugal) to see its own days too, still computed on the device; the calendar takes the region's name, and each day says whether it's regional ([ADR-0033](docs/decisions/0033-regional-holidays.md)) |
| **24 · Connected notes** ✅ | `[[Links]]` between notes (type `[[` to pick one, or link a note that doesn't exist yet), "Linked from" on every note, and every note exported as Markdown files with front matter that Obsidian opens as-is ([ADR-0034](docs/decisions/0034-connected-notes.md)) |
| **25 · Links that keep up** ✅ | Rename a note and it offers to update every `[[link]]` to it (through each note's own sync document, so edits merge); link a note to an event, person, or conversation from the note itself ([ADR-0035](docs/decisions/0035-links-that-keep-up.md)) |
| **26 · Who's writing** ✅ | A sender profile beside every conversation (a sheet on narrow screens): their card or their name, email/call/message, how long you've heard from them, meetings and other mail together, and their notes ([ADR-0036](docs/decisions/0036-sender-profile.md)) |
| **27 · Quick Note** ✅ | Jot a note from anywhere (⌥N, ⌘K, or a Notes section) without leaving what you're doing, already linked to the conversation, event, or person that's open; it saves when you close it ([ADR-0037](docs/decisions/0037-quick-note.md)) |
| **28 · Note cards** ✅ | Notes as Keep-style cards that fill the window (one tap between cards and rows), ten colors that sync, import from Keep, and export with the note, tinting the open note in light and dark ([ADR-0038](docs/decisions/0038-note-cards.md)) |
| **29 · Note reminders** ✅ | "Remind me" on any note (Later today, Tomorrow, or any time): a notification when it's due, even if Mailbird was closed, and the note waits at the top of Notes until you mark it done ([ADR-0039](docs/decisions/0039-note-reminders.md)) |
| **30 · Their local time** ✅ | The sender profile shows what time it is for them, live, with how far ahead or behind you they are and a word when it's night or the weekend there, read from the time zone on their own mail (never a newsletter's) ([ADR-0040](docs/decisions/0040-sender-local-time.md)) |
| **31 · Their time when you write** ✅ | Writing to someone where it's night or the weekend, the composer says so and offers to send at 9:00 AM their time (their next workday); Send later lists their morning too, with your time beside it ([ADR-0041](docs/decisions/0041-their-time.md)) |
| **32 · Smart folders** ✅ | Saved searches in Notes (tags, words, links, color, a reminder, to-dos left) that fill and empty themselves, with live counts; searching inside one narrows it, and deleting one leaves its notes ([ADR-0042](docs/decisions/0042-smart-folders.md)) |
| **33 · Locked notes** ✅ | One passphrase (never stored) seals a note's text with AES-256-GCM on the device and in sync, and the relay keeps no readable copy; the title stays visible, search and export skip the text, and notes lock again after 10 idle minutes ([ADR-0043](docs/decisions/0043-locked-notes.md)) |
| **34 · Images in notes** ✅ | Add, paste, or drop photos into a note (shrunk to 2048 px), describe them for screen readers, and see the first one on its card; they sync on their own, seal with locked notes, come along from Obsidian, Bear, Apple Notes, and Keep imports, and export to `attachments/`; web images load only when asked ([ADR-0044](docs/decisions/0044-images-in-notes.md)) |
| **35 · Scans and text in images** ✅ | Scan a page from a photo (found, straightened, and cleaned to white paper and black ink), and the text in every note image is read on the device so search finds it; copy it or add it to the note; sealed with locked notes ([ADR-0045](docs/decisions/0045-scans-and-text-in-images.md)) |
| **36 · Sketches** ✅ | Draw in a note with a pen (its pressure shapes the line), a finger, or a mouse: pens, see-through markers, an eraser, undo, and more room; sketches save as SVG you can edit again, sit on light paper in both themes, and the core keeps only SVG the app drew ([ADR-0046](docs/decisions/0046-sketches.md)) |
| **37 · Shared design system** ✅ | Primitives and core tokens come from unicron, the system Mailbird shares with Synapse and Lockdown; nothing on screen changed, and `dsa` now measures how the app uses it ([ADR-0047](docs/decisions/0047-unicron.md)) |
| **38 · Design-system cleanup** ✅ | What the first scan found went upstream as named choices (an icon button that's always labelled, pill chips, quiet ghost buttons, icon tones, a full-screen phone sheet, and dialog actions that become a row of icon buttons on phones); menus are frosted glass everywhere, every filter row shares one chip recipe, and the ratchet is lower ([ADR-0048](docs/decisions/0048-design-system-cleanup.md)) |
| **39 · The identity holds the notes key** ✅ | Locked notes keep their passphrase, and the key is also kept in the shared identity, so it can open them instead (and its recovery kit can reach them); on desktop, with nothing moved or resealed ([ADR-0051](docs/decisions/0051-identity-holds-the-notes-key.md)) |
| **40 · The design system as packages** ✅ | unicron now arrives as versioned releases (`@unicron/ui` 0.2.0, `@unicron/tokens` 0.1.0) instead of a submodule: a plain clone builds, and moving to a new release is a version change; nothing on screen changed ([ADR-0052](docs/decisions/0052-unicron-packages.md)) |
| **41 · Map of notes** ✅ | An optional map of your notes and their `[[links]]`, with the events, people, and conversations they link to, so notes about the same meeting or person meet there; it follows search, tags, and folders, holds still once laid out, and works by keyboard and screen reader ([ADR-0053](docs/decisions/0053-map-of-notes.md)) |
| **42 · Menu-bar calendar** ✅ | What's next, from the menu bar (macOS) or tray (Windows, Linux) without opening the app: "Design review in 25 min" beside the icon, and a click opens today, the month, the day's events with Join, and quick add; closing the window keeps it running there ([ADR-0054](docs/decisions/0054-menu-bar-calendar.md)) |
| **43 · Power settings** ✅ | Advanced mail settings for the choices most people never touch: when remote images load (ask, from contacts, always), when opening marks mail read (at once, after 3 seconds, or only when you say), whether replies quote and write above or below, read receipts to ask for (Mailbird never sends them), and how often to check ([ADR-0055](docs/decisions/0055-power-settings.md)) |
| **44 · Shared notes** ✅ | Share a note by link: the other person sees it in their Mailbird and you both type at once, or they read along with view-only. It goes through your own notes relay, works for people without one, can be stopped any time (they keep a copy), and a link in mail opens with one click ([ADR-0056](docs/decisions/0056-shared-notes.md)) |

## License

[Apache-2.0](LICENSE). Third-party notices are in [NOTICE](NOTICE).
