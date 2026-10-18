# ADR-0070 · The core copies the relay key and saves note images

- **Status:** Accepted
- **Date:** 2026-10-17
- **Builds on:** [ADR-0065](0065-relay-key-secret-field.md) (the relay key in `SecretField`), [ADR-0067](0067-note-image-viewer.md) (the image viewer), [ADR-0069](0069-unicron-0-9.md) (unicron 0.9)

Two things waited for the core to reach the system:

- **Copying the relay key** went through the web clipboard on every platform. A page can't read the clipboard back, so the clear after 90 seconds ran even when you'd copied something else since, and wiped it.
- **Save image** in the viewer was web-only. The desktop and phone apps can't download from the page, so they had no way to save a note's image.

## Decisions

### The host reaches the clipboard

- **`Host` gains `clipboard_write` and `clipboard_read`.** The Tauri shell implements them with `tauri-plugin-clipboard-manager` (MIT OR Apache-2.0), from Rust only. The gateway keeps the default: an error, since its clipboard is the browser's.

### Copy by reference

- **`copy_relay_key`:** the core reads the key from the keychain and puts it on the clipboard itself. The page gets back a SHA-256 digest, never the key.
- **`clipboard_holds`:** whether the clipboard still holds that copy. It answers only about the core's own copy, so a page can't use it to test guesses against the clipboard.
- **`clear_clipboard`:** clears the core's copy, unless something else was copied since. If the clipboard can't be read, it clears anyway.
- **In the relay dialog,** the desktop and phone give `SecretField` a reference host (`copyRef`, `clipboardHolds`, `clear`). The field's tooltip says the clear leaves anything copied since. The web keeps the page clipboard, as before.
- **What this doesn't change:** sync encrypts in the web layer (ADR-0062), so the page still holds the key while sync runs. What moves is the copy and the clear.

### Saving an image

- **`save_note_file`:** the core writes the image into Downloads, with a name from its description (made safe, up to 60 characters) and an extension from its type, never over an existing file. A locked note's image needs the notes unlocked, as for viewing it.
- **The viewer's Save image shows everywhere now.** On the desktop and phone it calls the core and says "Saved to Downloads", with the path. The web downloads from the page, as before.

## Verification

- **App:** a unit test copies, checks, and clears; a guessed digest isn't answered; something copied since stays. The dispatcher test copies the relay key through `copy_relay_key` and checks the UI's answer has no key in it, then clears it. It saves a locked note's image with a name that tries `../`, and finds it in Downloads with its bytes.
- **Gateway:** its tests pass; the new commands aren't on a member's list, so they stay the owner's, and they fail there without a clipboard or Downloads.
- **Browser:** the full regression passes, including the viewer's web Save image (`phase50`).
- `cargo clippy -D warnings` (shell, app, gateway), `tsc -b`, `oxlint`, and `vite build` are clean. The dsa ratchet is flat.

## Consequences

- **Not tried on a device yet.** The clipboard plugin's behavior on iOS and Android, and where Downloads is on a phone, belong to the device spike (ADR-0002).
- **On Linux, the clipboard** needs a running X11 or Wayland session, as any clipboard does.
