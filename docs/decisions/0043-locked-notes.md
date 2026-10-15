# ADR-0043 · Locked notes (Phase 33)

- **Status:** Accepted
- **Date:** 2026-10-15
- **Builds on:** [ADR-0012](0012-notes.md) (notes and their Yjs sync through a relay)

The [competitive analysis](../research/competitive-analysis.md) §3 credits **locked and encrypted notes** to Apple Notes and Bear: "selective privacy without a separate vault". Until now, every note was readable by anyone with the device and, while it synced, by the relay.

## Decisions

### One passphrase, never stored

- **One passphrase opens every locked note**, on every device, as in Apple Notes.
- **It's never kept anywhere.** A 256-bit key is derived from it with PBKDF2-HMAC-SHA256 (600,000 iterations, OWASP's 2023 figure) and a random salt. A sealed check value tells a right passphrase from a wrong one.
- **Setting it warns plainly** that a forgotten passphrase can't be reset, by anyone. It asks twice and takes an optional hint, which can't contain the passphrase.
- **It needs at least 6 characters.** The form suggests a short sentence.
- **Changing it requires being unlocked.** Every locked note is resealed with the new key in one transaction.

### What locking does

- **The text is sealed with AES-256-GCM,** with a fresh random nonce each time. The note's id is bound in as associated data, so sealed text moved to another note won't open.
- **The title stays readable,** as Apple Notes does. That keeps the note findable in the list and by its title in search, and lets `[[links]]` to it still resolve. The trade-off: put anything private below the first line.
- **Everything else readable is emptied:** the Markdown body, the snippet, and the Yjs state. Search, export, smart folders' words and to-dos, the calendar's tasks, and backlinks therefore never see the text. The plain save path refuses a locked note, so nothing can write it back in the clear by mistake.
- **Remove lock** turns it back into an ordinary note.

### While unlocked

- **The key lives only in the app's memory.** It's forgotten after **10 minutes without use**, or at once with **Lock now** (the open-lock button on an unlocked note). The core never stores it.
- **A locked note edits in the normal editor, without live sync.** Each save seals the text again, and the title follows the first line.
- **Locking another note while unlocked is one step.** While locked, the passphrase is asked first.

### Sync

- **The sealed text and the title travel in the note's record.** Its Yjs document isn't synced while it's locked. Newest wins for locked notes, so two devices editing one locked note at once keep the later save. Live merging needs the text in the clear.
- **Locking empties the note's document on the relay.** Yjs drops deleted text from a document's state, so the relay's stored file holds no readable copy afterwards. This is verified by reading the relay's own file.
- **The passphrase's salt and check value sync in the relay's index,** so the same words open the note on every device. The newest setting wins, and a device whose key no longer matches locks again.

### What it doesn't protect

- **The title, tags, links, color, and dates** stay readable, as they do in Apple Notes. Encrypting them would break search and the views built on them.
- **Copies made before locking:** an export, a clipboard, or a relay backup taken earlier.
- **A device that's unlocked and in someone else's hands,** for up to 10 minutes.

## Verification

- **Core:**
  - Sealed text opens only with the right key and for the right note, with a fresh nonce each time.
  - Lock, hide, edit, change the passphrase, and remove the lock.
  - Locked text isn't searchable or exported, and isn't in the database in the clear. The plain save refuses it.
  - A record carries only sealed text. Another device opens it once the setting arrives, and the setting applies once.
- **Dispatcher:** set a passphrase, lock, lock now (then opening is refused), a wrong passphrase, unlock, open.
- **Browser, demo (`phase33`, 17 checks, on a fake clock):**
  - the warning, the match check, and the hint;
  - the row shows the title and "Locked";
  - editing while unlocked, then **Lock now** clears the screen;
  - search finds the note by title only;
  - a wrong passphrase says so; the hint shows on request; the edit was kept;
  - locking a second note takes one step;
  - auto-lock after ten idle minutes;
  - locking while locked asks first;
  - removing the lock brings back the preview;
  - the phone layout;
  - no console errors.
- **Browser, two devices through a real relay (`phase33-sync`, 6 checks):**
  - the relay's file holds the text before locking and none after;
  - the other device shows the title only, then opens the note with the same passphrase.

  The existing two-device sync suite and all earlier demo suites still pass.

## Consequences

- **`ring` is now a core dependency in every build,** not only with networking. It was already compiled for TLS, so this adds nothing to the build.
- **The demo's "sealing" is only an encoding.** Its sample data has nothing to protect; the core does the real encryption.
