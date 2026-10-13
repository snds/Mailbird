# ADR-0002 · Platform shells

- **Status:** Accepted for desktop. Mobile is a time-boxed spike.
- **Date:** 2026-10-13

## Decision

- **Desktop (Windows, macOS, Linux):** Tauri 2. The Rust core runs in-process. Installers are small and use the system WebView.
- **Mobile (iOS, iPadOS, Android):** Tauri 2 mobile, **validated by a spike first**. If it fails, fall back to **Capacitor 8**, calling the same Rust core through UniFFI-generated Swift/Kotlin bindings.
- **Web:** an installable PWA. It talks to a self-hostable gateway that runs the same `pim-core`.

## Spike exit criteria (Tauri mobile)

1. **Background sync:** iOS BGAppRefresh and Android WorkManager can run a core sync.
2. **Push:** an APNs/FCM wake-up for new mail.
3. **Keychain:** Keychain and Keystore access through `keyring` or a small plugin.
4. **Scrolling and input:** a 60 fps message list with 10k rows, plus correct keyboard avoidance in the composer.

Failing any of these moves mobile to Capacitor.

## Why

- **One Rust core everywhere:** IMAP, SMTP, JMAP, DAV, SQLite, and search are written once.
- **Permissive licensing:** Tauri is MIT OR Apache-2.0 and Capacitor is MIT.
- **Small apps:** Electron would ship Chromium on every desktop install.

## Tradeoffs

- Tauri mobile's plugin ecosystem is thinner than Capacitor's.
- System WebViews differ (WebKit on Apple, WebView2 on Windows, WebKitGTK on Linux), so the test matrix is wider than with Electron.
- Tauri plugins have 3.0 alphas out, so expect churn.
