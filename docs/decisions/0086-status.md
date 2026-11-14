# ADR-0086 · Status and messages, built once: live status, toasts, section banners, load state, copying

- **Status:** Accepted for the build. **DC6 is a proposal for Sean:** live states leave toasts for the status strip and the status line, which replaces part of [ADR-0007](0007-mail-engine.md) and [ADR-0017](0017-mail-power.md) (below, "DC6").
- **Date:** 2026-11-14
- **Builds on:** [ADR-0083](0083-shell.md) (the shell: the status line, the phone's rows, the place strip), [ADR-0084](0084-places.md) (places), [ADR-0081](0081-harness-and-scenarios.md) (demo scenarios), [ADR-0082](0082-unicron-1-0.md) (unicron 1.0: `Accessory`, `StatusItem`, `Toaster`, `Banner`, `EmptyState`).
- **Design:** States / 04 (loading), Desktop / 05 and Mobile / 07 (sync error); brief X4 and section 4.0 of the undrawn-areas design, X5 for the Missed list; cross-app decisions §1, §9 and §12.

Vale said what it was doing in four ways: toasts for "Sending… Undo", a spinning icon for a sync, error lines inside Settings and at the top of two views, and nothing at all when the browser was offline. This builds the channels of cross-app decisions §1 once, so every lane says the same kind of thing in the same place.

## Decisions

### The channels

| Kind | Where it shows | Built in |
|---|---|---|
| Live (running now) | the phone's status strip; the desktop's status line | `app/live-status.ts`, `app/status.tsx` |
| Finished | a toast | unicron's `Toaster`, placed by the frame (`app/shell.tsx`) |
| Broken, and the person can fix it | one critical banner at the top of the section it affects | `app/section-banner.ts`, `app/section-notice.tsx` |
| A read that failed | the last good list under a banner, or the critical empty state | `components/load-state.tsx` |
| Waits on you | a `NeedsYou` in its conversation (the mail lane's) | — |

Due reminders stay toasts: the one stated exception (brief X5).

### Live status

One model, `useLiveStatus()`, picks the one live state to show, and both the strip and the line read it, so they never disagree. In order:

| State | Source | Phone strip | Status line |
|---|---|---|---|
| Sending, in the undo window | the outbox (`useSending`, `features/mail/sending.ts`) | live · `SENDING // 08 S` · the subject · UNDO · a bar of 10 | live · `SENDING // 08 S` · the bar · UNDO |
| Updating the server | Settings' gateway update, while it waits (`setServerUpdating`) | live · `UPDATING SERVER` | the same |
| Offline | `navigator.onLine` (`hooks/use-online.ts`) | neutral · `OFFLINE` · "Last synced 09:16" | neutral · `OFFLINE // LAST SYNCED 09:16` |
| An account stopped syncing | an account's `lastError` | none: it is Mail's banner | critical · `WORK // NOT SYNCING SINCE 09:16` |
| First sync of an account | `lastSync` is null | live · `FIRST SYNC // WORK` · "Fetching mail" | live · `FIRST SYNC // WORK` |
| Checking for mail, asked for | `checkMail()` in flight | live · `SYNCING // PERSONAL + WORK` · "Checking 2 accounts" | live · `CHECKING // 2 ACCOUNTS` |

- **The status line holds two items at most:** the live one first, then the screen's own fact. In Mail the fact is the sync time, so "not syncing" and "offline", which already say it, take its place (Desktop / 05).
- **A status line is never yellow.** A stopped account is critical, with the warning glyph and its words, so the color never carries it alone.
- **Background checks are silent.** Only a check the person asked for is live: pull to refresh, a second tap on Mail's tab, "Check again". All three call `checkMail()`, which also reads the lists again and ends without a toast. Mail's refresh in the demo goes through it too; the demo's check answers at once.
- **In Mail the idle fact is a button,** "Check again", with the tooltip "Check for new mail".
- **Two sends in one window** show the newest: `SENDING // 2 MESSAGES // 08 S`. UNDO takes back the newest.
- **⌘Z or Ctrl+Z,** while a window is open and focus is not in a field, a select or an editor, takes back the newest send (`OutboxWatcher`).
- **The strip's text area is a button** (unicron's `onOpen`): while sending it opens Scheduled, where the message waits (the Outbox, once the mail lane builds it); while mail is fetched it opens the Folders sheet. UNDO is its own button beside it, never inside it.
- **The sending strip shows on every phone screen.** The frame floats it alone, 16 from each side, where there is no bottom row (Settings). A full-screen form is a layer over the frame, so the form draws the strip at its foot (`FormStrip`, in `EditorFrame` and the composer's sheet). Scrolled into the bottom row it shows the seconds and UNDO only.
- **The seconds are said once.** The strip and the item pass a fixed sentence ("Sending Saturday ferry. 10 seconds to undo.") to the frame's one polite region; the ticking number is hidden from assistive tech.
- **The demo never says "Offline",** since it needs no network, except under the `offline` scenario.
- With nothing live, the phone's place strip shows once the page has scrolled, as before (ADR-0083).

### After a send

`OutboxWatcher` moved out of `composer.tsx` into `features/mail/outbox-watcher.tsx`. When a send leaves its window the toast says "Sent {subject}". A failed send says "Not sent: {subject}" with EDIT and stays until used; its banner and Outbox row are the mail lane's.

### Toasts

unicron's `Toaster` stands inside the frame, which places it: the bottom left of the content on a desktop; on a phone the status strip's slot, one at a time, so the foot never holds three bars. A strip with an action (a send's UNDO) is never covered: the toast waits for it. A strip without one gives way for the toast's time. Times are unicron's defaults: 6 s with an action, 4 s without; three at most; one action. No local wrapper was added: the part already does all of this (see "Not built").

### Section banners

`useSectionBanner(section, banner)` puts one critical banner at the top of a section's content: the first that applies, or null. From medium width up it stands under the status line, across the content (Desktop / 05); on a phone, under the page head (Mobile / 07; `MasterDetail` places it, and a view with its own columns places `<SectionNotice in="column" />`). Settings and Search show none. Mail fills its sync error here now ("{Account} account stopped syncing", the server's words, OPEN ACCOUNTS); the lanes fill the rest: a failed send, Calendar's and Contacts' `davError`, Notes' relay.

### Load state

`<LoadState place error hasData onRetry>` around a list: a failed read with a last good list keeps it under a critical banner "Couldn't load {place}" with TRY AGAIN; with nothing to show, the critical empty state "Can't load {place}." with the server's words and TRY AGAIN. Loading and the ordinary empty state stay the list's own.

### Copying

`lib/copy.ts`: a COPY control uses `useCopy`, shows "Copied" in its own place for 2 s and raises no toast; a copy from a menu or a key uses `copyText` and raises "Copied {what}". When the browser blocks the clipboard, either shows the label and the value in a toast, selectable, for 6 s. The note's "Copy as Markdown" uses it; the other copy controls move to it as their lanes rebuild them.

### Missed reminders

`features/calendar/missed-reminders.ts` keeps what came due while Vale was closed for the session (the core hands each over once), whether the notice was raised, and `openMissed()`. `MissedList` is a plain list in a question-size dialog (a sheet on a phone), mounted at the root; a row opens its event or note. Two or more missed reminders are now one notice with SEE (brief X5), not a pile of toasts; one keeps its own toast.

### Demo scenarios

`core/demo-scenarios/status.ts`: `sync-error`, `first-sync`, `syncing`, `send-fails`, `slow`, `dav-error`, `relay-error`, `empty-inbox`, `no-account`, `offline`, `missed`. The data is the demo's own.

## DC6 (proposal)

ADR-0007 made "Sending… Undo" a toast, and ADR-0017 kept it. Cross-app decisions §1 put live states in the strip and the status line and keep toasts for finished things. So the undo window is now live status, and the toast that follows says "Sent {subject}". The window, its length and what Undo does are unchanged. **Question for Sean:** is the strip and line the right home for the undo window, or should Send keep a toast?

## Not built, and why

- **`app/toaster.tsx`.** A local component around unicron's `Toaster` would add nothing and would count as a look-alike. The frame configures the part.
- **Toast words.** Some toasts still end in a full stop or do not name the thing ("Archived"). Each lane fixes its own.
- **The Outbox.** The strip opens Scheduled until the mail lane builds it.
- **SIGN IN on the banner** for an OAuth account: the mail lane's. The banner says OPEN ACCOUNTS for every account.

## Checks

Scenes `status-syncing`, `status-first-sync`, `status-sending`, `status-sync-error`, `status-offline`, `status-missed`, `status-copy-blocked` (`scenes/shell.mjs`) and `toast-placement` (`scenes/mail.mjs`) assert the above at desktop, phone and medium widths. Ratchet unchanged: 129 className, 1 style, 0 spread, 15 plain buttons, 0 look-alikes.

## The screenshot harness

`settle` counts only loading that is on screen (`checkVisibility()`), and a failed picture now names what was loading. A section hidden behind Search or Settings stops drawing, so a skeleton caught there stood unseen and failed `search-all` by chance (two runs in three at ADR-0085's commit). It cannot be in the picture. A loading state on screen still fails the picture, as before.
