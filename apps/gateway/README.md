# Web gateway

Mailbird in a browser, with your real accounts. The gateway is a small server you run yourself. It does everything the desktop app does: it syncs your accounts, keeps the mail database, and sends mail. It also serves the web app. The browser only shows the app and talks to the gateway ([ADR-0016](../../docs/decisions/0016-web-gateway.md)).

Without a gateway, the web app runs as a demo with sample mail.

## How it works

- **The same code as the desktop app.** The gateway and the desktop app share one command layer (`crates/app`). A command in the browser runs exactly what a click in the desktop app runs.
- **One password.** You sign in with `GATEWAY_PASSWORD`. The browser gets a session cookie that scripts can't read (`HttpOnly`) and that other sites can't send (`SameSite=Strict`).
- **Live updates.** New mail, sync status, and changes from other devices reach the page through an event stream (`/api/events`).
- **Passwords are sealed.** Account passwords and sign-in tokens are encrypted with `GATEWAY_KEY` (AES-256-GCM) in `secrets.json`. Only the gateway's user can read that file or the mail database.

## Run it with Docker

On a machine that's always on (a home server, a NAS, or a small VPS):

```sh
cd apps/gateway
cp .env.example .env
# In .env: GATEWAY_PASSWORD=$(openssl rand -base64 24) and GATEWAY_KEY=$(openssl rand -base64 32)
docker compose up -d
```

The image builds the web app and the gateway together, so there's nothing else to install.

- **Ports:** the gateway listens on `127.0.0.1:8080` only. Put a proxy that handles TLS in front of it: Caddy, nginx, Tailscale, or Cloudflare Tunnel.
- **Use https.** Cookies are marked `Secure` unless you set `GATEWAY_INSECURE_COOKIES=1`, which is only for plain http on the same machine.
- **Public booking pages.** `/book/{token}` and `/api/book/{token}` work without the password, so people can book your free times ([ADR-0026](../../docs/decisions/0026-scheduling-links.md)). They show only free times and take one booking at a time, with limits. Delete a link to turn its page off.
- **Data:** the container runs as an unprivileged user, and its data lives in the `gateway-data` volume. Back it up, but keep `GATEWAY_KEY` somewhere else.

A minimal Caddy setup:

```
mail.example.com {
	reverse_proxy 127.0.0.1:8080
}
```

### Without Docker

```sh
pnpm install && pnpm build
cargo build --release -p mailbird-gateway
GATEWAY_PASSWORD=… GATEWAY_KEY=… GATEWAY_WEB=apps/web/dist ./target/release/mailbird-gateway
```

## Settings

| Variable | Needed | What it is |
|---|---|---|
| `GATEWAY_PASSWORD` | always | What you sign in with, 16+ characters. |
| `GATEWAY_KEY` | always | 32 bytes, base64. Seals stored passwords. Changing it means signing in to each account again. |
| `GATEWAY_DATA` | | The mail database and `secrets.json`. Default `./data` (`/data` in Docker). |
| `GATEWAY_WEB` | | The built web app (`apps/web/dist`). Default `./web` (`/web` in Docker). |
| `GATEWAY_ADDRESS` | | Where to listen. Default `127.0.0.1:8080` (`0.0.0.0:8080` inside Docker). |
| `GATEWAY_INSECURE_COOKIES` | | Set to `1` for plain http on this machine only. |
| `GATEWAY_PUBLIC_URL` | | The address people reach the gateway at, like `https://cal.example`. With it, booking invitations carry a link to change or cancel the booking. Without it, the link is shown only on the confirmation page. |

## Adding accounts

Open the gateway's address, sign in, then go to **Accounts**.

- **iCloud, Fastmail, other IMAP, and other JMAP** work from anywhere. Use app-specific passwords, which you can revoke on their own.
- **Gmail and Outlook** sign in on Google's or Microsoft's page, which then returns to `127.0.0.1` on the computer running Mailbird. Behind a gateway, that's the server. So these only work in a browser on the gateway's own machine. Elsewhere, the buttons say so. A public return address is planned once Mailbird has its own verified Google and Microsoft apps ([ADR-0013](../../docs/decisions/0013-google.md), [ADR-0014](../../docs/decisions/0014-microsoft.md)).

## Security

- **Sign-in is rate-limited:** after 10 wrong passwords in 5 minutes, the gateway answers 429 until the window passes. Each wrong guess also waits half a second.
- **Every call that changes something needs the `X-Mailbird: 1` header.** Browsers won't add it to a request from another site, so it blocks cross-site request forgery even without the cookie rules.
- **Every response sets a Content Security Policy,** `X-Frame-Options: DENY`, `nosniff`, and `no-referrer`. HTML mail still renders in its own sandboxed frame with remote images blocked until you load them.
- **Sessions live in memory** and end after 30 days without use. Restarting the gateway signs every browser out.
- **Whoever has the password can read all your mail.** Pick a long one, and run the gateway on a machine you trust.

## Limits

- **One person per gateway.** There are no user accounts, only the one password.
- **No desktop notifications** from the gateway yet. Mail arrives live while the page is open.
- **Attachments download** to the browser instead of opening in another app.

## API

The browser calls these; you don't need them to use the app.

| Call | What it does |
|---|---|
| `GET /api/session` | `{"gateway":true,"signedIn":…}`. No session needed. |
| `POST /api/session` | Signs in with `{"password":…}`. Needs `X-Mailbird: 1`. |
| `DELETE /api/session` | Signs out. |
| `POST /api/core/{command}` | Runs one app command with its JSON arguments. Needs a session and `X-Mailbird: 1`. Unknown commands are 404, bad arguments 400. |
| `GET /api/events` | The event stream (Server-Sent Events). |
| `GET /api/attachments/{id}` | Downloads one attachment. |
