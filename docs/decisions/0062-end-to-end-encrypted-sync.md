# ADR-0062 · End-to-end encrypted sync

- **Status:** Accepted
- **Date:** 2026-10-17
- **Builds on:** [ADR-0012](0012-notes.md) (notes sync), [ADR-0056](0056-shared-notes.md) (shared notes), [ADR-0060](0060-team-conversations.md) (shared conversations), [ADR-0061](0061-presence-and-shared-files.md) (who's here, files)

Until now the notes relay could read everything that synced through it: your notes, their images, what you shared, and who was in a shared note. ADR-0012 and every share ADR after it named that as the main limit. This makes end-to-end encryption a choice you can turn on, after which the relay keeps your notes but can't open them.

## Decisions

### What it covers

- **Everything you sync:** the index of notes, each note's text, each image, and every share's documents (a shared note, a shared conversation, and their files).
- **Who's here** travels encrypted too, so the relay can't see names.
- **Not covered:** the relay still sees that documents exist, how big they are, when they change, and which share ids are live. It needs the last to check links.

### Why it covers all your sync, not only shares

- Encrypting only shares doesn't work: your other devices learn each share's key from the note's record, which syncs through the index. If the index stayed readable, the relay could read the keys there.
- So turning it on encrypts the index and every note document under one sync key, and each share under its own key.

### Keys

- **Your sync key:** 32 random bytes, made on the device where you turn it on. It's kept in the system keychain beside the relay's token (`notes-relay-key`).
  - Each of your other devices needs it. **Sync between devices** shows it with **Copy key**; on the other device, paste it into **Encryption key**.
  - A device without it is told why: "This relay is end-to-end encrypted now. Add its encryption key under Sync between devices."
- **A share's key:** 32 random bytes, made when you share while sync is encrypted. It's kept with the share (the note's record, or the shared conversation's row, schema v21).
  - The link carries it after `#`, as `k`, beside the token. Browsers never send that part of a link, so it reaches only the people the link reaches.
  - Your other devices get it from the note's record, which syncs encrypted.
- **One key per document:** each document's key is derived (HKDF-SHA256) from the root key and the document's name. One document's updates never open as another's.

### How the relay keeps what it can't read

- Encrypted documents have their own names: `mailbird/x/index`, `x/note/<id>`, `x/file/<id>`, `x/shared/<id>`, and `x/shared/<id>/files`.
- **Each is a log of encrypted updates.** Every Yjs update is encrypted on the device (AES-256-GCM, a fresh 12-byte IV each) and sent as a Hocuspocus stateless message. The relay appends it to the document's `.log` file and passes it to whoever else is connected.
  - **On connecting,** a device asks for the whole log, decrypts and merges it, then sends only what the log lacks.
  - **Long logs fold up:** past 40 updates, a device that has read them sends one update holding them all, and the relay swaps it in.
  - **Read-only links can't add** to the log: the relay refuses their pushes, as it refuses their edits today.
- **The list of shares** moves out of the index into `mailbird/registry`, which stays readable. It holds only what checking a link needs: each share id, whether it's editable, and whether it's stopped. It doesn't say which note or conversation a share is.
- **In the app,** a `SealedProvider` does this and looks like a Hocuspocus provider to the rest of sync (`synced`, `hasUnsyncedChanges`, awareness, attach, destroy). Notes, shares, and files use it without changing.

### Turning it on

- In **Sync between devices**, **Turn on end-to-end encryption** says what changes first:
  - you'll get a key to copy to your other devices;
  - notes and conversations you've shared stop working, and sharing again makes an encrypted link;
  - the relay deletes its readable copies and can't go back.
- **Old links stop** because the relay could read what they opened. Guests keep their copy, as when you stop sharing.
- **Then the device uploads everything sealed,** and asks the relay to drop every readable document. The relay deletes them, marks its data folder `SEALED`, and from then on refuses readable documents. Your devices hold their own copies, so nothing is lost.
- **No way back on the same relay.** Going back to readable sync means a new relay (or a fresh data folder). This keeps a stale device from quietly re-uploading readable copies.

## Verification

- **Core** (242 tests): a share made while sync is encrypted carries a 43-character key, keeps it when its mode changes, and a guest keeps the link's key. A link with a broken key is refused. Shared conversations do the same.
- **Relay** (`pnpm --filter notes-relay test`):
  - an encrypted document keeps updates, passes them to others (not back to the sender), and refuses anything that isn't base64;
  - a device can fold the log into one update;
  - who's here passes through without being kept;
  - an encrypted share opens with its link, read-only when it's view-only, and stopping it drops its guests;
  - turning it on drops every readable document and refuses new ones, including after a restart.
- **Browser** (`phase48`, 25 checks): a laptop, a phone, and a guest, with a real relay.
  - **Before:** the guest opens a readable share, and the relay's data folder holds the note's text, which shows the test can see it.
  - **Turning it on:** the old link stops, and the guest keeps a copy. The data folder then holds only encrypted logs and the registry, and no text from any note.
  - **The key:** the laptop shows it, and Copy key copies it.
  - **The phone:** without the key, it's told the relay is encrypted. Half a key is refused. With the key, it syncs, has what the laptop wrote, and its edits reach the laptop live.
  - **A new share:** its link carries a key. The guest opens it and edits, and who's here works.
  - **At the end,** the data folder has no text from the note, the edits, or the guest. Console errors: none.
- **Regression:** the full browser suite passes. `tsc -b`, `oxlint`, `vite build`, and `cargo clippy -D warnings` are clean.

## Consequences

- **Lose every device's key, and the relay's copy can't be opened.** Your devices still have your notes; a new relay starts from them.
- **The relay still sees the shape of things:** how many notes, how big, when they change, and which share links are live. That's what it needs to sync and to check links.
- **People you share with need the whole link.** The key is in it. Anyone with the link can read the share, as before; the relay can't.
- **Locked notes** (ADR-0043) stay locked with their passphrase on top. Their text was already sealed in the record.
- **A relay with many devices reconnecting** sends each one the whole log of each document it opens. Folding the log keeps that small.
