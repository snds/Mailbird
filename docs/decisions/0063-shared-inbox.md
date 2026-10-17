# ADR-0063 · A shared inbox on the gateway

- **Status:** Accepted
- **Date:** 2026-10-17
- **Builds on:** [ADR-0016](0016-web-gateway.md) (the gateway), [ADR-0060](0060-team-conversations.md) (shared conversations), [ADR-0061](0061-presence-and-shared-files.md) (who's here)

ADR-0016 made the gateway one person's: one password, no user accounts. ADR-0060 lets you share one conversation at a time by link. A team that answers one mailbox together (support, sales, a family's shared address) needs more: several people signed in to the same inbox, knowing who's handling what, and talking about a message without the customer seeing.

## Decisions

### Team members on the gateway

- **The owner adds people.** Settings → **Team members**: their name and email. The owner gets a link to send them; Mailbird sends nothing itself.
- **An invitation works once, for 7 days.** Its code is after `#` in the link, so it never reaches a server log. Opening it asks for a password (12+ characters) and signs them in. **New link** makes another, for someone who lost theirs or forgot their password; their old password stops working once they choose a new one.
- **Signing in:** a team member enters their email and password. The owner leaves the email empty and uses `GATEWAY_PASSWORD`, as before. Wrong guesses share the same limit (10 in 5 minutes).
- **Kept in `members.json`** in the data folder, mode 0600, beside the mail database. Passwords are PBKDF2-SHA256 hashes (600,000 rounds, OWASP's 2023 figure) with their own salts. Invitations are kept only as hashes of their codes. An unknown email costs as much time as a wrong password, so timing doesn't tell which.
- **Taking someone off** ends their sessions at once. What was assigned to them goes back to nobody.

### What a member can do

- **Mail, and the team's side of it.** They read, reply, archive, snooze, and star, from the gateway's accounts. They assign conversations and leave notes.
- **Not the owner's things:** accounts, settings, calendars, contacts, notes, AI keys, or links shared by relay. The gateway enforces this with a list of the commands a member may call; anything else is 403. Their event stream carries mail's events only, so they don't see, say, a reminder's title.
- **Their app shows Mail only,** and their settings say who they're signed in as, with **Sign out**.
- **Why a list of what's allowed, not of what isn't:** a command added later stays the owner's until someone decides a member needs it.

### Assigning, notes, and who's here

- **Assigned to:** each conversation can be assigned to one person, the owner or a member. **Assign** in the conversation's Team panel picks who; "Ana took it" or "Lee assigned it to Ana" says how. **Assigned to me** in Mail lists yours.
- **Notes:** the team leaves each other notes on a conversation. They never go to anyone on it. Each person can delete their own; the owner can delete any.
- **Who's here:** while a conversation is open, the page tells the gateway, and everyone sees "Ana is here", as for shared notes (ADR-0061). The page says so again every 30 seconds, and the gateway forgets someone after 70 seconds without hearing.
- **Who did something comes from the session,** never the page. The gateway writes the actor into every assignment and note. An assignee's name comes from the team list, so a page can't assign to someone who isn't on it or rename them.
- **Kept in the core** (schema v22: `thread_assignees`, `thread_comments`), so they're in the mail database with the conversations, and in its backups.
- **The panel shows up** only on a gateway with more than one person on the team. The comment list is the same component as a shared conversation's (ADR-0060).

### Not in this step

- **Writing a reply together.** Each person replies from the composer, as before. A shared conversation's live reply (ADR-0060) stays the way to draft together.
- **"Sent by" on replies.** The sent message is the account's; the team's notes and the assignment say who handled it.
- **Members with their own accounts.** A member works the owner's mailboxes. Someone who wants their own mail runs their own Mailbird.

## Verification

- **Core** (244 tests): one assignee at a time, handed on, cleared, and dropped when the member leaves. **Assigned to me** lists exactly theirs. Notes are kept in order. Empty and over-long notes are refused, and only their author (or the owner) can delete one.
- **Gateway:**
  - Unit tests for members: one person per address; a password set from the invitation, and the code spent; reloaded from disk with no password or code in the file; a new invitation replaces the old password.
  - HTTP test (`tests/team.rs`):
    - an invitation signs her in, once;
    - a member can't invite anyone;
    - she reaches `list_messages` but gets 403 on accounts, notes, AI keys, and calendars;
    - an assignment and a note say who she really is, whatever the page sent, and assigning to someone off the team is refused;
    - the owner hears the change on the event stream, and she can't delete the owner's note;
    - who's here reaches everyone;
    - removing her ends both her sessions and clears her assignment.
- **Browser** (`gateway-p49`, 24 checks): the owner and Ana on a real gateway with Dovecot.
  - **Joining:** the owner gets the link, and Ana is listed as not joined yet. Ana joins, sees Mail and nothing else, and the code leaves the address bar.
  - **One inbox, two people:** the customer's mail is in both inboxes, and each sees the other is here.
  - **Assigning:** Ana takes it. The owner sees it's hers, live. It's in her **Assigned to me** and not in the owner's.
  - **Notes:** her note reaches the owner live, and the owner's answer reaches her under the owner's account name. She can't delete the owner's.
  - **Ana's settings:** they say who she is, and offer no accounts and no notes.
  - **Removing her:** her conversation goes back to nobody, the team panel goes away, and she's signed out.
  - **Console:** no errors.
- **Regression:** the full browser suite passes. `tsc -b`, `oxlint`, `vite build`, and `cargo clippy -D warnings` are clean. The dsa ratchet is flat.

## Consequences

- **A member can read everything in the gateway's mailboxes.** That's what a shared inbox is; the owner decides who's on the team.
- **Members use the owner's AI settings** (summaries and suggested replies), and so the owner's key, if one is set.
- **Sessions still live in memory:** restarting the gateway signs everyone out, owner and team.
- **The gateway is still self-hosted for a team you know,** not a hosted multi-tenant service. ADR-0016's reasoning about Google's assessment holds.
