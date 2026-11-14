# ADR-0084 · Places: one per section, in the store, the nav and the history

- **Status:** Accepted for the build. One part is a proposal for Sean, marked below: DC7 (sets, Tasks and Booking links leave the calendar's side list for the calendars list and two places).
- **Date:** 2026-11-14
- **Builds on:** [ADR-0083](0083-shell.md) (the shell; it left a slot for each section's groups), [ADR-0075](0075-settings-page-and-shortcuts.md) (Settings as a page), [ADR-0073](0073-icons-by-code-point-and-the-rail.md) (the rail by choice), [ADR-0063](0063-shared-inbox.md) (a team member has Mail only), [ADR-0021](0021-calendar-planning.md) (calendar sets), [ADR-0028](0028-tasks-on-the-calendar.md) (tasks), [ADR-0026](0026-scheduling-links.md) (booking links).
- **Design:** the Folders sheet (Mobile / 05) and the sidebar groups of Desktop / 01, 06, 09 and 11; briefs X1, 3.1, 3.3 and 3.5 of the undrawn-areas design.

ADR-0083 built the shell around the four sections. Inside a section you still moved by tabs, chips, a select and a More menu in each view's header, and by a side list in Calendar. This makes each of those a **place**, lists them in one nav list per section, and shows that list where the width has room for it.

## Decisions

### What a place is

- **One place per section, plus Search and Settings** (`apps/web/src/app/places.ts` names them; `app/ui-store.ts` holds them):

  | Section | Place |
  |---|---|
  | Mail | a lane (`mailTab`), narrowed by an account (`mailAccount`, null for all) and, in the Inbox, by a category or a split |
  | Calendar | the calendar itself, in the range this device shows; or Tasks; or Booking links (`calendarPlace`) |
  | Contacts | everyone, a label, a smart group, Duplicates, or Recently deleted (`contactsPlace`) |
  | Notes | all notes, Pinned, a smart folder, or the Archive, narrowed by one tag (`notesPlace`). List, cards or map stays the core's `NotesPrefs` |
  | Search | scope, words, and the section it was opened from (`search`). The search lane fills it; until then Search is the command menu |
  | Settings | the section (`settings`), as before |

- **A place is what a nav item stands for.** The one current item of a nav list is read from the place, and only a place carries `aria-current`. A filter has a role of its own: Mail's accounts are a radio group named "Account", the calendars and the note tags are checkboxes.
- **One current item per nav list.** In the sidebar it is the place's own row in the section's group (Inbox, All contacts, Tasks). Calendar's ranges have no row, so "Calendar" under Apps stays current there. On Settings, only Settings. In the rail, the section.
- **A place that is gone falls back to the section's first:** a lane that no longer shows (the Screener turned off), an account removed, a label whose last card lost it, a deleted smart group, folder or tag. The store keeps what was asked for; `use-mail-place.ts`, `use-contacts-place.ts` and `use-notes-place.ts` work out what stands, and the nav and the view both read that.
- **Opening a section opens its first place.** `setVertical` resets every section's place, as leaving a section did before. `jumpTo`, `openNote`, `showTeam`, `showMailTab`, the composer and editor flags, and Settings hiding the section without unmounting it, all behave as they did.
- **Pinned is narrowed in the view.** The core has no query for it; the notes read is the same and the view keeps the pinned ones.
- **The calendar's range is kept per device** (`features/calendar/view-prefs.ts`, key `vale.calendar.view`), with whether the week and day draw hours, which the calendar lane reads when it builds the card week. With nothing saved it is the agenda on a phone and the week from medium up, as before. It used to reset each time Calendar opened.

### The second level of each section

Each lane owns its list (`features/<area>/<area>-nav.tsx`), built from unicron's `NavSection` and `NavItem`:

| Section | Groups |
|---|---|
| Mail | MAIL // FOLDERS: Inbox, Screener (while it is on or open; its mark is the senders waiting), Unread, Starred, Snoozed, Waiting, Scheduled, Archive. TEAM: Assigned to me (with a shared inbox), Team (not for a team member). ACCOUNTS // NN, from two accounts: All, each account (critical while its last sync failed), then "Add an account…". No Drafts, Sent or Spam: the core has none |
| Calendar | One group per account, then ON THIS DEVICE and HOLIDAYS AND MORE: a checkbox per calendar with its swatch, "Read-only" under one that is. The first group's header holds Add calendars. SETS: a radio per set (the one showing is checked), each with Delete; then "Save as set…". PLAN: Tasks, Booking links |
| Contacts | GROUPS // NN: All contacts with its count, each label with its count, each smart group with its count and an edit action, "New smart group…". CLEAN UP: Duplicates (its mark is the sets), Recently deleted, Restore contacts |
| Notes | FOLDERS // NN: All notes, Pinned, each smart folder with its count and an edit action, "New smart folder…", Archive, "Open a shared note…". TAGS // NN: a checkbox per tag, one at a time; the one in force clears on a second pick |

- **A calendar's swatch** is the one of unicron's twelve nearest its server color in OKLCH hue (`features/calendar/swatches.ts`). Two calendars on one swatch: the later takes the next free one. No color: no square.
- **Where the list shows:**
  - **Expanded, with the sidebar full:** the sidebar's section slot (`app/section-groups.tsx`). It shows on Settings too; picking a row leaves Settings.
  - **A phone:** the page head is one button (`PageHead switcher`), and so is the small title it collapses to. It opens a bottom sheet with a Sheet Header: the section and the filter in force as the overline (`MAIL // PERSONAL`), and "Folders", "Calendars" or "Groups" as the title. The sheet's header names the first group, so that group has no overline of its own there, as Mobile / 05 draws it.
  - **Medium width, and beside the rail by choice:** the same button opens a popover under the head, 320 wide.
- **Picking a place closes the layer;** so does picking an account, a tag or a view. Toggling a calendar does not. A row that opens a form closes the layer first.
- **The phone sheet ends with MORE** where the section has something for it: Mail's LAST CHECKED with CHECK AGAIN on the desktop core (the plain path for pull to refresh), Notes' VIEW chips LIST · CARDS · MAP.
- **In the layer, Calendar's PLAN group starts with "Calendar"**, so there is a row to return by from Tasks or Booking links. The sidebar has "Calendar" under Apps for that.
- **A sideways swipe on Mail's page head steps the account:** All, then each. The arrow keys do the same while the head has focus. Both are the page head's own.
- **The sidebar's collapse choice moved into the store** (`sidebarCollapsed`, still saved as `vale.nav.expanded`), because the page head must know when it stands beside a rail.

### What left the views

Nothing is dropped; each has a new home.

| Was | Is |
|---|---|
| Mail's lane tabs and account select | MAIL // FOLDERS, TEAM and ACCOUNTS. The category and split chips stay in the view |
| Contacts' label chips, smart-group chips and the Restore button | GROUPS and CLEAN UP |
| Contacts' duplicates and deleted panes in the detail column | Places: each has the list's room and its own page head |
| Notes' folder chips, tag chips, "Archived notes" and "Open a shared note…" | FOLDERS and TAGS. The More menu keeps Import, Export, Sync and the two switches |
| Calendar's side list and the phone's Calendars sheet | The calendars list. Tasks and Booking links are places: today's panels in the list column, or the screen under 768 px |
| The mini month and the desktop's Quick add | The top of Calendar's list column, until the calendar lane's Go to date and form helper replace them. Under 768 px Quick add stays under the head, and there is no mini month, as before |
| "Calendars didn't sync" lines | The top of the calendar view, until the status lane's banner takes them |
| The second time zone | Settings › Calendar |
| "Save what's showing as a set", typed in the side list | "Save as set…" opens a one-field form (question size; a sheet on a phone) |

### DC7 (a proposal): sets, Tasks and Booking links leave the calendar's side list

ADR-0021, ADR-0028 and ADR-0026 put sets, tasks and booking links beside the calendar, in one side list. The design gives the sidebar to the calendars and has no side list. This build moves sets into the calendars list and makes Tasks and Booking links places of Calendar. **Question for Sean:** is that right, or should Tasks stay in view beside the week?

### History

- **A change of place is a history entry,** and so is a screen pushed over a list where list and detail do not stand side by side (compact and medium). So the browser's and the phone's Back go back one place, or close what is open. Only `history.state` changes; the address never does (`places.ts`: `watchPlaces`, `usePushedScreen`).
- **A place comes back as it was left.** What was open over it is not reopened.
- **Closing a pushed screen by its own Back takes its entry away,** and an entry of a screen that has closed another way is passed over, so Back never lands on nothing.
- **Settings' own Back is the browser's Back** when the place behind is where it would go (`stepBack`).
- **Not in the history:** the search words in a list's field, what is open at the expanded width, sheets and dialogs.

### Intents

Four things other lanes and the command menu must open were local state in a view. Each is now a small store in its area's folder; the area's view mounts what it opens, and the intent shows that section first:

| Intent | Opens |
|---|---|
| `openSyncSetup()` (`features/notes/open-sync-setup.ts`) | Notes, and today's relay dialog |
| `openSharedNote()` (`features/notes/open-shared-note.ts`) | Notes, and the link form |
| `openRestoreContacts()` (`features/contacts/open-restore.ts`) | Contacts, and the restore form |
| `openAddCalendars()` (`features/calendar/open-add-calendars.ts`) | Calendar, and the holidays picker |

The smart group form, the smart folder form and "Save as set…" open the same way (`open-smart-group.ts`, `open-note-folder.ts`, `use-sets.ts`).

## Consequences

- **Ratchet:** className overrides 131 → 130. Style 1, spread 0, plain buttons 15, look-alikes 0, unchanged.
- **Scenes:** the area helpers (`lane`, `calendars`) go by the nav list: the sidebar, or the page head's layer. New helpers `groups`, `pick`, `switcher`, `oneCurrent`, `goBack`. New scenes: `mail-folders-sheet`, `contacts-groups-sheet`, `notes-folders-sheet`, `switcher-medium`, `places-tasks`, `places-booking-links`, `places-duplicates`, `places-recently-deleted`; `calendar-calendars` now has every size. They assert one current item per list, the account filter, Back from a place and from a pushed screen, and that each intent opens.
- **`--sean` can export a medium picture** when the scene says so (`sean.sizes`), for a screen that exists only at that width.
- **Calendar opens on the range last used** on this device, not always on the week.
- **Lanes:** the mail lane renames Scheduled to Outbox and restyles the chips; the calendar lane adds the Hours row and UNDO on a deleted set; the search lane takes the inline search fields and fills `search`; the notes settings take the More menu's set-up items.
