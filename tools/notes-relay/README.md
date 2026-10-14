# Notes relay

A small server that lets your devices sync Mailbird notes. It's a plain [Hocuspocus](https://tiptap.dev/docs/hocuspocus) (MIT) server. Any Hocuspocus-compatible relay works, and this one is about 70 lines you can read.

## How it works

- **Live merging.** Each note is a Yjs document. Devices connect over WebSocket and merge edits as they happen. Two people typing in one note both keep their words.
- **Catching up.** The relay saves each document to a file. A device that was offline catches up when it reconnects.
- **What syncs here.** Only notes. Mail, calendars, and contacts sync with your accounts.

## Run it

```sh
pnpm install
NOTES_RELAY_TOKEN=$(openssl rand -base64 24) pnpm --filter notes-relay start
```

| Variable | Default | What it does |
|---|---|---|
| `NOTES_RELAY_TOKEN` | (required, 16+ characters) | The secret every device signs in with |
| `NOTES_RELAY_PORT` | `1234` | Port to listen on |
| `NOTES_RELAY_ADDRESS` | `127.0.0.1` | Interface to listen on |
| `NOTES_RELAY_DATA` | `./data` | Where documents are stored |

## Put it online

- **Use TLS.** Put the relay behind a proxy that handles TLS (Caddy, nginx, or a tunnel such as Tailscale Funnel or Cloudflare Tunnel). The app only connects over `wss://`, except to `localhost`.
- **Connect each device.** In Notes, open **⋮ → Sync between devices…** and enter the address and token.
- **Back it up.** To back up or move the relay, copy the data folder.

## Limits

- **The relay can read your notes.** They're encrypted on the way, but not end to end. Run it yourself, or use one you trust.
- **One token per relay,** shared by all your devices. To lock out a lost device, change the token, then re-enter it on the devices you keep.
