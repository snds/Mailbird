# ADR-0076 · Automatic updates on the desktop

- **Status:** Accepted
- **Date:** 2026-11-08
- **Builds on:** [ADR-0002](0002-shells.md) (the Tauri shell), [ADR-0072](0072-demo-app-for-mac.md) (Vale Demo), [ADR-0075](0075-settings-page-and-shortcuts.md) (the settings page)

Sean approved one way for all his desktop apps to update (the unified updates proposal, U1–U6, 2026-11-08). Lockdown built it first, and it became a shared kit, [snds/app-updates](https://github.com/snds/app-updates). Vale moves onto it, so it updates the same way Lockdown and Fontface do.

## Decisions

### Where builds come from

- **Every push to `main` is a build** on one rolling pre-release, `vale-main`, in the shared public repo **snds/releases**. Each has a signed bundle per platform and Tauri's manifest, `latest.json`. Its version is the app's own plus the commit time in UTC: `0.1.0-main.20261108093000`.
- **CI's `release-main` job** calls the kit's reusable workflow, pinned to one commit, on pushes to `main` for macOS (universal) and Windows. Until the signing key and `RELEASES_TOKEN` are repository secrets, it's a dry run that builds and says what's missing; it never fails a push for one.
- **Vale's own key** signs every update. Its public half is committed as `apps/web/src-tauri/updater.pub` (key ID `98E8E6D6FFEA0C53`), built in by `build.rs`, and a test holds the file to that ID. A build without the file says "Updates are off in this build: it was made without the update key."

### What the app does

- **It checks at launch and every six hours,** downloads a newer build quietly, checks its signature, and offers **Restart to update**. An update not taken installs when Vale quits. Where Vale can't replace itself (a Linux package, a Windows install for everyone, a Mac folder you can't write to), it says so and links to the download.
- **The shell drives the updater from Rust** through the kit (`src-tauri/src/updater.rs`). The webview has no updater permission. The page calls the kit's five commands beside `core` (`update_status`, `update_check`, `update_restart`, `update_auto_set`, `app_reload`), and `update_open_page`, which opens only the release page the kit names. Changes arrive on `vale://update`.
- **Settings → About** shows the version and channel, the status line, **Check for updates**, **Restart to update** when one is ready (**Reload app** otherwise), and **Check for updates automatically**. The command menu has **Check for updates** (it opens About, where the outcome shows) and **Reload app**. On macOS the app menu has **Check for Updates…**. The words are the kit's, shared with Lockdown and Fontface.
- **The switch is a device setting** in the core's store (`updates.autoCheck`, beside the menu bar's), on by default. It isn't synced: each computer decides.

### Where it isn't

- **The web app and the gateway** have no updater; the gateway updates with its image. About shows only where `isTauri()` is true.
- **Vale Demo** never checks: its shell sees the demo's app id and doesn't start the updater, and its page treats itself as not Tauri.
- **Phones** update through their stores: the kit is a desktop-only dependency, and the updater code is behind `cfg(desktop)`.

## Not in this step

- **Unicron's shared update rows** (`UpdateStatusRow`, `AutoCheckSwitch`). About moves to them after unicron's next release; until then it's built from unicron's `Button`, `Icon` and `Switch` with the same words.
- **A stable channel** for tagged releases, and **the local channel** (builds from the Mac's own rebuild). The kit has both; Vale follows `main` for now.
- **Linux builds** in `release-main`. Add `linux-x64` to its platforms when wanted.

## Verification

- `cargo test -p vale-shell`: the feed, the plan (main builds check, unstamped builds say why not), the switch saved in the core and on by default, and the committed key's ID. `cargo clippy -p vale-shell --all-targets -- -D warnings` is clean.
- `tsc -b`, `oxlint`, `vite build` and `pnpm build:demo` are clean. The ratchet is flat.
