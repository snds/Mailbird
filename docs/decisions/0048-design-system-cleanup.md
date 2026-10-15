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

Dismissed, as correct use rather than missing pieces: `DialogHeader` → title + description (19 times), and `DropdownMenuItem` + `Icon` (17 times). Parked, below the threshold: the floating compose button (1 use). The full log is in unicron's `docs/04-patterns.md`.

### Clean up the app on top of them

- **Adopted the variants** everywhere the shape matched exactly. The script that applied them rewrites only reviewed shapes, so a near miss is left alone rather than guessed at.
- **Dropped overrides that restate a default**, such as `shrink-0`, which `Button` and `Icon` already apply.
- **The two look-alikes were never Button forks.** Each is a small flow: a button plus the dialog it opens. They're renamed for the job they do: `InterestingCalendarsPicker` and `UnsubscribeAction` (`mail/unsubscribe.tsx`). A name ending in "Button" told designers and dsa there was a second Button.
- **One filter row was out of step.** Five rows (mail lanes, splits, labels, smart groups, smart folders) shared one chip recipe: `xs`, a pill, `secondary` when on, and `ghost` when off. Notes tags were a size up and filled primary when on. They now use the shared recipe.

## Deliberate visible changes

Everything else draws the same pixels as before. There are three deliberate changes:

1. **Notes tags** use the shared chip recipe. They're quiet until picked, and 4px shorter.
2. **Text pills gain 2px a side** (`px-3` instead of `px-2` or `px-2.5`). This touches the note toolbar's Tag and Link buttons, the find-a-time slots, the "also in" contact chip, and the restore choices.
3. **Tooltip shortcuts** use unicron's `Kbd`, a small chip styled for tooltips, instead of plain monospace text.

## Verification

- **Screens:** 52 states (menus, dialogs, sheets, chips, and editors; light and dark; desktop and phone), compared pixel by pixel before and after. Every difference traces to the three changes above.
- **Tokens:** all 133 custom properties resolve to identical values in light and dark.
- **Regression:** all 38 browser suites pass. `tsc -b`, `oxlint`, and `vite build` are clean.
- **Ratchet:** the baseline is lowered to the new counts and enforced in CI:

| Count | Before | After |
|---|---|---|
| `className` overrides | 274 | 251 |
| Visual overrides (of those) | 138 | 81 |
| Style overrides | 2 | 2 |
| Look-alikes | 2 | 0 |

## What the numbers don't say

- **An override can be a decision.** Seven menus set `bg-popover` to stay solid instead of the system's frosted glass. These are send later, snooze, remind, and the composer: the menus with the most text. Removing the override looked like cleanup, but the screens showed text bleeding through. So it stays, and it's an open design question. Should menus be glass or solid, as a system default or as a choice?
- **Adoption ratio can move the wrong way.** One `IconButton` replaces three components (`Tooltip`, `TooltipTrigger`, `Button`). The count of system components in use went down (965 → 950), so the custom ratio rose slightly (0.556 → 0.559), while there's less custom code.
- **What's left of the 81:** It includes the seven solid menus above.
  - Hidden titles (`sr-only`, which accessibility needs) and area hues on icons are accepted.
  - The dialog footer keeps Delete, Cancel, and Save in one row on phones, overriding the system's stacked footer. That's a design call, not a cleanup. It's the next candidate.
