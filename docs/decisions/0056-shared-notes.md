# ADR-0056 · Shared notes (Phase 44)

- **Status:** Accepted
- **Date:** 2026-10-17
- **Builds on:** [ADR-0012](0012-notes.md) (notes, Yjs, and the relay), [ADR-0043](0043-locked-notes.md) (locked notes), [ADR-0044](0044-images-in-notes.md) (images in notes)

Notes synced between your own devices, but a note couldn't be shared with someone else. Planning a trip or an agenda with another person meant copying text back and forth. This phase lets you share one note by link. The other person sees it in their own Mailbird, and both of you type into it at once.

## Decisions

### A link per note, through your own relay

- **Share…** in a note's menu makes a link. You choose what the link allows:
  - **Can edit:** anyone with the link can change the note. Their edits and yours merge as you type.
  - **Can view:** they can read it and see your changes as you make them, but can't change it.
- The dialog offers **Copy link** and **Email it**. Email opens a new message with the link in it.
- **Stop sharing** ends the link for good. Sharing again makes a new link; the old one never comes back.
- Sharing needs a notes relay (the one that already syncs your devices). Without one, the dialog says so and offers to set one up.
- **Why a link and not invitations by address:** a link works with anyone, needs no accounts or directory, and is what people know from other notes apps. The trade-off is that whoever has the link has access, so the dialog says that plainly, and stopping is one click.

### How the link works

- The link is your relay's address, as https, at `/share`, with the details after a `#`:
  `https://notes.example.com/share#…`
- The part after `#` holds the relay, the share's id, the mode, the note's title, your name, and a **share token**.
- Browsers never send the part after `#` to a server, so the token only travels where the link itself goes.
- Opened in a browser, the relay serves a short page that explains how to open the link in Mailbird.
- **The share token is derived, not stored.** It is an HMAC-SHA256 of the share's id under the relay's own token. The relay can check any link without keeping a list of tokens, and a link opens exactly one note and nothing else.

### What the relay does

- A shared note's text is its own Yjs document on the relay: `mailbird/shared/<id>`.
- Your devices keep the list of shares in the sync index (`shares`: which note, edit or view, and whether it was stopped). Only the relay's token opens the index.
- **On every connection with a share token, the relay checks that list:**
  - a share that isn't listed, or was stopped, is refused;
  - a view-only share connects read-only, so a reader's edits never reach anyone.
- **When the list changes, the relay acts at once:**
  - guests of a stopped share are disconnected;
  - guests who could edit a share that just turned view-only are disconnected too, and reconnect as readers.
- Deleting a shared note stops its link.

### What each side sees

- **The owner:**
  - The note shows **Shared** in its header and a people icon in the list and on its card.
  - Its text moves from its usual document to the shared one, and stays connected while the app runs, so the other person's edits arrive whether or not the note is open.
- **The person it's shared with (the guest):**
  - **Open a shared note…** in the Notes menu takes a pasted link. It previews the note, who shared it, and what the link allows, then adds it.
  - A link in a message shows as a card with **Open in Notes**. A link to your own note opens your note instead of making a copy.
  - The note shows **Shared by <name> · You can edit** (or **You can read**). A view-only note opens read-only, with a line saying who shared it for reading.
  - It syncs on the owner's relay with the link's token. The guest doesn't need a relay of their own, and the note's text never goes to the guest's relay.
  - Adding the same link twice opens the note it already made.
- **When the owner stops sharing,** the guest is told, and the note becomes their own copy, with everything it had. They can also choose **Keep as my own note** at any time.
- **When the owner turns a link view-only,** the guest's open note turns read-only at once. The owner writes the current mode into the shared document, so guests learn of it without a new link; the relay enforces it either way.

### Shared and locked don't mix

- A locked note's text is sealed with your passphrase ([ADR-0043](0043-locked-notes.md)), which the other person doesn't have. So a locked note can't be shared, and a shared note can't be locked.
- The menu hides **Lock note** while a note is shared, and the core refuses both, with a reason.

### In the core

- `NoteShare { id, role: owner | guest, mode: edit | view, revoked, relay?, token?, from? }`, kept on each note (schema version 19 adds a `share` column).
- It is part of the note's sync record, so your other devices route the note's text to the same place. Devices from before this phase leave it out.
- `share_note(id, mode)` makes or changes the link; `unshare_note(id)` stops it (owner) or keeps a copy (guest).
- `create_note` takes a guest share, checked: a valid id, a `wss://` (or local `ws://`) relay, and a token.

## Verification

- **Relay** (`pnpm --filter notes-relay test`):
  - a share the owner hasn't listed is refused;
  - a guest with the link edits the note live;
  - the link's token opens that note and nothing else;
  - turning a link view-only drops editing guests, and a reader's edits reach no one;
  - stopping drops guests and refuses the link, while the owner keeps working;
  - the `/share` page explains a link opened in a browser.
- **Core** (`cargo test -p pim-core`, 233 tests):
  - sharing makes a link, and changing it keeps the same link;
  - a stopped link stays stopped, and sharing again makes a new one;
  - a guest note comes from a link and becomes a copy;
  - incomplete links are refused;
  - shared and locked don't mix;
  - shares sync with the record.
- **App:** share, view-only, stop, and add a guest's note, through the dispatcher.
- **Clippy** is clean across the workspace.
- **Browser** (`phase44`, 36 checks): two people in two apps, with a real relay.
  - The owner shares a note; the dialog's defaults and the link; the note and list say it's shared; Lock is hidden.
  - The link opened in a browser explains itself.
  - The guest, with no relay of their own, pastes the link, sees a preview, and adds it with its text.
  - Edits go both ways, live. Edits made while the guest's note was closed are there when it opens. Adding the link twice makes no second copy.
  - Turning the link view-only makes the guest's open note read-only at once, with the reason shown, while the owner's edits still arrive.
  - Email it puts the link in a message. A second guest opens the link from a message's card and gets the note, read-only.
  - Stopping tells the guest, leaves them their copy, and the link can't be added again. The note can be locked again.
  - The share dialog fits a phone, and there are no console errors.
- **Regression:** all earlier browser suites pass. `tsc -b`, `oxlint`, and `vite build` are clean.
- **Ratchet:** flat at 240 `className` overrides. Icons in the new pieces are sized by their containers, through the library's own `svg` contract.

## Consequences

- **Not end to end encrypted.** The relay can read shared notes, as it can read all your notes. The dialog says so. End-to-end encryption for notes is still to come, and shared notes would need it most.
- **Images stay with you for now.** They sync on your relay with its own token, which guests don't have. The dialog says so. Sharing them means giving each image a share token too.
- **No list of who has the link.** The relay doesn't know people, only tokens. A future version could show "2 people are here" from Yjs awareness.
- **A card shows what a link said when it was sent.** If the owner later turned it view-only, the card still says "You can edit"; the note itself opens read-only.
- **The owner's relay must be reachable by the guest.** A relay on `localhost` works only on that computer. Run it behind TLS on the internet (as the relay's guide says) to share with others.
