# ADR-0088 · Date and color parts, built once: the month grid, the pickers, the zone picker, the swatches

- **Status:** Accepted for the build. **Three choices are proposals for Sean** (below): the date's type role, the swatches of the brown and gray notes, and any day being pickable in the date-and-time picker.
- **Date:** 2026-11-14
- **Builds on:** [ADR-0082](0082-unicron-1-0.md) (unicron 1.0: `AdaptivePopover`, `PopoverHeader`, `TextField`, `Command`, `FieldRow`, the twelve swatch roles), [ADR-0084](0084-places.md) (the calendars' swatches, the month at the top of Calendar's list column, the second zone in Settings › Calendar), [ADR-0087](0087-forms-and-questions.md) (the form layer the pickers open over).
- **Design:** sections 1.3, 1.4, M8, C1, C3, C8 and T4 of the undrawn-areas design; the week strip of Mobile / 08 for a day's look. Unicron's contract (5.1b) names all four parts app-level.

Vale picked a date four ways: a small dialog around the browser's date-and-time field in three places (send later, "remind me if no reply", a note's reminder), the browser's date fields in the event form, and two month grids of its own (the mini month and the calendar's Month). It picked a time zone from two selects of 400 names. A calendar's color had one helper and a note's color none. This builds each of them once, in Vale's own layer, and moves every caller onto them.

## Decisions

### The month grid (`components/month-grid.tsx`, `styles/calendar.css`)

Weekday initials over six weeks. One part with three variants: `picker` (the pickers, and the month in Calendar's list column), `month` (the phone's Month) and `compact` (the 320 px menu-bar window).

- **A day is its whole cell,** as the drawn week strip's day is. The picked day is the `primary-fill` block with `primary-on-fill` text. Today, when another day is picked, keeps its ink and takes a 2 px `primary-fill` edge under it. Where no day can be picked, today takes the block. Days outside the month are `text-faint`. A day that cannot be picked (before `min`) is faint and struck through.
- **The mark.** A 4 px square under the date on a day with events; in `month`, up to three 8 px swatch squares, one a calendar. An event of a calendar with no color adds no square, so a day with only such events shows the 4 px square.
- **Semantics.** A grid named for its month; rows; a column header per weekday, named in full; each day a grid cell named with its full date, "today", and "3 events". The picked day is `aria-selected`, today `aria-current="date"`. One day is in the tab order.
- **Keys.** Arrows move a day or a week; Page Up and Page Down a month (with Shift, a year); Home and End go to the week's ends; Enter or Space picks. An arrow off the month's edge shows the next month. The keys stay in the grid: a form around it does not also act on them.
- **Paging.** The month's name and two icon buttons stand over the days. In the page's order they come after the days, so a picker opens with focus on its day, not on "Previous month".
- **Plain cells.** The cells are plain elements drawn from tokens in app CSS, with three height knobs. A day is a focusable grid cell, not a button, so the grid adds no plain `<button>`; the mini month's is gone (16 → 15 in ADR-0083, now 15 → 14).

### The pickers (`components/date-picker.tsx`)

`DatePicker` and `DateTimePicker`, each in unicron's `AdaptivePopover`: a popover under its trigger on a desktop, a sheet on a phone, with a header titled for the job.

- **`DatePicker`:** the month grid. Pressing a day picks it and closes.
- **`DateTimePicker`:** the month grid, a TIME field (the platform's time input in the Text Field box), one line about what happens then where the old dialog had one, and one primary named for the job (SCHEDULE, SET REMINDER, SNOOZE). It opens an hour out, on the hour, or on the time already set. A time in the past is the field's error, "Pick a time at least a minute from now.", and the primary then goes to the field instead of picking.
- **Opened from a menu row.** The picker's trigger is the menu's own trigger (`MenuAnchor`), so it stands where the menu did and focus returns to that button. Only the menu row opens it, and the button keeps saying the menu's state, not the picker's.
- **Callers.** Send later's "Pick a time…" and "remind me if no reply" (`mail/send-later.tsx`), a note's reminder (`notes/remind-menu.tsx`), and snooze, which gains "Pick date and time…" (`mail/snooze-menu.tsx`; brief M8). `PickTimeDialog` is gone. The event form's two date fields are buttons that show `THU 11.12`, are named "Start date, Thursday, November 12, 2026", and open the `DatePicker`; the end date cannot be before the start.
- **The months it replaced.** The month at the top of Calendar's list column and the menu-bar window's month are the shared grid; `calendar/mini-month.tsx` is gone. The phone's Month (`calendar/month-grid.tsx`) is the shared grid with swatch squares: pressing a day picks it and lists its events under the grid, where it showed tiny titles and a press opened the day. The desktop's Month is as it was, until the calendar lane rebuilds it.

### The zone picker (`components/zone-picker.tsx`)

Every zone the platform knows in a searchable list (unicron's `Command` in an `AdaptivePopover`). "Yours" comes first; the rest are grouped by region, each with its short name on the date in question. A zone is found when every word typed is in its city, its region or its short name, so "lisb" is Lisbon alone.

- It replaces the event form's time-zone select. The row shows `Yours // Los Angeles (PST)` and a CHANGE button.
- The second time zone is `features/settings/second-zone-row.tsx`, a Field Row in Settings › Calendar with CHANGE. Its list starts with "None" and leaves your own zone out. `calendar/second-zone.tsx` is gone. The choice is kept where it was (`calendar/zones.ts`), and still adds its column of hours to the time grid.

### The swatches (`lib/swatches.ts`)

One file maps a color to one of unicron's twelve swatches and says where a swatch may show. It imports nothing at run time, so a script can print the mapping.

- **A calendar** takes the swatch nearest its server color in OKLCH hue (the twelve stand 30° apart from 25°). When that one is taken, the later calendar in sidebar order takes the next free one. Past twelve colored calendars the swatches repeat. No color: the neutral bar and no square. Hidden calendars keep their place, so hiding one never recolors another.
- **A note's color** maps one to one: red, orange, yellow (ochre), green, teal, blue, purple (violet) and pink (rose) by name; brown is olive and gray is azure, since the set has neither.
- **Four helpers, one for each place a swatch may show:** `eventSwatch` (the 2 px bar of a `CalendarEvent`), `navSwatch` (the square of a `NavItem`), `tileEdge` (the 4 px top edge of a `Tile`) and `swatchSquare` (the 8 px square). There is none for text or for a fill behind text.
- `features/calendar/swatches.ts` (ADR-0084) moved here. The notes lane moves the note cards and rows onto `noteSwatch`; until then the open note keeps its tint.

## For Sean

1. **The date's type role.** The design names `type-number-count` (24 px mono) for the grid. The drawn week strip sets its dates in 16 px sans, and 24 px does not fit seven columns of 41 px. The grid uses `type-body-strong` (16 px), with two digits as the strip draws them. Right?
2. **Brown and gray notes** have no swatch of their own. Brown takes olive and gray takes azure. Would two more swatches be better, or should those two colors go?
3. **Any day can be picked** in the date-and-time picker; a past one shows the time's error. The other way is to rule out the days before today.

## Ratchet

Read from the source: className overrides 122 → 118, plain buttons 15 → 14; 1 style, 0 spread, 0 look-alikes. `.dsa/baseline.json` is lowered. Three of the four classes went with the old dialog and the two selects. The fourth is still written: the size of the bell in the note's reminder button, which now stands inside a prop, where the ratchet does not count.

## Consequences

- A date or a zone is picked the same way everywhere, by pointer or by keys, and a picker is a sheet on a phone.
- The event form's time fields, its selects and its rows are still the old ones; the calendar lane rebuilds them (brief C3) around these parts. Settings › Calendar is restyled by the settings lane.
- A calendar's color can differ a little from the one its server gave, and two calendars of one hue never share a swatch until there are more than twelve.
