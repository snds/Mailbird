# ADR-0003 · Material Symbols as the icon system

- **Status:** Accepted
- **Date:** 2026-10-13

## Decision

- **Icon set:** Google Material Symbols (Apache-2.0), Rounded family, as the **variable font** with live FILL, wght, GRAD, and opsz axes.
- **Rendering:** each glyph is drawn as a ligature **inside an `<svg>`** by `Icon` (`apps/web/src/components/icon.tsx`).
- **Replacing Lucide:** shadcn's CLI only offers lucide, tabler, hugeicons, phosphor, and remixicon. So `tools/shadcn-material` transforms shadcn's registry sources, mapping each Lucide name to a Material Symbol through `icon-map.json`.

## Why the SVG wrapper

shadcn styles every icon through `svg` selectors, such as `[&_svg:not([class*='size-'])]:size-4`, `has-[>svg]:…`, and `*:[svg]:…`. A `<span>` icon would break all of them. Wrapping the ligature in an `<svg viewBox="0 0 24 24">` keeps that contract intact, and the font's axes stay animatable.

## Icon tokens

Tier-3 tokens `--c-icon-fill`, `--c-icon-wght`, `--c-icon-grad`, and `--c-icon-opsz` drive the axes. They are registered with `@property` so they interpolate.

- **Nav items** switch fill 0 → 1 and weight 400 → 500 on selection.
- **Dark mode** sets grade to −25 so light icons on dark surfaces don't look heavier.
- **Props** (`fill`, `weight`, `grade`, `opticalSize`) are local overrides of the same tokens.

## Tradeoffs and follow-ups

- **Size:** the full Rounded variable font is about 5.4 MB of woff2. Before release, subset it to the glyphs we use. The transform writes `src/components/ui/.material-symbols.json` as a seed, and the app's own icon names add to it. Keep the four axes when subsetting.
- **Font loading:** until the font loads, a ligature can flash as text. `font-display: block` hides it, and the native shells bundle the font locally.
- **Rejected:** `@material-symbols/svg-*` static SVGs. They are smaller and tree-shakeable, but they lose the variable axes and animated fill states, which are the main reason to choose Material Symbols.
