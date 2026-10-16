# ADR-0050 · The identity holds the locked-notes key

- **Status:** Accepted
- **Date:** 2026-10-16
- **Builds on:** [ADR-0043](0043-locked-notes.md) (locked notes and their passphrase), [ADR-0049](0049-identity-crate.md) (the shared identity crate)
- **Decided elsewhere:**
  - Spec `snds/lockdown` `docs/plan/01-identity.md` §10 step 3: re-wrap the Phase 33 note-lock key as Mailbird's App Data Key.
  - D11: the recovery kit belongs to the identity, so every app key must be wrapped under it.
  - D27: this step is Mailbird's; the handshake is the Lockdown session's.

## Decision

Locked notes gain a second way in. The passphrase stays exactly as it is. In addition, the key it makes is kept in the shared identity, wrapped as Mailbird's **App Data Key** under the default persona. So anything that can open the identity can open locked notes, and that includes the recovery kit.

**Nothing about the notes changes.** They aren't moved or resealed. The identity only gains an envelope.

### When the key is wrapped

- **On every passphrase unlock, and every passphrase change.** The app opens the identity on this device, or creates one (default persona `personal`) if there's none. Then it wraps the key, unless the envelope it remembers already holds this exact key.
- **A passphrase change makes a new key**, because the notes are resealed (ADR-0043). So a change adds a new envelope. The old one stays: the crate has no way to remove an envelope, and an old key opens nothing once the notes are resealed.
- **It never gets in the passphrase's way.** If the identity can't be reached (a damaged store, an unreadable keystore, a store rolled back behind what this device last saw), the error is logged and the unlock succeeds anyway.

### Opening with the identity

`unlock_notes_with_identity` attaches to the identity. It never creates one. Then it looks for the key in two places:

1. **The envelope this device remembers** (a local setting, `notes.identity`).
2. **Every app key under every persona** in the identity.

The first key that opens this device's notes (checked against the lock's sealed check value) is kept, and its envelope is remembered. The second step is what lets a device restored from the recovery kit get in, because it remembers nothing. It also skips over stale keys from older passphrases, and keys belonging to other apps.

**What it reads:** the local setting also records the newest identity head this device has accepted. The next attach passes that head back, so a store rolled back behind it is refused.

### Where it runs

- **Off unless the host turns it on** (`AppState::enable_identity`).
  - **The desktop shell turns it on:** the identity lives in the shared location every ecosystem app on the computer looks in (`ecosystem_identity::default_root()`).
  - **The web gateway doesn't.** It's a server, and a person's identity doesn't belong on one.
  - **Phones get it with the device work:** the shell will pass the shared App Group or package path.
- **This device's own keys** are a `FileKeystore` in Mailbird's data folder (`identity-device.key`, readable only by the user). That's adequate for a desktop and for CI, but not for a phone. The crate's Secure Enclave, StrongBox, and TPM backends are stubs today, and replacing the file is part of the device spike.

### What people see

- A locked note, and the unlock dialog, show **Unlock with your identity** under the passphrase field, as a quiet secondary action. It appears only when this device can try the identity: it's turned on, and the key was linked here before or an identity is present.
- Errors say what to do: *"there's no identity on this device yet: unlock with the passphrase once"*.

## Changes

- **`pim-core`** (`notes_lock.rs`, kept minimal):
  - `NotesKey::expose_bytes` and `from_bytes`.
  - `Store::verify_notes_key`.
  - `NotesLockInfo.identity`.
- **`pim-app`:**
  - A new `identity` module: `IdentityConfig`, `desktop_config`, `link_notes_key`, `link_quietly`, `unlock_with_identity`, and `available`.
  - `AppState.identity` and `enable_identity`.
  - The passphrase set, change, and unlock commands link the key.
  - A new `unlock_notes_with_identity` command.
- **Tauri shell:** turns the identity on with the desktop config.
- **Web:** `unlockNotesWithIdentity` on the client, the button in `UnlockFields`, and a demo stand-in. The demo's "identity" holds whatever passphrase last unlocked.

## Verification

- **Core:** a key rebuilt from its bytes opens the notes, any other key is refused, and a changed passphrase leaves the old key opening nothing.
- **App** (`tests/dispatch.rs`, against a real identity in a temporary folder):
  - Setting the passphrase creates the identity and wraps one key, and nothing is created before then.
  - The identity opens the notes without the passphrase.
  - Unlocking with the passphrase again adds nothing.
  - A passphrase change wraps the new key.
  - With the remembered envelope erased (a restored device), the search finds the current key and passes over the old one.
  - An unreachable identity never blocks the passphrase.
  - With the identity off, the passphrase path behaves exactly as before.
- **Browser** (`phase39`, demo): both ways in work on desktop and phone, and the button fits a phone screen. The suites that click **Unlock** now match it exactly.
- **Regression:** all browser suites pass. `cargo clippy` and `cargo test` (core and app), `tsc -b`, and `oxlint` are clean.

## Consequences and follow-ups

- **Keys from old passphrases pile up** as stale envelopes, one per passphrase change. That's harmless, but the identity could prune them.
- **The search tries every app key in the identity.** An optional app label on `AppData` envelopes would let it go straight to Mailbird's. That's an API change for the crate, so it's been raised with the crate's owners rather than worked around here.
- **Shared notes** (planned) can now build on the persona and its keys, instead of on a passphrase alone.
