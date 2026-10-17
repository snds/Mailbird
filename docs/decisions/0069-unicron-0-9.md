# ADR-0069 · unicron 0.9: stronger destructive text and a visible light warning

- **Status:** Accepted
- **Date:** 2026-10-17
- **Builds on:** [ADR-0064](0064-unicron-0-7.md) (unicron 0.7)

unicron moved on after ADR-0064. This moves Mailbird from `@unicron/ui` 0.7.1 and `@unicron/tokens` 0.5.0 to 0.9.0 and 0.7.0.

## Decisions

- **Take it as it is.** No Mailbird code changes. What changes on screen comes from the tokens:
  - `--destructive` moves to `red.700` in light mode and `red.200` in dark. Destructive text on a selected row reads APCA Lc 76 or more (it was 74; reading text needs 75).
  - Light mode's `--warning` moves to `amber.450`. The fill reads Lc 31 or more against the sidebar (it was 27).
- **ui 0.8 and 0.9 only add:**
  - `SecretField` takes several lines, `name`, `required`, and `onBlur`;
  - `CommandItemAction` (a second action on a ⌘K row) and `Skeleton variant="row"`;
  - `CodeDisplay` copies by reference.
  None replaces a workaround in Mailbird today.

## Verification

- `tsc -b`, `oxlint`, and `vite build` are clean.
- The full browser regression passes.
- **Ratchet:** flat, at 211 `className` overrides, 16 raw elements, and 2 style overrides.

## Consequences

- **Screens shift slightly** where destructive text and the light warning fill show. That's intended.
