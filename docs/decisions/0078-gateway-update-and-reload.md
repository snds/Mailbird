# ADR-0078 · Update and Reload through the host helper

- **Status:** Proposed
- **Date:** 2026-11-08
- **Builds on:** [ADR-0077](0077-gateway-updates.md) (the gateway says when a newer image is out), [ADR-0063](0063-shared-inbox.md) (the owner and the team)

ADR-0077 left **Update** and **Reload** for later: a server can't swap its own image while it runs, and the gateway must never hold the Docker socket. The host helper now exists (snds/app-updates `host-helper/`, merged as `c0ff0bf` in PR #4). It runs beside the gateway on the Unraid host, holds the socket, and does three things for a server that signs its request with its own key: status, update (pull an allowed tag of the server's own image, check its digest, recreate the container) and restart. Its allow-list decides what it touches; its README holds the protocol, the threat model and the install steps. This step wires the gateway to it. The Lockdown server does the same (its doc 61 §6, D691).

## Decisions

### How the gateway reaches the helper

- **Through the helper's own client,** `snds-app-updates-host-helper` with `default-features = false` (the client and the protocol, no allow-list or Docker code), pinned by commit `c0ff0bf` until the helper is tagged. Every request is signed with the stack's key over the method, path, stack, time, a random nonce and the body; the client ignores a successful answer that isn't signed with the same key over the request's nonce.
- **Its settings are three environment variables** from the stack's `host-helper.env`: `HOST_HELPER_URL` (`http://host-helper:7480`, on the helper's internal network), `HOST_HELPER_STACK` (`vale-gateway`) and `HOST_HELPER_KEY`. The helper's `compose.override.yaml`, beside `compose.yaml`, hands them in and joins the network (`apps/gateway/src/helper.rs`). The gateway reads them once at start. None set: off. Some set but unusable: Settings says what's wrong, in the client's words, never the key. The key is never logged, shown or stored by the gateway.
- **`compose.yaml` doesn't change** but for a comment. The helper's README publishes the override file, so `docker compose up -d` works the same with or without the helper.

### What the owner sees

- **Settings → Gateway updates,** owner only, as before. With the helper set up: **Update to {version}** when a newer image is out, and **Reload** always. Without it: the command, as before, and "One-click Update and Reload need the host helper beside the gateway: its install steps." (a link to the helper's README). The API says which buttons to show (`canUpdate`, `canReload`), so the rule lives in one place and is tested in Rust.
- **Update** asks the helper for the version on offer, with `expect_digest` set to the `digest` that `latest.json` names (the image workflow writes it after the push). If the pulled image's digest differs, the helper refuses and nothing restarts. The tag must be the one on offer now; anything else is refused before the helper ("The version on offer has changed. Check for updates again.").
- **Reload** asks the helper to restart the container on the build it runs.
- **Then Settings waits.** The helper's work replaces the gateway's process under the request, so the answer usually never comes back. The API answers `202` at once and asks the helper on a plain thread (the runtime's shutdown never waits for it). Settings looks at `GET /api/updates` every two seconds: a failed request is "Reconnecting… the gateway is restarting."; a `401` means the gateway came back (sign-ins live in its memory) and offers **Sign in again**; a new version is "Vale gateway {v} is running."; a refusal shows its words. It stops after 15 minutes and points to the helper's log.
- **Refusals read in plain words** (`helper::explain`): a version the allow-list doesn't allow, an image that isn't the build the release names, an update already running, too many requests, clocks more than 90 seconds apart, a key the helper doesn't recognise, Docker failing. Anything else, and an unreachable helper, is the client's own sentence.

### Who may, and the record

- **The owner only, with `X-Vale: 1`:** a team member gets 403, no session 401, a write without the header 403 — the same rule as every other owner write (ADR-0063).
- **One at a time.** A second Update or Reload while one runs is refused; a stuck one stops blocking after the client's 20-minute limit plus a minute.
- **The gateway's log** gets one line when the owner asks ("the owner ({name}) asked the host helper for an update to {v}") and one when this process sees the outcome ("… finished …" or "… didn't happen: {why}"). The gateway has no separate audit table; the container's log is the record. Never the key.

## Not in this step

- **Status** (the helper's view of the running image) isn't shown yet; the running version already is.
- **Warpcore** joins once its image and deploy form are agreed (the helper's README).
- **Rollback** is "update to the older version tag" by hand, as the helper's README says.

## Verification

- `cargo test -p vale-gateway`: the helper's settings (none is off, half say what's wrong without the key), refusals in words, the manifest's digest read only when well formed, the buttons following the helper and the offer, one action at a time, and the API end to end with a fake helper (stranger 401, member 403, no header 403; a tag not on offer refused before the helper; Update sends the offered tag and the manifest's digest and answers 202; Reload; a digest refusal in words; without the helper, no buttons, the command, and Reload refused). `cargo clippy -p vale-gateway --all-targets -- -D warnings` is clean.
- `oxlint` and the dsa ratchet (flat) for the Settings section.
- **Only Sean's Unraid server can test** the real round trip: the signed call over `host-helper-vale-gateway`, the pull and recreate replacing the process, the page across a real restart behind his reverse proxy, and the clocks agreeing. The helper's install step 5 checks the connection first.
