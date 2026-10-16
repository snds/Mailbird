# ADR-0051 · The identity holds the locked-notes key

- **Status:** Accepted
- **Date:** 2026-10-16
- **Builds on:** [ADR-0043](0043-locked-notes.md) (locked notes and their passphrase), [ADR-0049](0049-identity-crate.md) (the shared identity crate), [ADR-0050](0050-identity-handshake.md) (app labels on envelopes, retiring envelopes, KDF parameters that only rise)
- **Decided elsewhere:**
  - Spec `snds/lockdown` `docs/plan/01-identity.md` §10 step 3: re-wrap the Phase 33 note-lock key as Mailbird's App Data Key.
  - D11: the recovery kit belongs to the identity, so every app key must be wrapped under it.
  - D27: this step is Mailbird's; the handshake is the Lockdown session's.
  - D28 and D29 (asked for by this step, built in ADR-0050): every app key carries its app's label, bound into the AAD, and an envelope can be retired.

## Decision

Locked notes gain a second way in. The passphrase stays exactly as it is. In addition, the key it makes is kept in the shared identity, wrapped as Mailbird's **App Data Key** under the default persona. So anything that can open the identity can open locked notes, and that includes the recovery kit.

**Nothing about the notes changes.** They aren't moved or resealed. The identity only gains an envelope.

### When the key is wrapped

- **On every passphrase unlock, and every passphrase change.** The app opens the identity on this device, or creates one (default persona `personal`) if there's none. Then it wraps the key with the label `mailbird`, unless the envelope it remembers already holds this exact key.
- **A passphrase change makes a new key**, because the notes are resealed (ADR-0043). So the new key gets a new envelope, and the old one is retired (`retire_envelope`, which leaves a tombstone in the identity's manifest). The same happens when another device changed the passphrase: the next unlock here wraps the new key and retires this device's old wrap.
- **It never gets in the passphrase's way.** If the identity can't be reached (a damaged store, an unreadable keystore, a store rolled back behind what this device last saw), the error is logged and the unlock succeeds anyway.

### Opening with the identity

`unlock_notes_with_identity` attaches to the identity. It never creates one. Then it looks for the key in two places:

1. **The envelope this device remembers** (a local setting, `notes.identity`).
2. **Every Mailbird key under every persona** in the identity (`app_keys(persona, "mailbird")`), newest first.

The first key that opens this device's notes (checked against the lock's sealed check value) is kept, and its envelope is remembered. The second step is what lets a device restored from the recovery kit get in, because it remembers nothing. Other apps' keys are never tried: the label is bound into each envelope, so a key can't be relabelled to look like Mailbird's.

**What it reads:** the local setting also records the newest identity head this device has accepted, including its key-stretching parameters. The next attach passes that head back, so a store rolled back behind it, or one whose stretching was lowered, is refused.

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
  - A passphrase change wraps the new key and retires the old wrap, so one key stays.
  - Every app key in the identity carries Mailbird's label.
  - With the remembered envelope erased (a restored device), the search finds the current key.
  - An unreachable identity never blocks the passphrase.
  - With the identity off, the passphrase path behaves exactly as before.
- **Browser** (`phase39`, demo): both ways in work on desktop and phone, and the button fits a phone screen. The suites that click **Unlock** now match it exactly.
- **Regression:** all browser suites pass. `cargo clippy` and `cargo test` (core and app), `tsc -b`, and `oxlint` are clean.

## Consequences

- **The passphrase is still the root.** The identity holds a copy of the key it makes; changing the passphrase re-keys the notes and the identity follows on the next unlock.
- **Shared notes** (planned) can now build on the persona and its keys, instead of on a passphrase alone.
