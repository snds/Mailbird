# Screenshots

One command takes a picture of every main screen of the web app, so a change to the look can be checked screen by screen ([ADR-0079](../../docs/decisions/0079-screenshots.md)).

```sh
pnpm shots --out ~/vale-shots              # builds apps/web, then 296 pictures (about 3 minutes)
pnpm shots --out ~/vale-shots -g calendar  # only scenes whose name contains "calendar"
pnpm shots --list                          # the scene names
```

- **What it shows.** The built app (`apps/web/dist`, the real UI code) on its sample data (`apps/web/src/core/demo*.ts`), in Chromium through `playwright-core`. Every scene at desktop 1440 × 900 and phone 390 × 844 (touch), light and dark, at 1×: `<scene>-<desktop|phone>-<light|dark>.png`. Without `--out`, pictures go to `tools/screenshots/out` (ignored by git).
- **The same on every run.** The clock is fixed at Thursday 2026-11-12, 09:16 in Los Angeles; motion is off; each picture waits until the screen stops changing. Two runs of one build differ by under 100 pixels a picture, all anti-aliasing.
- **It fails loudly.** A scene that can't reach its screen, an error on the page, or any request that leaves this machine fails that picture, and the command exits non-zero.
- **Scenes** are in `scenes.mjs`. Each gets to its screen the way a person would, by the names on screen. When a screen changes, fix its scene and keep its name, so before and after pictures pair up. Sample data stays in `apps/web/src/core/demo*.ts`, never in a scene.
- **The browser** is Playwright's Chromium when it's installed, else the machine's Chrome. `VALE_SHOTS_CHROME=<path>` picks another. Other options: `pnpm shots --help`.
