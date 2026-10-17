# ADR-0054 · The menu-bar mini calendar (Phase 42)

- **Status:** Accepted. The parts that need a real desktop wait on a hardware check (see the checklist below).
- **Date:** 2026-10-17
- **Builds on:** [ADR-0010](0010-calendar-contacts.md) (calendar, quick add), [ADR-0016](0016-web-gateway.md) (one dispatcher, a `Host` per platform), [ADR-0030](0030-meeting-services.md) (Join)

Fantastical and Itsycal earned their place by answering "what's next?" without opening a calendar. This phase puts that in the desktop menu bar on macOS, and in the tray on Windows and Linux.

## Decisions

### An icon, a line of text, and a small window

- **The icon** is a calendar glyph:
  - **On macOS** it's a template image, so the menu bar draws it in its own ink, light or dark.
  - **On Windows and Linux** it's the app icon, which holds up on any taskbar.
- **Beside the icon**, the next event in a few words: "Design review in 25 min", "Standup now". This is on by default, and a switch turns it off for just the icon.
  - It shows in the macOS menu bar and on Linux panels that show a label.
  - Windows trays have no room for text, so the same words go in the icon's tooltip there.
- **A click opens the mini calendar under the icon,** or above it when the taskbar is at the bottom. Clicking away closes it. It's 360×600 and has:
  - today's date;
  - **Next up**, with its time, place, and Join;
  - the month, with a dot on every day that has something;
  - the picked day's events (a click opens the event in the app);
  - quick add ("Coffee with Marcus today 4pm"), the same field as in Calendar.
- **Right-click** gives Open Mailbird, New event…, and Quit Mailbird.

### What "next" means

- **The rule:** the event on now, or else the next to start in the next 12 hours. An event starting within 5 minutes beats the one that's on now, because that's the one you need to leave for.
- **Not counted:** all-day events and birthdays. They'd crowd out the meeting you're about to miss.
- **Relative words** ("in 25 min", "in 2 h 5 min", "now"). They need no clock format or time zone, and they read the same in every locale. The menu bar is brought up to date every 30 seconds.
- **One rule, written twice:** `pim_app::menu_bar::next_up` for the menu bar, and `nextUp` in the web panel. The Rust tests and the browser suite check the same cases, so the two can't drift silently.

### Closing the window keeps Mailbird running

- **While the menu-bar calendar is on, closing the main window hides it.** Mailbird stays in the menu bar or tray, so the calendar and reminders keep working. This is how menu-bar calendars behave, and it's spelled out under the switch in Settings.
- **Getting back:** click the Dock icon (macOS), choose Open Mailbird from the tray menu, or click an event in the mini calendar. Quit is in the tray menu, and the usual quit shortcut still works.
- **Safety:** closing only hides the window once the tray icon actually exists. A Linux desktop without a tray never ends up with a hidden window and no way back.

### Where the logic lives

- **`pim_app::menu_bar` decides what to show:**
  - the prefs (`menubar.prefs`, both on by default);
  - next up, and the words for it;
  - the tooltip.
- **The `Host` trait gains two hooks:** `menu_bar(state)` and `show_app(jump)`.
  - The desktop shell (`src-tauri/src/menu_bar.rs`) draws the tray, places the window, and brings the main window forward.
  - The gateway keeps the defaults: no tray, and a single window.
  - So nearly all of this is tested without a desktop.
- **The mini window is the same web app at `?mini`.** It opens events in the main window through `show_app`, which sends an `app:jump` event there.
  - In a browser (the demo, or the gateway) there's only one window, so the mini page opens the app page in its place, carrying the jump.
  - The main window opens the event, or the event editor for New event….
- **Settings:** "Calendar in the menu bar" and "Show the next event's name" sit under Accounts and settings, wherever the app runs on a device (not through a gateway).

## Verification

- **App** (`cargo test -p pim-app`):
  - next up: what counts, the 12-hour window, the 5-minute handover, and the relative words;
  - long names are shortened;
  - the state follows the prefs.
  - Through the dispatcher: the prefs default on, a change reaches the host at once, and `show_app` carries its jump to the host.
- **Desktop shell:** `cargo check` and `clippy -D warnings` pass on Linux with the tray feature. The macOS-only line (Dock reopen) can't be compiled here, because the sandbox has no Apple SDK.
- **Browser** (`phase42`, 22 checks):
  - **The mini calendar:** today's date, next up "in 10 min", "Now" during the event, the next event within 5 minutes, tomorrow's first event late at night, and "Nothing else" on a quiet evening.
  - **Using it:** Join, picking a day, and quick add.
  - **Opening the app:** an event opens on that event, Open Mailbird opens the app, and New event… opens the editor.
  - **Settings:** both switches, and the second hides with the first.
  - **Also:** dark mode, and no console errors.
- **Regression:** all earlier browser suites pass. `tsc -b`, `oxlint`, and `vite build` are clean. The ratchet is unchanged at 241 / 2 / 0 / 0.

## To check on real hardware

These need a desktop session, which the cloud sandbox doesn't have:

| # | Check | macOS | Windows | Linux (GNOME + AppIndicator, KDE) |
|---|---|---|---|---|
| 1 | The icon appears at launch, in the menu bar's own ink (light and dark menu bar) | ☐ | ☐ | ☐ |
| 2 | The next event's name and "in N min" sit beside the icon, and move on within 30 s | ☐ | n/a (tooltip) | ☐ (label) |
| 3 | A click opens the window under the icon (above it with a bottom taskbar), on the right monitor | ☐ | ☐ | ☐ |
| 4 | Clicking away closes it; clicking the icon again toggles it | ☐ | ☐ | ☐ |
| 5 | An event in the mini window opens the main window on that event | ☐ | ☐ | ☐ |
| 6 | Right-click: Open Mailbird, New event…, Quit Mailbird | ☐ | ☐ | ☐ |
| 7 | Closing the main window keeps Mailbird in the menu bar or tray; reminders still fire | ☐ | ☐ | ☐ |
| 8 | The Dock icon brings the window back | ☐ | n/a | n/a |
| 9 | Turning the switch off removes the icon, and closing the window quits again | ☐ | ☐ | ☐ |
| 10 | Without a tray (plain GNOME), nothing breaks, and closing the window quits | n/a | n/a | ☐ |

## Consequences

- **Closing the window no longer quits** while the calendar is on. Anyone who wants the old behavior turns the switch off. The note under the switch says so.
- **Two copies of the next-up rule** (Rust and TypeScript), kept honest by matching tests. Moving the panel's version to the core would cost the demo its own copy.
- **Follow-ups:** an icon that shows today's date, like Fantastical's; keyboard shortcuts to open the mini calendar from anywhere; and declined invitations dropping out of next up (occurrences don't carry your response yet).
