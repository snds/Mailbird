# ADR-0048 · Design-system cleanup from the first dsa pass

- **Status:** Accepted
- **Date:** 2026-10-15
- **Builds on:** [ADR-0047](0047-unicron.md) (consuming unicron, measuring it with dsa)
- **Upstream:** [snds/unicron#2](https://github.com/snds/unicron/pull/2), which the submodule pins

## What the first scan said

ADR-0047's baseline counted **274** `className` overrides on unicron components, **2** style overrides, and **2** local look-alikes of `Button`. Sorting the 274 by what they change splits them in half:

- **138 are layout:** position, size, spacing, and truncation. Placing a component in its parent is the caller's job, so these stay.
- **138 are visual:** ink, shape, fill, and padding. Each one is a choice the system should offer by name. Where the same visual override repeats, it's a missing variant.

The 28 pattern candidates were mostly the same signal seen from another angle. dsa names a candidate after the first file it's found in, so "Fab" through "Fab9" are mostly icon-and-button arrangements.

## Decision

### Promote what repeats into unicron (snds/unicron#2)

Each promotion follows unicron's own rule (`docs/04-patterns.md`). A one-family repeat becomes a **variant**. A component is only for something with **its own behavior**.

| Repeat in Mailbird | Promoted as | Why |
|---|---|---|
| 13 tooltip triggers, rebuilt as 3 local wrappers (`ToolbarButton`, `ToolButton`, `Mark`) | **`IconButton`**, a component | It has its own behavior: one `label` is both the accessible name and the tooltip, so they can't drift apart. `render` swaps in a `Toggle`, or nests the IconButton in a menu trigger. |
| 18 `rounded-full` overrides on `Button`, in every filter row | **`Button shape="pill"`** | A chip is a shape, not a new control. Text pills get `px-3`, because the round ends eat into the padding. |
| 11 ghost buttons with muted ink; 5 ghost buttons with destructive ink (Delete in a dialog footer) | **`ghost-muted`**, **`ghost-destructive`** | They're quiet actions. The filled `destructive` stays for the one action a dialog exists to confirm. |
| 30+ standalone icons in muted ink, 2 in destructive | **`Icon tone`** | Ink as a named choice. Area hues (`text-vertical-*`) stay in the app, because the core can't know them. |
| The same 4-class override on 3 phone sheets | **`SheetContent fullscreen`** | The full-screen phone editor: composer, event, and editor frame. |
| 3 dialog titles laid out by hand around a Back button | **`DialogTitle`** lays out a leading Back button itself | Dialogs with steps. |
| 4 dialog footers forced into a row on phones; 11 footers that pair a dismiss with a confirm | **`DialogActions`** + **`DialogAction`**, a component | Sean's call: on phones, a row of icon buttons, laid out like Apple's sheet controls. See below. |

Dismissed, as correct use rather than missing pieces: `DialogHeader` → title + description (19 times), and `DropdownMenuItem` + `Icon` (17 times). Parked, below the threshold: the floating compose button (1 use). The full log is in unicron's `docs/04-patterns.md`.

### Two design calls (Sean, 2026-10-15)

1. **Menus are frosted glass.** Seven menus overrode the system's glass to solid: send later, snooze, remind, and the composer, the menus with the most text. The overrides are gone, and every menu now uses the system default.
2. **Dialog actions are one row on every screen, with icon buttons on phones.** This follows the layout of Apple's sheet controls, not the glass look.
   - **On phones:**
     - Each action is a round 40px button: ✓ to confirm (filled), × to cancel, and a trash can for a destructive action. The trash can is tinted and sits apart on the far left.
     - The words stay as each button's accessible name.
     - The dialog's corner × hides when the row has a Cancel, so there's one way out, not two.
   - **From `sm` up:** the actions are the same text buttons as before. Cancel is now outlined everywhere; three dialogs had used a ghost Cancel.
   - **Scope:** the 11 footers with a Cancel use it, including the sign-in client footer, whose "Remove saved client" link became a destructive action. The 4 footers with a single action ("Add account", "Connect", import, attachment save) keep a text button, because a lone ✓ says less than the words.

### Clean up the app on top of them

- **Adopted the variants** everywhere the shape matched exactly. The script that applied them rewrites only reviewed shapes, so a near miss is left alone rather than guessed at.
- **Dropped overrides that restate a default**, such as `shrink-0`, which `Button` and `Icon` already apply.
- **The two look-alikes were never Button forks.** Each is a small flow: a button plus the dialog it opens. They're renamed for the job they do: `InterestingCalendarsPicker` and `UnsubscribeAction` (`mail/unsubscribe.tsx`). A name ending in "Button" told designers and dsa there was a second Button.
- **One filter row was out of step.** Five rows (mail lanes, splits, labels, smart groups, smart folders) shared one chip recipe: `xs`, a pill, `secondary` when on, and `ghost` when off. Notes tags were a size up and filled primary when on. They now use the shared recipe.

## Visible changes

Everything else draws the same pixels as before.

1. **Menus** are frosted glass everywhere (decision 1).
2. **Dialog actions on phones** are a row of round icon buttons (decision 2).
3. **Notes tags** use the shared chip recipe. They're quiet until picked, and 4px shorter.
4. **Text pills gain 2px a side** (`px-3` instead of `px-2` or `px-2.5`). This touches the note toolbar's Tag and Link buttons, the find-a-time slots, the "also in" contact chip, and the restore choices.
5. **Tooltip shortcuts** use unicron's `Kbd`, a small chip styled for tooltips, instead of plain monospace text.
6. **Cancel** is outlined in the three dialogs that had a ghost Cancel: template, send later, and unsubscribe.

## Verification

- **Screens:** 52 states (menus, dialogs, sheets, chips, and editors; light and dark; desktop and phone), compared pixel by pixel before and after. Every difference traces to the changes above. Desktop dialog footers are unchanged apart from item 6.
- **Phone footers:** checked in light and dark. The icons are `aria-hidden`, so the words are what assistive tech reads.
- **Tokens:** all 133 custom properties resolve to identical values in light and dark.
- **Regression:** all 38 browser suites pass. `tsc -b`, `oxlint`, and `vite build` are clean.
- **Ratchet:** the baseline is lowered to the new counts and enforced in CI:

| Count | Before | After |
|---|---|---|
| `className` overrides | 274 | 241 |
| Visual overrides (of those) | 138 | 68 |
| Style overrides | 2 | 2 |
| Look-alikes | 2 | 0 |

## What the numbers don't say

- **An override can be a decision.** The scan can't tell a hand-made fix from a deliberate choice. The solid menus proved it: removing their override looked like cleanup until the screens showed what it was for. That's why every removal was checked on screen, and why that one went to a person.
- **Adoption ratio can move the wrong way.** One `IconButton` replaces three components (`Tooltip`, `TooltipTrigger`, `Button`). The count of system components in use went down (965 → 950), so the custom ratio barely moved (0.556 → 0.558), while there's less custom code.
- **What's left of the 68:**
  - Hidden titles (`sr-only`, which accessibility needs) and area hues on icons are accepted.
  - Next sweep: 43 raw `<button>` elements, in 24 files, bypass the system entirely. The scan counts them as plain HTML, so they don't show up as misuse. Whole-surface hit areas like cards and calendar cells are legitimate. Ones like the editor header's Cancel should be `Button`s.
