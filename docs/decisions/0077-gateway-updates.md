# ADR-0077 · The gateway says when a newer image is out

- **Status:** Accepted
- **Date:** 2026-11-08
- **Builds on:** [ADR-0016](0016-web-gateway.md) (the web gateway), [ADR-0063](0063-shared-inbox.md) (the owner and the team), [ADR-0076](0076-automatic-updates.md) (desktop updates through the shared kit)

Sean approved one way for all his apps to update (the unified updates proposal, 2026-11-08). Servers get it in a server's form (U5): **Check for updates**, then **Update** (pull the new image and restart) and **Reload** (restart the containers). A server can't swap its own image while it runs, and Update and Reload need a helper on the host, which comes later. This step builds the parts that need no host access: a published image, the check, and where the owner sees it. The Lockdown server did the same (its doc 61, D690).

## Decisions

### The gateway's version

- **The gateway keeps its own version,** `version` in `apps/gateway/Cargo.toml` (0.1.0 today). It isn't the desktop app's: the two ship on their own, and a desktop build can fail while the image is fine, or the other way round.
- **An image build is stamped** `<that version>-main.<commit time, UTC, YYYYMMDDHHMMSS>`, like the desktop's main builds (`0.1.0-main.20261108093000`). The workflow passes it as the build argument `VALE_GATEWAY_VERSION`, which the binary reads at compile time (`option_env!`). The image's `org.opencontainers.image.version` label carries the same.
- **A build without the stamp is "from source"** (a checkout, `docker compose up --build`, CI's image check, the tests). It reports the crate's version, follows no channel and never checks; Settings says why.

### Where "newer" comes from

- **From a manifest written beside the image, after the image is in the registry.** Every push to `main` runs `.github/workflows/gateway-image.yml`: it builds the image, checks the container starts and reports its version, pushes `ghcr.io/snds/vale-gateway:<version>`, moves `:main` to the same digest, attests its build provenance, and only then writes `latest.json` (`version`, `image`, `digest`, `commit`) to the rolling **`gateway-main`** pre-release of snds/Vale. So the manifest can't name an image that isn't there.
- **Not the desktop's `vale-main` on snds/releases** (ADR-0076). That channel is published by another job, from another build, on a different version, and stays a dry run until its secrets are in. Reading it could offer an image that doesn't exist.
- **Not the registry's tag list.** ghcr.io needs a token dance and paging to list tags, and isn't one of the kit's GitHub hosts. The release asset is one plain `GET` from `github.com` and its asset hosts, the same rule the desktop app follows.
- **On snds/Vale itself, not snds/releases.** The repository is public, so `GITHUB_TOKEN` (`packages: write`, `contents: write`) does it all, with no stored secret, like the `demo-mac` pre-release (ADR-0072).
- **It never goes backwards.** A run for an older commit (a re-run) still pushes its version tag, but leaves `:main` and the manifest alone when the published version is newer. One concurrency group keeps two runs from moving them at once.

### The check

- **The shared kit's rules** (`snds-app-updates`, pinned to tag `v0.1.0`, no `tauri` feature; `apps/gateway/src/updates.rs`). The channel comes from the running version. The manifest and every redirect must be https on GitHub's hosts, at most five redirects. Only a strictly newer version counts, in semver order, so a release sorts after its own main builds.
- **It sends nothing about the gateway:** one `GET` with `accept: application/json` and the user agent `vale-gateway`. No version, no address, no account. It uses the core's TLS setup (ring, the built-in roots).
- **At start and every six hours** while **Check for updates automatically** is on, and whenever the owner presses **Check for updates**. The switch is the core's device setting `updates.autoCheck`, the same key the desktop app keeps, on by default.

### Where the owner sees it

- **Settings → Gateway updates,** for the owner on a gateway: Settings is where the gateway is already managed (Team members, signing out). It shows the version and channel, one status line, **Check for updates**, the switch, and the last check. When a newer image is out, it shows the command `docker compose pull && docker compose up -d` (with Copy), which image it pulls, and a note that one-click Update and Reload come with a helper on the server's host.
- **The API** behind it, owner only (a team member gets 403, no session 401, writes need `X-Vale: 1`): `GET /api/updates`, `POST /api/updates/check` and `POST /api/updates/auto` (`{"on": bool}`). Each answers the same status, with the line to show. `/healthz` and `/api/session` are unchanged: they need no sign-in, so they don't say the version.
- **No Docker socket and no self-restart.** The gateway only says. Updating stays a person's command, or the host helper's later.

### compose.yaml

- **`image: ghcr.io/snds/vale-gateway:main`,** with `build:` kept. `docker compose up -d` runs the published image, `docker compose up -d --build` builds this checkout instead, and `docker compose pull && docker compose up -d` updates.

## Not in this step

- **Update and Reload buttons.** They need the restart helper on the Unraid host (lane D item 3), which Sean installs.
- **A stable channel** for tagged releases. The kit has one; the gateway follows `main` for now.
- **Images for other architectures.** The workflow builds `linux/amd64` only, the runner's own.

## Verification

- `cargo test -p vale-gateway`: the manifest rules (only strictly newer, garbled or huge refused), the hosts (GitHub over https only, the registry and other hosts refused, at most five redirects), a main build checking the manifest beside the image, a build from source never checking, the switch on by default and kept in the core, and the API end to end (owner sees and checks; member 403; stranger 401; the header required; the command shown for a newer image). `cargo clippy -p vale-gateway --all-targets -- -D warnings` is clean.
- `tsc -b`, `oxlint` and `vite build` for the Settings section.
- The workflow's YAML parses and its scripts pass `shellcheck`; its first run on `main` is the end-to-end test (push, digest, `:main`, `latest.json`).
