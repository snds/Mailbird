# Push relay

A small server you run yourself, so new mail reaches your phone within seconds. It's optional: without it, the phone checks for mail on the schedule iOS and Android allow ([ADR-0015](../../docs/decisions/0015-mobile-groundwork.md)).

## How it works

- **It watches your mailboxes,** with the same code the desktop app uses:
  - **IMAP accounts** (iCloud, most hosts): an IDLE connection to the inbox.
  - **JMAP accounts** (Fastmail): the server's push stream.
  - **Outlook:** Microsoft calls the relay itself, through a subscription your phone sets up.
  - **Gmail** isn't watched yet. Gmail's push needs a Google Cloud Pub/Sub topic, so Gmail accounts keep the phone's own schedule.
- **It wakes the phone with an empty push.** The push names an opaque account key, never an address, sender, or subject. The phone then syncs by itself and decides what to show.
- **It pushes three ways:**
  - **APNs** for iPhone and iPad.
  - **FCM** for Android with Google Play services.
  - **UnifiedPush,** a plain HTTPS POST: for Android without Google, through [ntfy](https://ntfy.sh) or any UnifiedPush distributor.
- **It holds app passwords** for the IMAP and JMAP accounts it watches. They're sealed with `RELAY_KEY` (AES-256-GCM), never sent back, and only used to watch the inbox. Use app-specific passwords, which you can revoke on their own.

## Run it with Docker

On a machine that's always on (a home server, a NAS, or a small VPS):

```sh
cd tools/push-relay
cp .env.example .env
# In .env: RELAY_TOKEN=$(openssl rand -base64 24) and RELAY_KEY=$(openssl rand -base64 32)
docker compose up -d
```

- **Ports:** the relay listens on `127.0.0.1:8787` only. Put a proxy that handles TLS in front of it: Caddy, nginx, Tailscale Funnel, or Cloudflare Tunnel.
- **The app only connects over `https://`,** except to this machine for testing.
- **Data:** the container runs as an unprivileged user, and its data lives in the `relay-data` volume.

A minimal Caddy setup:

```
relay.example.com {
	reverse_proxy 127.0.0.1:8787
}
```

### Without Docker

```sh
cargo build --release -p mailbird-push-relay
RELAY_TOKEN=… RELAY_KEY=… ./target/release/mailbird-push-relay
```

## Settings

| Variable | Needed for | What it is |
|---|---|---|
| `RELAY_TOKEN` | always | The secret every device signs in with, 16+ characters. |
| `RELAY_KEY` | always | 32 bytes, base64. Seals stored app passwords. Keep it out of backups of the data folder. |
| `RELAY_DATA` | | Where `relay.json` lives. Default `./data` (`/data` in Docker). |
| `RELAY_ADDRESS` | | Where to listen. Default `127.0.0.1:8787` (`0.0.0.0:8787` inside Docker). |
| `RELAY_PUBLIC_URL` | Outlook | The relay's public `https://` address. Microsoft calls `…/graph/…` on it. |
| `APNS_KEY_FILE`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_TOPIC` | iPhone, iPad | An APNs auth key (`.p8`) from your Apple developer account, its key id, your team id, and the app's bundle id. |
| `FCM_SERVICE_ACCOUNT_FILE` | Android with Google | The service-account JSON key from the Firebase project the app is built with. |

APNs and FCM need credentials from whoever builds the app, because Apple and Google only deliver pushes to apps signed by the account that sent them. If you build the app yourself, use your own. UnifiedPush needs nothing.

## Connect a phone

In the app: **Accounts → New mail on this phone → Instant, through your relay**. Then enter the relay's address and token.

- The app registers the phone and lists each account's status: watched, waiting for a sign-in, or "checks on the phone's schedule" (Gmail).
- **Send a test** pushes the phone right away.

## Limits

- **iOS may delay or drop background pushes,** for example in Low Power Mode or after the app is force-quit. The phone's own schedule still runs.
- **One relay token per relay,** shared by your devices. To lock out a lost phone, change `RELAY_TOKEN` and re-enter it on the phones you keep.
- **The relay can sign in to the IMAP and JMAP accounts it watches.** Run it yourself, on a machine you trust.
- **Each mailbox holds a connection open** to its mail server. Some hosts limit simultaneous connections, often to about 10 per account. The phone's and the desktop's own connections count toward that limit.

## API

All `/v1` calls take `Authorization: Bearer $RELAY_TOKEN`.

| Call | What it does |
|---|---|
| `GET /healthz` | `ok` (no token). |
| `GET /v1/info` | Version, the push services set up, and whether Outlook works. |
| `PUT /v1/devices/{id}` | Registers a device: `{"platform":"apns","token":…,"sandbox":false}`, `{"platform":"fcm","token":…}`, or `{"platform":"unifiedpush","endpoint":"https://…"}`. |
| `GET /v1/devices/{id}` | Each watch's kind and status. Never secrets. |
| `DELETE /v1/devices/{id}` | Forgets the device and stops its watches. |
| `PUT /v1/devices/{id}/watches/{key}` | `{"kind":"imap"|"jmap","config":…,"secret":…}`, or `{"kind":"graph"}`, which returns the Outlook `notificationUrl` and `clientState`. |
| `DELETE /v1/devices/{id}/watches/{key}` | Stops watching one mailbox. |
| `POST /v1/devices/{id}/test` | Pushes the device now. |
| `POST /graph/{hook}` | Microsoft's webhook: answers the validation request, and pushes only for notifications that carry the watch's client state. |
