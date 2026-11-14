# ADR-0081 · Screenshots by area, more sizes, and demo scenarios

- **Status:** Accepted
- **Date:** 2026-11-14
- **Builds on:** [ADR-0079](0079-screenshots.md) (screenshots of every screen), [ADR-0016](0016-web-gateway.md) (the demo on sample mail), [ADR-0063](0063-shared-inbox.md) (team members)

The redesign rebuilds Vale in parallel lanes (shell, mail, search, calendar, contacts, notes, settings), each on its own screens. With every scene in one file and the sample data in one hot file, two lanes edit the same lines, and many states a lane must build can't be pictured at all: a sync error, a team member's view, an empty inbox, a list still loading, the desktop app's own sections. The redesign also adds a medium and a short landscape layout, and Sean reviews its screens at 2× under his own names. This is a tooling decision: no screen changes.

## Decisions

- **Scenes by lane.** `tools/screenshots/scenes.mjs` joins one file per lane under `scenes/`: `shell` (chrome, status, quick create), `mail`, `search` (mail search, ⌘K, `?`), `calendar` (with the menu-bar window), `contacts`, `notes`, `settings` and `outside` (first run, the gateway's door). A scene lives in the file of the lane that owns the screen it drives, and so do the helpers that know that area (`conversation`, `lane` and `compose` in mail; `calendars` in calendar; `person`, `note`, `settings` in theirs). `scenes/helpers.mjs` keeps the shared steps (`press`, `button`, `area`, `toastGone`, `ensure`). The 75 scene names are unchanged.
- **More sizes.** Beside desktop 1440 × 900 and phone 390 × 844: medium 768 × 1024 and landscape 844 × 390, both touch. A scene lists its own `sizes` (this replaces `only`) or sets its own `viewport`. Without `--size`, a scene that lists none still runs at desktop and phone, so the default run is the same 296 pictures.
- **Scene options.** `scenario` names a demo scenario (or a list), written to `sessionStorage["vale.demo.scenario"]` before the app loads; `offline` drops the connection once the app has loaded; `loading` lets a picture of a loading screen through (skeletons and `aria-busy` no longer hold it back); `assert(app)` runs on the still screen before the picture, and a throw fails it. A failed picture is never saved. `-g` can repeat (any match runs).
- **`--demo`** builds the desktop demo (`build:demo`, `VITE_DEMO_APP=1`) instead.
- **`--sean`** takes only scenes with `sean: { kind, area, screen }`, at `deviceScaleFactor` 2, to `<folder>/<drawn|undrawn>/<area>--<screen>__<phone|desktop|landscape>__<graphite|stone>.png`: dark is graphite, light is stone; landscape only where the scene lists it; medium never. The folder is `--out`, else `$SP/shots/built/vale` (the session's scratch folder), else the command stops and asks.
- **Demo scenarios.** `apps/web/src/core/demo-scenarios.ts` is a registry of named states, one file per area under `demo-scenarios/` (`shell`, `status`, `mail`, `calendar`, `contacts`, `notes`, `settings`). Only the in-memory demo client reads it, once, when it starts (`withDemoScenario`, the one hook in `demo.ts`); the desktop app's and a gateway's clients never do. A scenario receives the client and its data (accounts, messages, outbox, follow-ups) and may seed data, replace a method (`wrap`: hold a sync, fail a send, never answer a list), or set demo-only flags. An unknown name throws, so a scene with a typo fails.
- **Demo-only flags** live in `core/client.ts` (`demoFlags`), and only a scenario sets them: `member` (a person) makes `isMember()` true and `gatewayMe()` that person; `member` or `gatewayOwner` makes the demo client `remote`, as a gateway's is; `desktopApp` makes the new `isDesktopApp()` true, for UI only the desktop app shows. It never routes a call to Tauri: `isTauri()` is unchanged.
- **The first scenario:** `member` in `shell.ts`, a team member on the owner's gateway (Mail only). The other area files start empty; each lane adds its own. Sample data in a scenario is realistic and the demo's own, never a design's sample content.

## Verification

- `pnpm shots --list` prints the same 75 names (seven sit in a new place in the list: the two mail searches, ⌘K and `?` follow mail; the mini calendar follows calendar). `pnpm shots` takes 296 of 296 pictures, and every one matches the set taken before this change (under 100 differing pixels each; in fact none differ).
- `-g mail-inbox -g calendar-week` takes exactly those two scenes (8 pictures); `--size medium` and `--size landscape` write 768 × 1024 and 844 × 390 pictures; a scene's own `viewport` gives 320 × 480.
- Trial scenes, not committed: an `assert` that only Mail is in the navigation passes under `member` and fails without it; a scene that throws, and one naming an unknown scenario, fail the run (exit 1) by name; `--sean` writes `undrawn/<area>--<screen>__{phone,desktop,landscape}__{graphite,stone}.png` at 780 × 1688, 2880 × 1800 and 1688 × 780; `--demo` shows the demo bar; trial scenarios showed a sync error, an empty inbox, the owner's gateway sections, a held summary (fails without `loading`, passes with it) and a team member's settings with their name.
- `tsc -b`, `oxlint`, both builds and the notes relay tests are clean. The scenarios ship only in the lazy demo chunk. No `className` or element was added under `apps/web/src`: the ratchet stays at 208 / 2 / 0 / 16 (counted by reading the source; CI runs `dsa`).

## Consequences

- **Each lane edits its own scene file and scenario file,** so parallel lanes don't collide in `scenes.mjs` or `demo*.ts`. A lane that renames a control still fixes its scenes in the same commit.
- **States that had no picture can have one now:** a lane adds a scenario and a scene for its error, empty, loading and limited states.
- **Offline is the browser's offline.** React Query pauses reads while the browser says it is offline, so a screen that needs a new read shows its loading state; such a scene also sets `loading`.
- **Not covered:** the gateway's own endpoints (`/api/updates`, `/api/members`) aren't core client methods, so a scenario can't answer them; a scene that opens Gateway updates needs its own route stub. `desktopApp` has no reader in the UI yet.
