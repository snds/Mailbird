# Mobile device spike

The four exit criteria from [ADR-0002](decisions/0002-shells.md), checked on real devices. Failing any of them moves mobile to Capacitor. The groundwork ([ADR-0015](decisions/0015-mobile-groundwork.md)) is done, so the spike only has to cover what needs a phone.

**Devices:** one iPhone (iOS 18 or later), and one Android phone with Google Play services. Optionally a second Android phone without Google, for UnifiedPush.

## 0. Build

- [ ] **macOS:** Xcode, plus the Rust targets: `rustup target add aarch64-apple-ios aarch64-apple-ios-sim`.
- [ ] **Android:** Android Studio, the NDK, and the Rust targets: `rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android`.
- [ ] **Scaffold:** `pnpm tauri ios init` and `pnpm tauri android init` in `apps/web`. The app runs and the inbox shows sample mail.
- [ ] **Add a real account** (iCloud or Fastmail) and watch it sync.

## 1. Background sync

- [ ] **iOS:** register a `BGAppRefreshTask` that calls the `background_pass` command. Debug it with `e -l objc -- (void)[[BGTaskScheduler sharedScheduler] _simulateLaunchForTaskWithIdentifier:@"…"]`.
- [ ] **Android:** schedule a periodic `WorkManager` job (15 minutes, the platform minimum) that calls `background_pass`.
- [ ] **Pass:** send yourself mail with the app closed. Within one background run there's a local notification, and the message is in the inbox when you open the app.
- [ ] **Pass:** a pass finishes within its 25-second budget on a slow network (`finished: true` in the result, or it stops cleanly).

## 2. Push

- [ ] **Relay up:** start it with Docker on a server you own, behind https (`tools/push-relay/README.md`).
- [ ] **iOS:**
  - [ ] Register for remote notifications, and pass the APNs token to `set_push_target` as `{"platform":"apns","token":…,"sandbox":true}` for a debug build.
  - [ ] Set up the relay with an APNs key.
  - [ ] Handle the background push by calling `background_pass`.
- [ ] **Android with Google:** get the FCM token, then `set_push_target` with `{"platform":"fcm","token":…}`. On a data message, run `background_pass`.
- [ ] **Android without Google:** register with a UnifiedPush distributor (ntfy) and enter its endpoint in the setting.
- [ ] **Pass:** with the app in the background, new mail notifies within about 10 seconds:
  - [ ] for an IMAP account,
  - [ ] for a JMAP account,
  - [ ] for an Outlook account (needs `RELAY_PUBLIC_URL`).
- [ ] **Pass:** **Send a test** arrives. A deleted app's token gets forgotten by the relay.
- [ ] **Note** how iOS treats background pushes in Low Power Mode and after force-quit. This decides whether to add a Notification Service Extension.

## 3. Keychain

- [ ] **iOS:** passwords and OAuth tokens save and survive a restart (`keyring` with `apple-native`).
- [ ] **Android:** move to `keyring` 4 (Android Keystore). Same check.
- [ ] **Pass:** removing the app removes its secrets. Reinstalling asks you to sign in again.

## 4. Scrolling and input

- [ ] **Long list:** sync, or use the demo's `?bulk=10000`, then scroll the inbox top to bottom with Instruments (iOS) or the GPU profiler (Android).
- [ ] **Pass:** 60 fps on a mid-range phone, no dropped frames when a page loads, and swipe actions still work.
- [ ] **Keyboard:** open the composer and type in the body.
- [ ] **Pass:** the formatting bar and Send stay visible above the keyboard on both platforms, including with the keyboard's suggestion bar and after rotating.

## Outcome

Record what passed, what didn't, and any workarounds in ADR-0002. Then either continue on Tauri mobile, or start the Capacitor fallback with UniFFI bindings to the same `pim-core`.
