# Notes relay

A small server that lets your devices sync Mailbird notes. It's a plain [Hocuspocus](https://tiptap.dev/docs/hocuspocus) (MIT) server. Any Hocuspocus-compatible relay works, and this one is about 250 lines you can read.

## How it works

- **Live merging.** Each note is a Yjs document. Devices connect over WebSocket and merge edits as they happen. Two people typing in one note both keep their words.
- **Catching up.** The relay saves each document to a file. A device that was offline catches up when it reconnects.
- **What syncs here.** Only notes. Mail, calendars, and contacts sync with your accounts.
- **Shared notes** ([ADR-0056](../../docs/decisions/0056-shared-notes.md)). A note you share by link gets its own document here. The link carries a token for that one note, derived from the relay's token, so the relay stores no extra secrets. Your devices tell the relay which links still work, and whether each can edit; it refuses stopped links, connects view-only links read-only, and drops guests the moment you stop sharing. A link opened in a browser lands on a short page here (`/share`) that explains how to open it in Mailbird.
- **Shared conversations** ([ADR-0060](../../docs/decisions/0060-team-conversations.md)). A conversation you share with teammates works the same way: its own document here (a copy of the messages, the team's comments, and the reply you write together), a link with a token for it alone, and your devices' list of which links still work. Each share's files (a note's images, a conversation's shared attachments) sit beside it in `shared/<id>/files`, which the same link opens ([ADR-0061](../../docs/decisions/0061-presence-and-shared-files.md)).
- **End-to-end encryption** ([ADR-0062](../../docs/decisions/0062-end-to-end-encrypted-sync.md)), when you turn it on. Your devices then sync encrypted documents (`mailbird/x/…`): the relay keeps each as a log of encrypted updates (a `.log` file) and passes them along, but has no key to open them. The list of which links still work moves to `mailbird/registry`, which names only share ids.

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

- **The relay can read your notes, unless you turn on end-to-end encryption.** They're always encrypted on the way. With end-to-end encryption on (in **Sync between devices**), the relay keeps them as encrypted logs it can't open, and deletes its readable copies for good ([ADR-0062](../../docs/decisions/0062-end-to-end-encrypted-sync.md)). It still sees how many documents there are, their sizes, when they change, and which share links are live.
- **Once encrypted, always encrypted.** The data folder gets a `SEALED` file and the relay refuses readable documents from then on. To go back, start a fresh data folder.
- **People you share with connect here.** To share notes or conversations with others, the relay has to be reachable from their devices, not only yours.
- **One token per relay,** shared by all your devices. To lock out a lost device, change the token, then re-enter it on the devices you keep.
