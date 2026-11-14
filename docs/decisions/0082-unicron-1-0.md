# ADR-0082 · unicron 1.0: the new look, on a vendored pre-release

- **Status:** Accepted for the move itself. One part is a proposal for Sean: marking the 2026-10-15 design rules as superseded (DC8, below).
- **Date:** 2026-11-14
- **Builds on:** [ADR-0080](0080-unicron-0-24.md) (unicron 0.24), [ADR-0052](0052-unicron-packages.md) (unicron as packages), [ADR-0081](0081-harness-and-scenarios.md) (screenshots by area), [ADR-0075](0075-settings-page-and-shortcuts.md) (settings as a page)

unicron 1.0 changes the look of everything at once: the 2026-11 design direction. Each app gets its own theme, type is Geist and Geist Mono, icons are IBM Carbon, corners are square, and `primary` stops meaning "the strongest ink" and becomes the app's one identity color. This is the first step of Vale's rebuild on it. It moves Vale onto 1.0 and the new look and changes nothing else: every screen keeps the layout it had, so the lanes that rebuild the shell, mail, calendar, contacts, notes and settings each start from a working app.

## Decisions

### The packages

- **Vendored, because 1.0 is not released yet.** Both packages install from the pre-release tarballs in `vendor/unicron/`: `unicron-ui-1.0.0-pre.2.tgz` and `unicron-tokens-1.0.0-pre.2.tgz`. `apps/web/package.json` names them with `file:../../vendor/unicron/…`, and the `@unicron/tokens` override in `pnpm-workspace.yaml` names the same tokens file, so one copy of the tokens loads. The lockfile holds each file's hash.
- **Swap to the `@unicron/ui@1.0.0` and `@unicron/tokens@1.0.0` release URLs when Unicron 1.0 is released, and delete `vendor/unicron/`.** The gateway's `Dockerfile` copies `vendor/` before it installs, for the same reason; that line goes with the folder.
- **Three dependencies leave `apps/web`:** `@fontsource-variable/inter` and `material-symbols` (Geist and the Carbon drawings come with `@unicron/ui`), and `sonner` (see Toasts). `next-themes` stays. `@unicron/ui` brings `@fontsource-variable/geist`, `@fontsource-variable/geist-mono` and `qrcode-generator` 2.0.4.

### The theme

- **`<html lang="en" data-theme="vale">`** in `apps/web/index.html`. That one attribute covers the app, the menu-bar window (`?mini`) and the booking pages. `next-themes` keeps `attribute="class"`: the `dark` class is graphite, no class is stone.
- **`theme-color` is set at run time,** from the page's own `--surface-ground` (`src/lib/theme-color.ts`): on load, and whenever the class or `data-theme` on the root changes. The two hard-coded colors in `index.html` are gone, so no color is written in Vale's code. `tauri.conf.json` sets no window color, so it did not change.
- **A Theme setting.** Settings gains an **Appearance** section, shown to everyone, a team member too: the theme belongs to the device, not to the gateway. It holds one Field Row, THEME, with three single-choice chips: **System · Stone · Graphite**. Light and dark are said only in the tooltips: Stone "Light", Graphite "Dark", System "Follows your device's light or dark setting." The choice is saved in `next-themes`' own store with its own values (`system`, `light`, `dark`), so nothing stored before changes meaning. There is no "Follow system" switch: System is one of the three. The chip words are the cross-app pick, and Sean has not confirmed them yet (Q11 in the Vale brief; cross-app question 8).
- **In the command menu,** "Use light mode" and "Use dark mode" become "Theme: System", "Theme: Stone" and "Theme: Graphite". Typing "light", "dark" or "mode" still finds them.

### Icons

- **`unicron-codemod icons`** rewrote 379 Material names in 77 files and left 89 alone where Carbon uses the same word. Five `fill` props became the glyph's filled name (`pin--filled`, `star--filled`, `checkmark--filled`).
- **Six names had no Carbon match** (10 places):
  - `progress_activity` (3): a spinner is not an icon. The two update buttons use Button's `loading`; the attachment's save button shows `Spinner`.
  - `person_off` (3), for "Screen out": `user--minus`. The Screener's swipe uses it too, so "Screen out" has one glyph everywhere.
  - `forward`: Carbon draws `reply` and no forward arrow. Vale registers one glyph of its own, `vale--forward`, Carbon's `reply` mirrored (`src/app/icons.ts`). It is the only registered glyph.
  - `waving_hand`, beside a first-time sender: `information`. It is a notice.
  - `unsubscribe`: no glyph. The button says "Unsubscribe".
  - `format_color_reset`, the "no color" swatch: an empty swatch. Its name and tooltip still say "No color".
- **Where Figma shows a glyph for a place, that one wins:** the create buttons are `edit` for mail and `add` for the other three; a "More" menu is `overflow-menu--horizontal`; "New contact" in the command menu is `user--multiple`.
- **The removed props are gone:** `fill`, `weight`, `grade`, `opticalSize`, and the shell's `--c-nav-icon-*` fill animation. A starred conversation's toolbar star is `star--filled`.
- **`className="size-*"` on an `Icon` became the `size` prop wherever it means the same** (58 places), and went away where a control already sets that size (2). Twelve stay: an icon inside a Button that asks for 20 px, which a `size` prop cannot do, because a control's own rule wins over it.

### Roles

- **One identity color.** The four area hues (`--vertical-mail`, `-calendar`, `-contacts`, `-notes`, and their text steps) and every class that used them are gone. What they colored is neutral now. The current area in the navigation, a selected row and a selected day in the agenda are `primary-soft`.
- **Today and now in the calendar** are the identity color (`primary-fill`), the one mark of "you are here".
- **A calendar's own color stays.** unicron's checkbox is ink now, so the calendars list shows each calendar's color as a small square beside its name instead of tinting the checkbox.
- **Where `primary` meant the strongest ink** it is `foreground`; a link is `primary-text`.
- **Vale's three pane roles are gone:** `--surface-chrome` is `surface-ground`, `--surface-canvas` is `surface-raised`, `--surface-selected` is `primary-soft`.
- **Unread is ink** (`--unread: var(--text-body)`), as unicron's own marks are.
- **Swipes:** read and archive, the two the design draws solid, reveal the identity fill; every other action reveals a raised neutral tile; "Screen out" keeps the critical fill, now with its own ink.
- **Kept:** `--c-shell-*`, the sketch paper, the scan knobs, the note-card tints and the calendar's own event colors.

### What 1.0 broke, and the smallest fix for each

- **Toasts.** unicron's Toaster no longer hears `toast` from `sonner`. All 66 files import it from `@unicron/ui`. Its toast has one action and no close button, so a missed reminder, which stays until closed, now closes by its action: "Open" on a note's, "Dismiss" on an event's.
- **A chosen state that used a button variant.** `secondary` and `outline` draw alike in 1.0, and a solid button is the identity color. A chosen invitation answer, a picked free time, a tag or label in a smart folder or group, and the calendar set now showing are a pressed `Toggle` (inverted ink). "Restore to" is a `FilterChipGroup`.
- **Sizes grew** (buttons 32 → 40, fields 32 → 48, body text 14 → 16):
  - The conversation's actions wrap under its subject on a phone.
  - The composer's From and the swipe selects use the row-size select.
  - Two dialogs stack their two selects on a phone.
  - Six menus take the width of their items (`width="fit"` or `"auto"`).
  - Three sheet headings keep clear of the close button, which is top right now.
- **A Button's label is mono capitals.** The rows of "Link this note" were Buttons, so an event's title, a person's name and an address came out in capitals. They are `Item` rows now, and read as written.
- **`Empty` in a pane takes `size="sm"`,** as the migration guide says.
- **`muted` is the raised surface itself now.** Where a muted fill was the whole signal on a raised pane, it takes the role made for it: two loading blocks and a note's code block are `accent`, three hovers are `state-hover`.

### Styles, one file per area

`styles/app-extension.css` and the area rules that were in `index.css` are now `styles/shell.css`, `mail.css`, `calendar.css`, `contacts.css`, `notes.css` and `settings.css`, all imported by `index.css`, so each lane edits its own file. `shell.css` holds what every area shares. `index.css` keeps the safe-area and keyboard-inset handling. Knobs are declared on unicron's four selectors, and the one value that differs by ground (the note-card tint) on its two ground selectors.

### Names that would collide

unicron 1.0 exports names Vale used for its own components. The ratchet counts a local component as a look-alike once the unicron one is in use, so a lane that adopted one would have failed CI over another lane's file. They are renamed now, with no change in behavior:

| Was | Is | In |
|---|---|---|
| `ListRow`, `SearchField` | `EntryRow`, `ListSearch` | `components/list-row.tsx` |
| `NavItem`, `TabBar` | `AreaEntry`, `PhoneAreas` | `app/shell.tsx` |
| `SectionHeader` | `SettingsHeading` | `features/settings/section-header.tsx` |
| `Composer` | `ComposeMail` | `features/mail/composer.tsx` |
| `Composer` | `QuickNoteForm` | `features/notes/quick-note.tsx` |
| `SwipeRow` | `RowSwipe` | `features/mail/swipe-row.tsx` |
| `ToolbarButton` | `ToolButton` | `features/mail/conversation-view.tsx` |
| `Toggle` | `PrefSwitch` | `features/advanced-mail.tsx` |

### DC8, a proposal: the 2026-10-15 design rules are superseded

Three rules from Sean's 2026-10-15 reviews are in Vale's baton: menus are frosted glass, dialog actions on a phone are a row of round 40 px icon buttons, and a sheet has a small floating close button at its bottom right. The 2026-11-12 direction reverses all three, and unicron 1.0 already draws the new way: menus are solid, dialog actions are words at every width, and a sheet's close button is at its top right. This ADR records them as superseded. It is a proposal until Sean says yes (DC8 in the Vale brief). One screen still shows the old rule's shape: the Quick Note's "Save note" on a phone is the pill that sat beside the floating close.

## Verification

- `tsc -b`, `oxlint`, `vite build`, `pnpm build:demo` and the notes relay tests (18 of 18) are clean.
- **Ratchet,** read from the source because `dsa` cannot be fetched where this was written (CI runs it): className overrides **208 → 137**, style overrides **2 → 1**, 0 spread props, 16 raw elements. Look-alikes, estimated: 0, and still 0 if every unicron 1.0 export were in use.
- **Screenshots** (`pnpm shots`): all 300 pictures pass, the 296 from before and the new `settings-appearance` scene, whose check is that the stored theme's chip is the checked one. Every picture changed, as it should. Looked at, for missing icons, cut or overlapping text and stray color: every scene, its desktop picture in one theme beside its phone picture in the other; and twelve scenes side by side with the 0.24 set at both sizes in both themes (the inbox, a conversation, compose, search, the week, a new event, a person, a note, accounts, the command menu, the menu-bar window and the booking page).
- **The split changes no pixel.** The same rules built from one file in the old order, against the six files: 55 of 56 pictures are identical and one differs by 4 pixels (noise), and the two built stylesheets hold the same 2,507 rule blocks.
- **Theme, in a browser at both sizes:** no stored choice follows the device; each chip switches the whole app at once and `theme-color` with it; the choice survives a reload; under System a device that turns dark turns the app dark with no reload; the arrow keys move between the chips; the tooltips say Light and Dark; the three command-menu items write the same store; a team member has the section.
- **Packaging:** `apps/web/dist/assets` holds the Geist and Geist Mono fonts and no Material Symbols font. `grep -rn 'vertical-' apps/web/src` finds nothing.
- **The lockfile** changes only the unicron entries and the packages named above; the `@snds/dsa` entries are unchanged. A frozen install of the manifests with `vendor/unicron/` passes, and fails on a wrong tarball hash, a wrong specifier and a missing version. The gateway image's install step passes with `vendor/` copied and fails without it (run by hand outside Docker: the image itself was not built here).

## Consequences

- **The look is unicron's now.** Every screen is on the new look in its old layout, which reads as unfinished on purpose: a lane rebuilds each one. Until then some old shapes remain (36 `rounded-full`, 7 shadows, 4 `backdrop-blur`), and many screens show two solid buttons at once, the floating "new" and a screen's own.
- **Labels on buttons, toggles and chips are mono capitals,** names a person typed among them (a split, a label, a tag, a calendar set). The lanes move those to parts that keep a name as written.
- **A missed reminder for an event gains a "Dismiss" action,** and a missed note reminder closes by "Open" or a swipe. A toast that stays until closed needs a close of its own in unicron.
- **HTML mail in dark mode was unreadable before this and still is** (a white frame with pale text). It is the mail lane's.
- **The license list gains the SIL Open Font License 1.1** for Geist and Geist Mono (Inter was under it too). `NOTICE` and `docs/oss-stack.md` say so.
