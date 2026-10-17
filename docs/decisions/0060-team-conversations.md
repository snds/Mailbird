# ADR-0060 · Write replies with your team (Phase 46)

- **Status:** Accepted
- **Date:** 2026-10-17
- **Builds on:** [ADR-0056](0056-shared-notes.md) (shared notes by link), [ADR-0012](0012-notes.md) (the notes relay and Yjs)

Some mail needs more than one person: a client question someone else knows the answer to, or an invitation the whole team should agree on. Today that means forwarding the thread and collecting replies elsewhere. Spark Teams and Front put the conversation in one place. This phase does that for Mailbird, on its own terms.

## Decisions

### Share one conversation by link, not a team inbox

- **Share with teammates** in a conversation's toolbar makes a link. People with it see the conversation in their own Mailbird, comment beside it, and write the reply with you, live. **You send it**, from your account.
- **Why a link, and not team members on the gateway:**
  - It builds on the shared-note links of [ADR-0056](0056-shared-notes.md): the same relay, the same kind of token, the same way of stopping.
  - It works for teammates on any Mailbird, with or without a relay or gateway of their own.
  - It needs no accounts, roles, or sign-in system.
- **The trade-off:** it's per conversation, not a shared team inbox, and anyone holding the link can join. A gateway with team members (accounts, roles, a shared inbox) stays possible later. It would reuse this phase's comments and shared reply.

### What a shared conversation holds

Its own Yjs document on your relay, `mailbird/shared/<id>`, as a shared note's is:

- **A copy of the messages:** who wrote each one, when, and its own words, with quoted earlier messages cut.
  - Never attachments or images.
  - Your app keeps the copy current: new mail in the conversation is added while it runs.
  - Teammates never see your mailbox, only this copy.
- **Comments:** the team's notes beside the conversation. They never go to anyone on the conversation.
- **The reply, written together:** a small rich-text editor everyone edits at once. **Use as reply** (yours only) opens it in the composer as your reply, quoted the way Advanced settings say ([ADR-0055](0055-power-settings.md)). From there you edit and send as usual.

### Where it lives

- **Mail → Team**, a tab beside Scheduled, lists conversations you shared ("You shared") and ones shared with you ("From Ana").
  - Opening one shows the copy of the messages and the team panel.
  - On your own conversation, the same team panel appears below its messages while it's shared, and the toolbar's people icon reads **Shared with teammates**.
- **Joining:**
  - **Open a link…** in Team takes a pasted link and says what it opens.
  - A link in a message shows as a card with **Open in Team**.
  - The same link twice opens the same conversation. A note's link pasted in Team, or a conversation's link pasted in Notes, says where it belongs. In Notes it opens in Team directly.
- **Email it** in the share dialog writes a new message to a teammate with the link. It doesn't reply on the conversation, so nobody on it sees the link.

### Stopping

- **Stop sharing** ends the link for good, as with notes: sharing again makes a new link.
- The relay drops teammates at once. Each is told, and keeps a **read-only copy**, as it was then, marked **Stopped**.
- A teammate can **Leave**, and a stopped copy can be **removed**.
- A stopped link can't be joined again, and a failed join leaves nothing behind.

### How it works

- **Core:** `team_threads.rs`, schema version 20.
  - The `team_threads` table holds each one's role (owner or teammate), your conversation (owner only), the teammate's relay and token, whether it was stopped, and the document's last state.
  - Commands: `team_threads`, `thread_share`, `share_thread`, `join_team_thread`, `stop_team_thread`, `remove_team_thread`, `team_doc`, and `save_team_doc`. Each change emits `team:changed`.
- **Link:**
  - The same link as a shared note's, with `kind: "thread"`. A note's link leaves `kind` out, so older note links read the same.
  - The token is the same HMAC of the share's id under the relay's token, so nothing secret is stored.
- **Relay:**
  - Your notes sync lists each shared conversation in the index's `shares` map (`{ thread, mode: "edit", revoked }`), next to notes' shares. The relay checks that list on every connection and drops teammates when an entry is stopped. Apart from wording, the relay is unchanged.
  - Its `/share` page now explains both kinds of link.
- **Web:** `features/team`.
  - `TeamSync` keeps every live shared conversation connected while the app runs, so comments and the reply arrive whether or not it's open. Each change is saved to the core.
  - You connect with your relay's token, and a teammate with the link's token, on your relay.
  - The document holds `meta` (the subject, who shared it), `messages`, `comments`, and `draft`, Tiptap's collaboration field for the reply.
- **Names:** comments carry the name of your first account. Names are what each person calls themselves, so you can delete only comments under your own name.

## Verification

- **Core** (`cargo test -p pim-core`, 240 tests):
  - **Owner:** sharing keeps one live link per conversation; a stopped link never comes back, and sharing again makes a new one; a live link has to be stopped before it's removed.
  - **Teammate:** joining is once per link; the document's state and title are saved; a stopped one stays as a copy and can't be joined again; incomplete links are refused.
- **App** (dispatcher): join, save, read back, stop, refuse a rejoin, remove, and the `team:changed` event.
- **Relay** (`pnpm --filter notes-relay test`): a shared conversation works like a shared note. A teammate's comment reaches the owner live, stopping drops them, and the link is refused after. The browser page explains both kinds of link.
- **Browser** (`phase46`, 49 checks): an owner and three teammates in four demo apps, with a real relay.
  - **Without a relay:** sharing says it needs one.
  - **The owner shares a conversation:**
    - the dialog says only they send, and what teammates get;
    - the link points at their relay;
    - the toolbar and the team panel appear.
  - **A teammate:**
    - **Joining:** a wrong link is explained; the link says what it opens; the conversation opens in Team with both messages, who shared it, and Live.
    - **Sending:** they can't send, and are told who does.
  - **Live, both ways:** comments (⌘↵ posts), and the reply as each person types.
  - **Use as reply** opens the team's reply above the quote in the owner's composer.
  - **Team lists:** the owner's says "You shared" and opens the same view with the comments.
  - **A second teammate:** opens the link from a message's card with one click; the same link twice is one conversation.
  - **Layout:** dark mode and a phone.
  - **Stopping:**
    - the teammate is told, keeps a copy marked Stopped, and comments and the reply turn read-only, with what was said still there;
    - the owner's panel goes, and the conversation can be shared again;
    - a late teammate can't join the stopped link, and nothing is left behind;
    - removing the copy empties Team.
  - **Console:** no errors.
- **Regression:** all earlier browser suites pass. `tsc -b`, `oxlint`, `vite build`, and Clippy are clean.
- **Ratchet:** flat at 229 `className` overrides. Loading bars and the empty state are sized by wrappers.

## Consequences

- **Not end-to-end encrypted.** The relay can read shared conversations, as it can read notes. The dialog says so. End-to-end encryption for the relay would cover notes and conversations together.
- **Anyone with the link can join,** and names are self-chosen. Fine for a small team that trusts its links; a team inbox with accounts would be the answer for more.
- **The copy follows the conversation only while your app runs.** New mail arriving while it's closed joins the copy the next time it opens.
- **Attachments stay with you.** Teammates see that a message had them only if its text says so. Sharing them would mean giving each one a share token too, as images in shared notes would need ([ADR-0056](0056-shared-notes.md)).
- **No presence or read state yet.** Yjs awareness could show who is here, and which comments are new to you.
