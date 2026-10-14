# ADR-0016 · The web gateway (Phase 6)

- **Status:** Accepted
- **Date:** 2026-10-14
- **Builds on:** [ADR-0002](0002-shells.md), [ADR-0007](0007-mail-engine.md), [ADR-0015](0015-mobile-groundwork.md)

ADR-0002 planned the web build as "a PWA that talks to a self-hostable gateway running the same `pim-core`". Until now the browser only ran the demo. Browsers can't open raw TCP sockets, so they can't speak IMAP or SMTP themselves. The gateway is that missing server: Mailbird with real accounts, in any browser, on a machine you run.

## Decisions

### One command layer for every shell

The desktop shell's 62 Tauri commands moved out of `apps/web/src-tauri` into a new crate, `crates/app` (`pim-app`). It holds the app's state, the background workers, and one dispatcher: `dispatch(app, state, name, args)`.

- **A `Host` trait** carries everything platform-specific: emitting events, notifications, opening a URL or a file, and the downloads folder.
  - The Tauri shell implements it with Tauri's event bus, notifications, and opener.
  - The gateway implements it with an event broadcast to every open page.
- **A `SecretStore` trait** carries passwords and tokens. The desktop uses the system keychain. The gateway uses a sealed file.
- **The Tauri shell is now one IPC command, `core`,** that forwards to the dispatcher. It's about 100 lines.
- **The web client has one command table** shared by every transport. Tauri, the gateway, and the demo differ only in how a call travels.

Why not keep two copies: every command the desktop gains would need a second gateway version, and they'd drift. One dispatcher means a test of a command covers both shells.

### The gateway: a small, single-person server

`apps/gateway` (`mailbird-gateway`) is axum on the same `pim-app`:

| Route | Does |
|---|---|
| `GET /api/session` | Tells the page it's behind a gateway, and whether it's signed in. |
| `POST`/`DELETE /api/session` | Signs in with the password, or out. |
| `POST /api/core/{command}` | Runs one command through the shared dispatcher. JSON in, JSON or bytes out. |
| `GET /api/events` | Server-Sent Events: the same events the desktop shell emits. |
| `GET /api/attachments/{id}` | Downloads one attachment. |
| everything else | The built web app, with a single-page fallback. Unknown `/api/*` paths are 404. |

The page the gateway serves carries `<meta name="mailbird-gateway">`. The web app asks for a session only when it sees that mark. On a plain static host (the demo), it makes no API calls at all, so it logs no 404s.

- **One password, no user accounts.** The gateway is for one person, like the relay. Multi-user would mean per-user stores, quotas, and admin screens. That's a different product.
- **Sessions are random 256-bit tokens in memory,** in a cookie marked `HttpOnly`, `SameSite=Strict`, and `Secure` (unless you opt out for plain http on one machine). They end after 30 days without use, or when the gateway restarts.
- **Server-Sent Events instead of WebSockets.** Events only flow from server to page. SSE rides plain HTTP, reconnects by itself, and passes through any proxy.

### Security

- **CSRF:** every call that changes something needs `X-Mailbird: 1`. Browsers can't add a custom header to a cross-site request without a CORS preflight, and the gateway answers no preflights. The cookie's `SameSite=Strict` is a second layer.
- **Brute force:** 10 wrong passwords in 5 minutes locks sign-in for the rest of the window (429). Each failure waits 500 ms. Passwords compare in constant time.
- **Headers on every response:** a Content Security Policy (scripts only from the gateway, no framing), `X-Frame-Options: DENY`, `nosniff`, and `no-referrer`. HTML mail still renders in its sandboxed frame. The browser test confirmed the tracker image stays blocked.
- **Secrets at rest:** account passwords and OAuth tokens are sealed with `GATEWAY_KEY` (AES-256-GCM, a fresh nonce for each value) in `secrets.json`, mode 0600. The data folder is mode 0700.
- **Google's CASA assessment** applies when restricted Gmail data reaches *our* servers. A gateway is the user's own server, so the reasoning in ADR-0002 still holds. We publish no hosted gateway.

### Sign-in with Google and Microsoft

Both providers return to `127.0.0.1` on the computer that started the sign-in, which is the gateway's machine. The gateway sends the provider's page to the browser as an `open-url` event. So OAuth only completes when the browser runs on the gateway's own machine. Elsewhere, the Gmail and Outlook buttons are disabled and say why.

A public return address (`https://your-gateway/oauth/callback`) would need a "web application" OAuth client per gateway, or our verified apps allowing arbitrary redirects. Neither exists yet. This waits on Google verification ([ADR-0013](0013-google.md)).

### Packaging

- **One Docker image** builds the web app and the gateway, and runs as an unprivileged user with a health check, like the relay.
- **CI now builds both images from a clean checkout** and starts the gateway's. Writing this image turned up a bug in the relay's:
  - It had never built with `--locked`, because stubbing the desktop shell drops the shell's packages from `Cargo.lock`.
  - This environment can't fetch packages inside Docker, so Phase 5 couldn't catch it.
  - Both Dockerfiles now build without `--locked`. Every remaining version still comes from the lock file. A check found that nothing but the stubbed packages changes.

## Verification

- **`cargo test -p pim-app`:** every command name routes, and commands emit their events through the host.
- **`cargo test -p mailbird-gateway`** over real HTTP covers:
  - session states, the CSRF header, and cookie flags
  - unknown commands and bad arguments
  - an event arriving on the stream after a change
  - secrets sealed on disk (unreadable with another key, mode 0600)
  - attachments, the single-page fallback, security headers, sign-out, and the rate limit
- **A browser run (Playwright, Chromium)** against the release binary with real Dovecot IMAP and an SMTP sink:
  1. Sign in, after a wrong password.
  2. Add the account through the IMAP form.
  3. Watch mail arrive over the event stream.
  4. Read an HTML newsletter.
  5. Archive it on the server.
  6. Send through SMTP.
  7. Reload and stay signed in.
  8. Sign out.

  There were no page errors. Opened from another hostname, the Gmail and Outlook buttons are disabled and say why, and IMAP stays available.
- **All 13 earlier Playwright suites** pass against the demo build, so the shared command table changed nothing there.
- **The runtime image,** built from host-built pieces, starts, signs in, answers commands, and passes its health check.

## Consequences

- The web build is now a real client. The demo remains for a browser with no gateway behind it.
- Desktop notifications, opening attachments in other apps, and Gmail/Outlook sign-in from another machine don't work through the gateway yet.
- New commands are written once, in `crates/app`, and appear in both shells.
