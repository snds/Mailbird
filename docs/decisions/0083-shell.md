# ADR-0083 · The shell on unicron's frame: sidebar, status line, the phone's floating rows

- **Status:** Accepted for the build. Four parts are proposals for Sean, each marked below: the three width classes, DC12 (no toast for an update), DC14 (⌘, and ⌘\), and what the sidebar's collapse replaces in ADR-0073.
- **Date:** 2026-11-14
- **Builds on:** [ADR-0082](0082-unicron-1-0.md) (unicron 1.0), [ADR-0081](0081-harness-and-scenarios.md) (screenshots by area, demo scenarios), [ADR-0075](0075-settings-page-and-shortcuts.md) (Settings as a page), [ADR-0073](0073-icons-by-code-point-and-the-rail.md) (the rail and the floating "new"), [ADR-0063](0063-shared-inbox.md) (a team member has Mail only), [ADR-0032](0032-your-keys.md) (keys)

ADR-0082 put every screen on the new look in its old layout. This is the first step of the new layout: the shell around the four sections. It is built from unicron 1.0's frame parts, as Figma draws it at 390 and 1440 (Mobile / 01, Desktop / 01, States / 02 and 03). Each section's own screens keep their old content inside it; their lanes rebuild them next.

## Decisions

### One tree of frame parts, three widths

- **`AppShell` is one `AppFrame`** holding the sidebar, the status line, the phone's top and bottom rows, the content, quick create and the Toaster (`apps/web/src/app/shell.tsx`, with `sidebar.tsx`, `status-line.tsx`, `phone-chrome.tsx`, `quick-create.tsx`). The frame picks the shell from the window's width, so the shell has **no media query and no CSS of its own**. `--c-shell-rail-*`, `--c-shell-tabbar-height` and `--c-shell-active-indicator` are gone.
- **The width classes are unicron's** (a proposal: the designs name only 390 and 1440):

  | Class | Width | Shell |
  |---|---|---|
  | compact | under 600 | the phone's floating rows |
  | medium | 600 to 1023 | the sidebar as its rail, one content column, a pushed detail |
  | expanded | 1024 and up | the sidebar, the status line, list beside detail |

  A short screen (a phone on its side, a folded phone) stands the bottom row as a column at the trailing edge with the tab bar turned. That is the frame's rule; Vale adds none.
- **`useIsTabletUp` (768 px) is gone,** and `hooks/use-media-query.ts` with it. The editors (`editor-frame.tsx`), the composer and the calendar read the frame: a full-screen sheet in the phone's shells, a dialog from medium up; the calendar shows an event beside the grid only when list and detail stand side by side. `openSettings()` picks its default from the width class too: the first section where list and section stand side by side, the list of sections where a section is a pushed screen.
- **The views' own `md:` and `sm:` classes stay** until each lane rebuilds its screen. None was added.

### Expanded: the sidebar and the status line

- **The sidebar** (204 wide, a `nav` named "Vale"), top to bottom:
  1. The lockup.
  2. The open section's create button, full width: COMPOSE, NEW EVENT, NEW CONTACT, NEW NOTE. On Settings it keeps the last section's.
  3. **Search**, with the person's search key (`/`) in its mark. Until Search is a place of its own it opens the command menu.
  4. **APPS // 04**: Mail, Calendar, Contacts, Notes. No counts: the core has no unread or event count to show.
  5. The open section's own groups (`section-groups.tsx`). Empty for now; the lane that builds each section's second level fills it. This part scrolls.
  6. **Settings**, pinned at the foot, beside the collapse control.
- **One item is current:** the open section, or Settings. A place that is no nav item marks none.
- **The collapse replaces ADR-0073's rail toggle.** The sidebar collapses to its rail by choice (the control at its foot, or ⌘\) and the choice is still kept per device under `vale.nav.expanded`. What changes from ADR-0073: the widths are unicron's (204 and 48, not 11rem and 4.5rem); with no choice saved it starts full at every expanded width; at medium width it is always the rail, and expanding it there lays the full sidebar over the content as a drawer. ADR-0073's floating "new" is gone: create is the sidebar's button and the phone's bottom-row button.
- **The Tauri window keeps the system's title bar,** so the lockup needs no inset for the macOS window buttons (`leadingInset` is not set).
- **The status line:** the breadcrumb `SECTION // PLACE` at the start, the section a way back to its first screen; the screen's own fact at the end. Each view says both (`app/screen.ts`: `useScreenPlace`, `useScreenFact`):

  | Section | Place | Fact |
  |---|---|---|
  | Mail | the lane | `SYNCED // 09:16`, from the oldest `lastSync` of the accounts shown |
  | Calendar | the view | its range |
  | Contacts | the label or group, or "All contacts" | `148 PEOPLE`, the list's real length |
  | Notes | the folder, or "All notes" | `EDITED 08:40`, the newest note's time |
  | Settings | the section | none |

  No unread counts anywhere: the core has none.
- **List and detail** are the frame's columns (`components/master-detail.tsx`): the list 432 wide, the detail beside it, and "Nothing open." with "Pick a … to see it here." until something is picked. `PaneHeader` gives way to unicron's page head through `components/page.tsx` (`ScreenHead`: overline, title, meta, count, actions, a switcher slot, and what sits under the head). The whole list column scrolls now, its head included.
- **The page heads say what is true:** Mail `{LANE} // {ACCOUNT}` over the lane's name (the Inbox keeps the drawn "Today" and its date); Contacts `CONTACTS // 148` over "People"; Notes `NOTES // 24` over "Notes"; Settings over "Settings"; Calendar over its range.

### Medium: the rail

- The sidebar is its rail: the mark, the create button as an icon, Search, the four sections, Settings, and the expand control.
- One content column. Picking an item pushes the detail over the list, which keeps its place. The way back is a button in the status line's leading slot; the breadcrumb stays.

### Compact: the phone's floating rows

- **Top row:** the lockup, and a **Settings** button (`user--avatar`) that pushes Settings. It replaces Mail's "Accounts and settings" button, so Settings is now one tap from every section.
- **Bottom row:** Search; a tab bar of four icon-only tabs; the open section's create button (`edit` in Mail, `add` elsewhere).
- **A second tap on the active tab** goes back to the section's first screen, scrolls to the top and reads again. In Mail the first screen is the Inbox.
- **Scrolled** (States / 02): the lockup is its mark, the place is a small centred title over a hairline, the tab bar shrinks to the active tab, and the place strip joins the bottom row. The strip is `{LANE} // {ACCOUNT}` over the newest conversation's subject (`usePlaceStrip`), with no unread count. Only Mail sets one so far.
- **A pushed screen** (an open item, Settings) gets the top bar with Back. Its own actions and its bottom row come from the lane that owns it (`usePushedChrome`); none is set yet, so an open item keeps the action bar it had inside its pane. Settings and full-screen forms have no bottom row.
- **Pull to refresh** runs what the view registered (`useRefresh`): Mail checks its servers on the desktop core and reads its list again on a gateway; the others read their lists again.

### Quick create

- **The menu** (States / 03): `CREATE // LONG PRESS`, then New message, New event, New contact, New note, and **Quick note**, named for what is open ("Quick note about Design crit"). Each runs the same create flow as the command menu's CREATE group. A team member gets New message only: the rest is the owner's.
- **How it opens.** Phone: a long press or a swipe up on create; Shift+Enter, the Menu key and a right-click do the same, so it is never gesture-only. Desktop and rail: a right-click, the Menu key or Shift+F10 on the sidebar's create button; there the label reads `CREATE // RIGHT-CLICK`. ⌘K's CREATE group stays the keyboard's way to the same creates.
- **While it is open** the create button shows close, and the page is under the 32% menu scrim.
- **A plain tap or click still makes the open section's item.**

### Limited shells

- **A team member** (`isMember()`): Mail only. The sidebar has no APPS group, and the phone has no tab bar (a tab bar with one section draws nothing). Search and create stay.
- **The demo app** (`VITE_DEMO_APP=1`): a compact info banner on every screen, pushed ones too. On a desktop it is pinned above the status line; on a phone it stays under the top row while the page scrolls. "You're exploring the demo. Nothing here is real." with **RESET THE DEMO**, today's reset. It cannot be dismissed. The word is "Reset", not the cross-app "Leave": Vale's demo has nowhere to leave to.

### Updates: a mark, not a toast (DC12, proposal)

An update that is ready shows as a square mark on the way into Settings: the sidebar's item, the rail's item and the phone's top-right button, with "Update ready" in the control's name (`app/update-mark.ts`, from `features/updates/use-updates`). This slice adds the mark and removes nothing: what ADR-0076 and ADR-0077 show today stays until the settings lane builds About, and that lane records DC12 in full.

### Keys (DC14, proposal)

- **⌘, opens Settings** and **⌘\ collapses or shows the sidebar** (at medium width it opens and closes the drawer). They are fixed, like ⌘K.
- `?`, ⌘K and ⌥N are unchanged. DC14 is recorded in full, with the keys list, by the lane that rebuilds it.

### Settings covers the section and lets go of the frame

ADR-0075 keeps the open section mounted under Settings, so coming back finds it as you left it. It still does, now through React's `Activity`: hidden, the section keeps its state and its scroll place and lets go of its effects, so the frame's columns, page head and way back are Settings' alone meanwhile. One consequence: a note made a moment ago is closed when Settings opens, as it is on leaving Notes (empty, it is thrown away; written in, it is in the list).

### First run and adding an account have one door each

`features/onboarding/first-run-gate.tsx` stands between the gateway's door and the app and passes the app through for now. `start-add-account.ts` exports `startAddAccount()` (a section's "Add an account…", the command menu) and `startFirstRun()` (Mail's "Add account" for someone with none). Both open Settings › Accounts until their lanes build the provider list and first run.

## Scenes

- The navigation helpers follow the new shell: `area` uses the sidebar, the rail or the tab bar, and backs out of a phone's pushed screen first; the way into Settings is named "Settings".
- New scenes in `tools/screenshots/scenes/shell.mjs`, each with its checks: `shell-scrolled`, `shell-quick-create` (phone), `shell-quick-create-desktop` (desktop and rail), `shell-member`, `shell-demo`, `shell-medium`, `shell-landscape`, `shell-update-mark` and `shell-navigation`.
- A scene of the demo app itself takes `demo: true` and runs only with `--demo`.
- A new demo scenario, `update-ready`, in `core/demo-scenarios/shell.ts`.

## The ratchet

The local `AreaEntry`, `NavRail`, `PhoneAreas`, `Fab` and `RailTip` are gone, with the old pane header and the empty pane. className overrides **137 → 131**; plain `<button>`s **16 → 15**; style overrides 1; look-alikes 0.

## Verification

- `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm --filter web build:demo`, the notes-relay tests.
- `pnpm shots`: every scene at phone and desktop, on graphite and stone; then `--size medium -g shell -g mail-inbox`, `--size landscape -g shell` and `--demo -g shell-demo`.
- The phone and desktop inbox beside Figma's Mobile / 01, Desktop / 01, States / 02 and States / 03.

## Not in this slice

- Each section's second level in the sidebar and under the page head (the lanes' own).
- Search as a place; live status in the strip and the status line; each pushed screen's own top-bar actions and bottom row.
- `SettingsFrame`, About, and removing the update toasts.
