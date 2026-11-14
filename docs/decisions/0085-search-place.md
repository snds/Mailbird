# ADR-0085 · Search as a place; row adapters; one list of settings sections

- **Status:** Accepted for the build. It is the base of brief X2; the search lane finishes it (below, "Left for the search lane"). The search key working in every section is cross-app decision DC14's, which that lane records.
- **Date:** 2026-11-14
- **Builds on:** [ADR-0084](0084-places.md) (places; it named Search as one and left it empty), [ADR-0083](0083-shell.md) (the shell; its Search button opened the command menu meanwhile), [ADR-0075](0075-settings-page-and-shortcuts.md) (Settings as a page), [ADR-0032](0032-your-keys.md) (your own keys), [ADR-0063](0063-shared-inbox.md) (a team member has Mail only).
- **Design:** Mobile / 04 and Desktop / 03 (Mail, Search); briefs X2, X3 and T0 of the undrawn-areas design; cross-app decisions §5 and §6.

Vale had three search fields, one in each of Mail, Contacts and Notes, each searching only the list it sat in, and none in Calendar. The search key worked in Mail alone. This makes Search one place, reached the same way from everywhere, and takes the three fields out.

## Decisions

### Search

- **One place** (`apps/web/src/features/search/`), held in the store as `search`: what it looks through (`scope`), the mail lane it was opened from (`lane`), the words, and the section behind it. It stands in the list column in place of the open section, which is hidden and comes back as it was, the way Settings does it.
- **The field is the focal point:** unicron's `SearchField`, labelled by the chosen chip: SEARCH INBOX (the lane's name), SEARCH MAIL, SEARCH CALENDAR, SEARCH CONTACTS, SEARCH NOTES, SEARCH EVERYTHING.
- **Chips say where it looks:** a single-choice `FilterChipGroup` named "Search in". The lane chip shows only when Search opened from a mail lane, and starts chosen, so today's search inside one lane is kept. Then ALL, MAIL, CALENDAR, CONTACTS, NOTES. From Calendar, Contacts or Notes that kind starts chosen; from Settings, ALL. A team member has no chips and searches mail.
- **Results come from reads the sections already make,** under the same cache keys, so nothing new is asked of the core:

  | Scope | Read |
  |---|---|
  | A lane | `listMessages` with `search` on that lane, a page at a time ("Show more"). "Assigned to me" is the Inbox narrowed to you, as before |
  | Mail | the same read on Inbox, Snoozed, Archive, Waiting and Starred, and the Screener while it is on; joined newest first, one row per conversation; each lane's first page |
  | Calendar | `listOccurrences` from 30 days back to 90 ahead; kept when the title or the place holds every word. What is coming first, then what has passed |
  | Contacts | `listContacts(q)`, across every group |
  | Notes | the notes read with `search`, in every folder; archived notes last, marked "Archived" |
  | All | the four kinds, three rows each, each under its own header with "Show all" |

  Mail's account choice narrows mail here too. Matched words are marked with `Highlight`.
- **A result opens where it lives** (`jumpTo`): its own section, with the item open. The browser's Back returns to Search with the words kept. Typing and changing the chip do not add history entries: the entry Search stands on is kept in step (`places.ts`).
- **Ways in:** the phone's search button (the bottom row is kept, the button is the current place, no tab is marked); the sidebar's and the rail's Search item, the only `aria-current` in the sidebar meanwhile; the person's search key (`mail.search`, `/` until changed), now from every section and from Settings; and the command menu's "Search", "Search mail for …" and, last, "Search everything for …".
- **Esc clears the words; with none, it leaves** for where you came from: the browser's Back when the place behind is that one, so the two never disagree.
- **States:** nothing typed shows the field and the chips only (Vale keeps no recent searches). Reading shows skeleton rows. No match: `SEARCH // 00`, "Nothing matches.", a line by scope, and "Search everything" except in All. A read that fails with nothing to show: the critical empty state with "Try again".
- **The three inline fields are gone,** with the store's `mailSearch`. `showMailTab(tab, words)` now opens Search inside that lane.
- **The search key is listed under Everywhere** (`lib/keys.ts`: `everywhere` on the command). Its id stays `mail.search`, as the core keeps it. Rebinding swaps it with a command of any area that has the key, so no section loses a key to it silently; a calendar key set to the same key by an older save keeps it in Calendar.

### Row adapters

One adapter per kind, each typed on the core's summary type and drawing one unicron part with the data the core has today:

| Adapter | Core type | unicron part |
|---|---|---|
| `features/mail/message-row.tsx` `MessageRow` | `MessageSummary` | `ListRow layout="message"` |
| `features/calendar/occurrence-card.tsx` `OccurrenceCard` | `Occurrence` | `CalendarEvent` |
| `features/contacts/person-row.tsx` `PersonRow` | `ContactSummary` | `ListRow` (inline) |
| `features/notes/note-row.tsx` `NoteRow` | `NoteSummary` | `ListRow` (inline) |

Search lists with them now. Each section's own list adopts its adapter when its lane rebuilds it, and adds what it needs (a swipe around the row, a menu, a color) as optional props, so there is one row per kind.

### Settings sections

- **One list** (`features/settings/sections.ts`): each section's id, name, group, icon, the words the command menu finds it by, who has it, and its body. The settings page, the phone's list of sections and the command menu's SETTINGS rows all read it.
- **The id type lives there** and the store imports it, so a lane that adds a section's rows, or shows a hidden one, never edits the store.
- **The ids are brief T0's eleven:** accounts, team, mail, writing, ai, notifications, calendar, notes, appearance, shortcuts, about; and gateway, until About and Accounts take its rows. `notes` is registered and hidden until the notes lane gives it rows. The order is T0's.
- **"New mail on your phone" is "Notifications"** (id `phone` → `notifications`), as the cross-app decisions name it. Its rows are the same.
- **Every body is as it was** (`features/settings/section-bodies.tsx`), the second time zone in Calendar included. The page keeps its layout; the settings lane moves it onto `SettingsFrame` and draws the groups.
- The command menu's "Change keys and swipes" row is the section's own name now, "Shortcuts and gestures", found by the old words too.

## Left for the search lane

- A result open in the detail column beside the results (now it opens in its section); the breadcrumb and Back inside Search.
- A count on each chip; ↑, ↓ and Enter through the results; the swipe up on the phone's search button.
- Every page of every lane in Mail's scope (now each lane's first page, 200 rows; the count shows only when that is all there is).
- Recording DC14.

## Consequences

- Searching inside one contact label, smart group, note folder or tag is gone; Search looks through all contacts and all notes. A lane of Mail keeps its own search through the lane chip.
- Archived notes are found from anywhere, where before only the Archive's own field found them.
- Ratchet: className overrides 130 → 129 (the shared list search field went). Look-alikes stay 0.
- Scenes: `mail-search` and `mail-search-none` keep their names and go through Search. New, asserting: `search-mail` (the key from every section, Esc, the lane chip, a result and Back, what is current) and `search-all` (the command menu's rows, contacts and notes, three rows a kind).
