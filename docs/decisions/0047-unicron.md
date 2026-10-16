# ADR-0047 · Consume the shared design system (unicron)

- **Status:** Accepted; the submodule is superseded by [ADR-0052](0052-unicron-packages.md) (versioned packages)
- **Date:** 2026-10-15
- **Builds on:** [ADR-0003](0003-design-system.md) (Mailbird's design system), [ADR-0036](0036-sender-profile.md) (adaptive sheets)
- **Decided elsewhere:** Lockdown decisions D10–D14 (`snds/lockdown` `docs/plan/decisions.md`): one shared design system, **unicron**, for Mailbird, Synapse, and Lockdown. It was seeded from Mailbird's own tokens and primitives.

## Decision

Mailbird stops owning its primitives and core tokens and consumes unicron's. **This is a move, not a redesign:** every token resolves to the same value and every screen draws the same pixels as before.

### How it's wired

- **unicron is a git submodule at `vendor/unicron`,** pinned to a commit, and its two packages join this pnpm workspace (`vendor/unicron/packages/*`). `apps/web` depends on `@unicron/ui` and `@unicron/tokens` as `workspace:*`.
- **Why not a `github:snds/unicron#main` dependency:** unicron's packages don't commit their build output. `@unicron/ui` also depends on `@unicron/tokens` through `workspace:*`, which only resolves inside a workspace. A git dependency would need unicron to build itself on install, and `#main` would float under every Mailbird build. The submodule pins an exact commit, keeps the packages' link working, and needs no change to unicron.
- **The cost:** taking a newer unicron is a reviewed bump: `git -C vendor/unicron fetch && git -C vendor/unicron checkout <sha>`, then commit. CI and the gateway image check out submodules.
- **`apps/web` builds unicron first** (`deps:build`: tokens, then `tsc` for the primitives) before its own typecheck and build. Vite dedupes `react`, `react-dom`, and `@base-ui/react`, so the linked package never brings a second copy.

### What moved where

- **Primitives:** the 28 shadcn/Base UI components, `Icon`, and `cn` now come from `@unicron/ui`. `src/components/ui/*` and `src/components/icon.tsx` are gone. Imports read `from "@unicron/ui"`. `@/lib/utils` re-exports unicron's `cn`, so there's one.
- **Core tokens and base styles:** `@import "@unicron/ui/styles"` brings Tailwind, the three-tier core (global primitives, the shadcn semantic contract, the icon and sheet knobs), Inter, Material Symbols, the dark variant, and the base layer. `src/styles/tokens.css` is gone.
- **Mailbird's own roles:** these live in `src/styles/app-extension.css`, written as unicron documents. They are the panes, area hues, unread, note-card tints, and the `--c-*` knobs of Mailbird-only components (shell, nav, list row, composer, notes, scan, sketch, calendar), with their own `@theme inline` block.
- **The one primitive that had drifted** since the seed was the adaptive sheet's `wide` variant (Phase 35). It went upstream as [snds/unicron#1](https://github.com/snds/unicron/pull/1), which the submodule pins, rather than staying as a fork here. That PR also carries the transform's `.material-symbols.json` manifest, the seed for subsetting the icon font (ADR-0003), which now lives beside the primitives in `vendor/unicron/packages/ui/src/components/ui/`.

### Measuring it: dsa

- **`@snds/dsa`** (design-system analytics) is a root dev dependency, pinned by commit with the `git+https` form. Its `prepare` step is allowed in `pnpm-workspace.yaml`.
- **`dsa.config.json`** scans `apps/web/src`, with the system set to `@unicron/ui`. There are no local aliases left: the old `@/components/ui` copies are gone.
- **Scripts:** `pnpm ds:scan`, `pnpm ds:patterns`, and `pnpm ds:ratchet`.
- **`.dsa/baseline.json`** is committed. CI runs `pnpm ds:ratchet` in the web job and fails if any correct-use count grows. The first counts are:
  - **274** `className` overrides on system components;
  - **2** style overrides;
  - **0** spread props;
  - **2** local look-alikes of `Button` (`InterestingCalendarsButton` and `UnsubscribeButton`).
- **The first pattern scan** found 431 compositions and **28 candidates** under the rule: two or more components, three or more times, across two or more files. Suggestions only; nothing was created.

### Regenerating primitives

- **`tools/shadcn-material` gains `--alias-mode package`.** It writes the relative imports and header unicron's files use, so unicron can vendor the generator instead of rewriting its output by hand. Run on real shadcn sources, its output matches unicron's committed `button.tsx` and `dialog.tsx` exactly. The default `app` mode is unchanged byte for byte.

## Verification

- **Tokens:** all **133** custom properties Mailbird defined resolve to identical values, in light and in dark, read from the running app before and after.
- **Pixels:**
  - Mail, Calendar, Contacts, and Notes, on desktop and phone, in light and dark: **16 screenshots**.
  - **15 are pixel-identical.** One differs only in sub-threshold anti-aliasing (no pixel off by more than 8 of 255).
- **Build and lint:** `tsc -b`, `oxlint`, and `vite build` are clean.
- **Regression:** all 38 browser suites pass, as do the notes sync suites.

## Consequences

- **One known difference:** unicron defines `--font-mono`, a shorter stack of the same fonts Tailwind's default lists, so code in notes falls back differently only on a machine without SF Mono, Menlo, or Consolas. It's taken as is, not overridden: the core is the core.
- **A new primitive, or a change to one, goes to unicron first,** then a submodule bump here. dsa reports a local look-alike of a system name as a violation.
- **The patterns are input for unicron, not a to-do list for Mailbird.** The strongest candidates are an icon `Button`, a `DropdownMenuItem` with an icon, a dialog header (19 times across 18 files), and a `Tooltip` icon button. People decide which become named patterns.
