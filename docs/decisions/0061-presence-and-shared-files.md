# ADR-0061 · Who's here, and files that go with a share

- **Status:** Accepted
- **Date:** 2026-10-17
- **Builds on:** [ADR-0056](0056-shared-notes.md) (shared notes), [ADR-0060](0060-team-conversations.md) (shared conversations)

Shared notes and conversations left three gaps, which ADR-0056 and ADR-0060 named as consequences:

- nobody could tell who else was there;
- a shared note's images stayed with its owner;
- teammates saw that a conversation had attachments, but couldn't open them.

This closes all three.

## Decisions

### Who's here

- A shared note, and a shared conversation (its view in Team, and the team panel in your own conversation), show who else has it open: their faces and a line like "Ana is here" or "Ana, Sam, and 2 others are here".
- It's live: a person shows while the note or conversation is open in their app, and drops off when they close it or leave.
- **How:** each app sets its name in the shared document's Yjs awareness (Hocuspocus carries it) while the document is open, and clears it on close. The name is the one already used for comments, your first account's. Two windows of the same person count once.
- **No cursors or read state.** "Who's here" answers "is anyone else in this right now?" without turning the editor into a crowd. Cursors can come later if people want them.

### Files go beside the share, in their own document

- Each share gets a second document on the relay, `mailbird/shared/<id>/files`. The same link opens it, and nothing else's: the relay checks the link's token against the share's id, as for the share itself. Stopping a share drops its files connections too.
- **Why a separate document:** saving the text of a note or comment saves its whole document. Keeping the bytes apart means a keystroke never re-saves several megabytes of images.
- **Shared notes:** the owner's app puts the note's images there, and keeps them current as images are added or removed. Each guest's app saves them as the guest's own note images. So they show, read their text for search ([ADR-0045](0045-scans-and-text-in-images.md)), and stay when the owner stops sharing.
- **Shared conversations:** the team panel gets **Files**, listing the conversation's attachments.
  - **The owner chooses:** each file reads "only you have it" until you press **Share**. Then it reads "the team can download it", and **Stop sharing** takes it back.
  - **Teammates** see only the shared files, each with **Download**.
  - Nothing goes without you choosing it, since attachments are often the most private part of a conversation.
- **Up to 10 MB a file,** the size a note image may be. Bigger files say so and stay with you.
- **Held in memory, not stored:** a guest's note images become their own; a teammate's files are downloaded when asked for. A stopped conversation's copy keeps its comments and reply, not its files.

## Verification

- **Relay** (`pnpm --filter notes-relay test`): a share's files open with its link and not another share's, and stopping the share drops its files connections.
- **Browser** (`phase47`, 17 checks): two people, with a real relay.
  - **Shared note:** the owner's note with an image is shared, and the guest gets the note and its image, which they couldn't reach before.
  - **Who's here, note:** each sees the other is here, and when the guest closes the note, the owner sees nobody.
  - **Shared conversation:**
    - the owner's panel lists its two attachments as "only you have it";
    - the teammate sees no files until one is shared, then exactly that one;
    - they download it intact (a real PNG, its name kept);
    - Stop sharing takes it back.
  - **Who's here, conversation:** each sees the other.
  - **Console:** no errors.
- **Regression:** the shared-note (`phase44`) and shared-conversation (`phase46`) suites pass. `tsc -b`, `oxlint`, and `vite build` are clean.
- **Ratchet:** flat at 229 `className` overrides, with raw elements at 19.

## Consequences

- **Names are what people call themselves,** as for comments. Presence shows who says they're here, not who they are.
- **The relay can read the files,** as it reads notes and conversations. End-to-end encryption, the next step, covers the files document with the rest.
- **A guest can't add images to a shared note.** Their images stay on their side, and the owner's are the ones that travel. That matches who owns the note's files today.
