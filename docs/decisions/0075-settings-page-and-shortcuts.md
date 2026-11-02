# ADR-0075 · Settings as a page, and a keyboard shortcuts list

- **Status:** Accepted
- **Date:** 2026-11-02
- **Builds on:** [ADR-0025](0025-one-action-grammar.md) (shortcuts and gestures), [ADR-0073](0073-icons-by-code-point-and-the-rail.md) (the rail)

Sean found settings overwrought: one long Accounts dialog that opened four more dialogs (signatures and templates, shortcuts and gestures, advanced mail, AI) and stacked five more sections under them. He also didn't want the Commands button in the rail, and asked for ⌘K and the other keys to be on display in a shortcuts dialog.

## Decisions

### Settings is a page, laid out like Mail

- **Settings takes the place of the open area,** the way Mail shows its list beside a conversation: the sections down the left (`MasterDetail`'s list pane), the one you pick beside them. The rail's Settings button shows as the current place; picking Mail, Calendar, Contacts or Notes leaves settings.
- **The sections:**
  - **Accounts:** the list and adding one. Adding an account and connecting calendars are steps inside the section, each with Back.
  - **Signatures and templates**, **Mail** (what was "Advanced mail settings", plus the Screener), and **AI summaries and replies**.
  - **Calendar:** meeting links, and the menu bar on the desktop.
  - **Shortcuts and gestures:** change keys and swipes.
  - **New mail on your phone**, and on a gateway, **Team members**.
  - Sections that need an account appear once there is one. A team member sees only their own. "Sign out of this gateway" sits under the list.
- **On a phone** the list comes first and a section opens over it with Back, like a conversation.
- **One state:** `settings` in the UI store (the section, `"index"` for the list alone, or null) replaces six "this dialog is open" flags. Everything that opened a settings dialog (the composer's signatures item, AI's "set it up", the command menu, Mail's phone header) opens the page at the right section.
- **Each section's content is unchanged.** It moved out of its dialog's header and footer into the page, with one `SectionHeader` (`type-section-title`, `type-support`).

### Keys: a list to read, a section to change them

- **The rail's Commands button is gone.** ⌘K still opens the command menu everywhere, and the menu's footer says so and points at `?`.
- **`?` opens "Keyboard shortcuts" from anywhere** outside a text field: ⌘K, ⌥N and `?` first, then Mail's and Calendar's keys as you've set them. It's read-only; its one action, **Change keys and swipes**, opens Settings → Shortcuts and gestures. The command menu lists both.

### The command menu's backgrounds

- Every row in the menu looked selected in the Mac demo built before [ADR-0074](0074-unicron-0-16.md). That was unicron 0.9: cmdk marks every row `data-selected="false"`, and the old variant matched any value. unicron 0.11.1 fixed it, and Vale has 0.16, so only the row you're on is filled. No change here.

## Verification

- `tsc -b`, `oxlint` and `vite build` are clean. The ratchet's className overrides go down by two (210 → 208).
- **In Chromium:** the sections and their content in light and dark; adding an account opens its step and Back returns to the list; picking an area in the rail leaves settings; `?` opens the shortcuts list and its button opens the section; the rail has no Commands button; on a phone the list comes first and Back returns to it; the console is clean. The browser regression passes, with the suites that opened the old dialogs moved to the page.

## Consequences

- **Settings is one click further from a conversation** (it replaces the area instead of floating over it). The rail and the tab bar bring you back in one step.
