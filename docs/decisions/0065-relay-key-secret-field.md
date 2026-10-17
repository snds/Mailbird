# ADR-0065 · The relay's key in a SecretField

- **Status:** Accepted
- **Date:** 2026-10-17
- **Builds on:** [ADR-0062](0062-end-to-end-encrypted-sync.md) (end-to-end encrypted sync), [ADR-0064](0064-unicron-0-7.md) (unicron 0.7)

ADR-0062 showed the sync key in a password-style field with Show and Copy. The key sat in the page as text the whole time the dialog was open. Copying it left it on the clipboard indefinitely. unicron 0.4 added `SecretField` for exactly this job.

## Decisions

- **A device that has the key shows it in a `SecretField` (read mode).**
  - The key is fetched only when asked for, and the field never keeps it as page text.
  - Hold the eye button to see it. It hides on release, on leaving the window, and when the dialog closes.
  - **Copy** puts it on the clipboard and clears the clipboard after **90 seconds**, the field's longest timer. That's time to paste it on another device.
  - The page can't read the clipboard back without asking, so the clear runs even if something else was copied since. The field's tooltip says so.
- **A device without the key types or pastes it into the same component in edit mode.**
  - A relay that says it's encrypted marks the field with the reason.
  - A key of the wrong shape is refused, as before.
- **"Use a different key"** switches a device that has a key back to edit mode, for a key pasted wrong.
  - Saving with the field left empty keeps the key the device has. Emptying the field never turns encryption off.
- **The locked-notes passphrase stays a typed field.** You type it, and nothing is stored to reveal. `SecretField`'s read mode doesn't fit it.

## Verification

- `phase48` (now 27 checks):
  - the laptop's key is masked, and its text isn't anywhere in the dialog;
  - Copy puts it on the clipboard;
  - choosing a different key and saving with the field empty keeps encryption on.
  - The phone still pastes the key and syncs.
- The full browser regression passes. `tsc -b`, `oxlint`, and `vite build` are clean, and the ratchet is flat.

## Consequences

- **On the desktop and phone,** the copy still goes through the web clipboard. A copy by reference through the core (`copyRef`), which keeps the bytes out of the web layer, is for when the core gains clipboard access.
