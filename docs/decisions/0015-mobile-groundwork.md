# ADR-0015 · Mobile groundwork and new mail on phones (Phase 5)

- **Status:** Accepted for the groundwork. The device spike from [ADR-0002](0002-shells.md) is still to run ([checklist](../mobile-spike.md)).
- **Date:** 2026-10-14
- **Builds on:** [ADR-0002](0002-shells.md), [ADR-0013](0013-google.md), [ADR-0014](0014-microsoft.md)

This cloud environment can't build or run mobile apps. Its Linux machine has no Xcode, and Android's SDK downloads are blocked here. So Phase 5 splits in two:

- **This groundwork:** everything that can be built and tested without a phone.
- **The device spike:** ADR-0002's four exit criteria, run on real iPhones and Android phones.

## Decisions

### New mail on phones: two ways, the person picks

Phones don't let an app hold a mail connection open in the background. The desktop's IMAP IDLE, JMAP push, and 30-second polling don't carry over. Push services (APNs, FCM) can wake the app, but only when a server sends the push. A local-first app has no server, so it offers both:

| | Periodic (default) | Through your relay |
|---|---|---|
| **Needs** | Nothing | A small server you run (Docker), behind https |
| **How fast** | When iOS or Android lets the app run: usually 15 minutes to a few hours | Seconds |
| **Who holds what** | Only the phone | The relay holds app passwords for IMAP and JMAP accounts. It never holds OAuth tokens or mail. |
| **Gmail** | Periodic | Periodic: Gmail push needs a Google Cloud Pub/Sub topic |

- **Periodic:** the OS wakes the app through iOS background refresh or Android WorkManager. The app runs one bounded pass, `background_pass`:
  - Mail sync and Outlook subscription renewal, inside a 25-second budget.
  - A local notification for mail that's new since the pass before.
  - The notification is written on the phone, from the phone's own copy.
- **The relay** (`tools/push-relay`) is Rust on the same `pim-core` as the app:
  - **IMAP accounts:** an IDLE connection to the inbox, the desktop's own code.
  - **JMAP accounts:** the server's EventSource stream. A new `wait_for_state` returns the state it saw, so a watcher with no store can resume.
  - **Outlook:** Microsoft calls the relay. The phone holds the Graph subscription and renews it, because only the phone has a Microsoft sign-in. The relay never holds OAuth tokens, so refresh-token rotation never fights between two holders.
  - **Pushes are content-free:** an opaque account key and the word "mail". The phone syncs and decides what to show.
  - **It pushes three ways:**
    - APNs, as a background push with token auth (ES256).
    - FCM HTTP v1, as a data message, with a service account (RS256).
    - UnifiedPush, as a plain POST. Android without Google can use ntfy, so a fully self-hosted path exists.
  - **Pushes per mailbox are at least 15 seconds apart.** A change inside that window is pushed when it ends, so the last arrival is never missed.
  - **A device the push service says is gone** (APNs 410, FCM `UNREGISTERED`, UnifiedPush 404/410) is forgotten.
  - **Secrets are sealed at rest** with AES-256-GCM under `RELAY_KEY`, never sent back, and the file is mode 0600.
  - **Every `/v1` call needs the relay token.** Graph's webhook is open, but only notifications carrying the watch's random client state push, under an unguessable hook path.
- **Why not one built-in relay for everyone:** it would make a server of ours hold everyone's app passwords. That's the thing this app avoids (ADR-0004). It would also need a Google security assessment (ADR-0013). Self-hosting keeps the trust with the person.

### Platform seams, so the phone builds plug in

The shell has these, and they work on desktop today:

- **`set_push_target`:** the iOS or Android layer reports its APNs or FCM token. Token rotation is forwarded to the relay.
- **`background_pass`:** what the OS calls on a background wake or a push.
- **Relay registration, watches, and Outlook subscriptions** (`push.rs`), driven by the Accounts setting.
- **Adding or removing an account updates the relay.** Removing one stops its Outlook subscription while its sign-in still works.

What's left for the device spike:

- **iOS:** the Swift side that registers for remote notifications and schedules `BGAppRefreshTask`.
- **Android:** the Kotlin side for FCM, UnifiedPush registration, and `WorkManager`.
- **Keychain on Android:** move to `keyring` 4, which adds an Android store (ADR-0002, criterion 3).

### Long lists and the keyboard (ADR-0002, criterion 4, the half a browser can test)

- **The mail list is virtualized** with `@tanstack/react-virtual`: only the rows on screen render, about 12 to 21 of them.
- **The list pages as you scroll,** 200 conversations at a time. `MessageQuery.offset` is new, ordered by date and then id, so pages never overlap or skip.
- **The old 200-row cap is gone.** Before, any list stopped at 200 conversations, on every platform. Older mail was reachable only by searching.
- **The composer stays above the on-screen keyboard:**
  - **Android:** `interactive-widget=resizes-content` makes it resize the page.
  - **iOS:** iOS overlays the keyboard instead, so `--keyboard-inset` tracks the visual viewport, and the composer sheet ends at the keyboard's top edge.

### Fixed along the way

- The store's 200-row list cap, above.
- **The app's relay client** silently dropped every watch status. The relay's reply puts `kind` beside the status, and the client expected it inside. The client test against the real relay caught it.

## Verified

- **Rust:** 124 core unit tests (+2: paging, the relay client).
- **Relay, offline, in CI:**
  - **API:** health, and the token check.
  - **Watching:** a JMAP mailbox over a fake EventSource. The first state is only recorded, and the next one pushes.
  - **Pushes:** content-free, with a burst collapsed into one trailing push. A wrong password reported, not pushed.
  - **Secrets:** sealed, never echoed.
  - **Outlook's webhook:** validation echo, forged and unknown notifications ignored, the real one pushed, and a stable hook on re-registration.
  - **APNs:** headers, and the ES256 JWT verified with the key's public half. A gone token forgets the device.
  - **FCM:** the RS256 assertion verified with an openssl-generated key, the access token reused, and a data message with no notification.
  - **Cleanup:** watch and device removal stop their tasks.
- **The app's client against the real relay:** registration refusals in the relay's own words, an IMAP watch whose down server shows as an error, a stable Outlook watch, unwatch, and forget.
- **Real IMAP:** the relay pushed for a message delivered to Dovecot over IDLE. This test is ignored by default and runs in the `mail-integration` CI job.
- **Docker:**
  - **Runtime stage checked:** I built the binary here, then ran it in the image's `debian:bookworm-slim` runtime stage. It runs as an unprivileged user, the health check passes, and `relay.json` is mode 0600 and survives a restart.
  - **Build stage not checked:** it couldn't fetch crates here, because containers can't use this environment's proxy. It will on a normal network.
- **Playwright, phone emulation (iPhone 13), 20 checks:**
  - **Long list:** 10,006 conversations reachable by scrolling, with only visible rows rendered. Steady scrolling ran at 61 fps with no frame over 50 ms. That's headless software rendering, so treat it as indicative; the device spike measures it for real.
  - **Keyboard:** with a simulated iOS keyboard, the composer ends exactly at the keyboard's top edge and gives the space back when it closes.
  - **The setting:** plain http refused, accounts listed, a test push, and back to periodic.
  - **All 12 earlier suites still pass.**
- **Not verified:** anything on a real phone. That's the device spike.

## Not yet

- **The device spike** ([checklist](../mobile-spike.md)), including the iOS and Android push and background code.
- **Gmail through the relay,** with a Pub/Sub topic you own.
- **iOS's Notification Service Extension,** for alert pushes that survive force-quit. Background pushes are throttled and stop after force-quit.
- **End-to-end encryption of relay payloads.** They carry nothing private today.
