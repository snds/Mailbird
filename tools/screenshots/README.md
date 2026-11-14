# Screenshots

One command takes a picture of every main screen of the web app, so a change to the look can be checked screen by screen ([ADR-0079](../../docs/decisions/0079-screenshots.md), [ADR-0081](../../docs/decisions/0081-harness-and-scenarios.md)).

```sh
pnpm shots --out ~/vale-shots                                  # builds apps/web, then 296 pictures (about 3 minutes)
pnpm shots --out ~/vale-shots -g mail-inbox -g calendar-week   # only scenes whose name contains any of these
pnpm shots --out ~/vale-shots --size medium -g mail            # medium 768 × 1024; also landscape 844 × 390
pnpm shots --out ~/vale-shots --demo                           # the desktop demo build (VITE_DEMO_APP=1)
SP=<scratch folder> pnpm shots --sean                          # Sean's set, at 2×, in $SP/shots/built/vale
pnpm shots --list                                              # the scene names
```

- **What it shows.** The built app (`apps/web/dist`, the real UI code) on its sample data (`apps/web/src/core/demo*.ts`), in Chromium through `playwright-core`. Every scene at desktop 1440 × 900 and phone 390 × 844 (touch), light and dark, at 1×: `<scene>-<size>-<light|dark>.png`. Without `--out`, pictures go to `tools/screenshots/out` (ignored by git).
- **Sizes.** `--size` picks desktop, phone, medium (768 × 1024, touch) or landscape (844 × 390, touch), and can repeat. A scene can list its own `sizes` (one that only a phone has, or one that adds landscape) or set its own `viewport` (a small window).
- **The same on every run.** The clock is fixed at Thursday 2026-11-12, 09:16 in Los Angeles, in `en-US`; motion is off; each picture waits until the screen stops changing. Two runs of one build differ by under 100 pixels a picture, all anti-aliasing.
- **It fails loudly.** A scene that can't reach its screen, an `assert` that throws, an error on the page, or any request that leaves this machine fails that picture: it isn't saved, the log names it, and the command exits non-zero.
- **Scenes** are in `scenes/`, one file per lane: `shell`, `mail`, `search`, `calendar`, `contacts`, `notes`, `settings`, `outside` (first run, the gateway's door). **A scene lives in the file of the lane that owns the screen it drives,** and so do the helpers that know that area; `scenes/helpers.mjs` keeps the shared steps. `scenes.mjs` joins them and documents every scene option. Each scene gets to its screen the way a person would, by the names on screen. When a screen changes, fix its scene and keep its name, so before and after pictures pair up.
- **States the sample data doesn't reach** (a sync error, a team member, an empty inbox, a list still loading) come from a demo scenario: `scenario: "member"` on a scene. Scenarios live in `apps/web/src/core/demo-scenarios/<area>.ts`, one file per area, registered in `demo-scenarios.ts`. A scene can also go `offline` once the app has loaded, or picture a `loading` screen. Sample data stays in the demo and its scenarios, never in a scene.
- **Sean's set.** `--sean` takes only scenes with `sean: { kind: "drawn" | "undrawn", area, screen }`, at 2×, to `<folder>/<kind>/<area>--<screen>__<phone|desktop|landscape>__<graphite|stone>.png` (dark is graphite, light is stone). The folder is `--out`, else `$SP/shots/built/vale`. Landscape only where the scene lists it.
- **The browser** is Playwright's Chromium when it's installed, else the machine's Chrome. `VALE_SHOTS_CHROME=<path>` picks another. Other options: `pnpm shots --help`.
