# ADR-0087 · Forms and questions, built once: the form layer, the leave guard, the confirm question

- **Status:** Accepted for the build. **DC4 and DC10 are proposals for Sean** (below): editors leave the adaptive sheet for dialogs on a desktop, which replaces part of [ADR-0037](0037-quick-note.md) and the baton's sheet rule; and forms ask before they drop writing.
- **Date:** 2026-11-14
- **Builds on:** [ADR-0083](0083-shell.md) (the shell and its width classes), [ADR-0084](0084-places.md) (places), [ADR-0086](0086-status.md) (the sending strip inside a full-screen form), [ADR-0082](0082-unicron-1-0.md) (unicron 1.0: `Dialog` sizes by name, `Sheet`, `TopBar`, `FloatButton`, `ConfirmDialog`, `Banner`).
- **Design:** sections 3.2 and X6 of the undrawn-areas design; cross-app decisions §10 and §14; Desktop / 02 and 08, Mobile / 03 and 10 for the drawn forms.

Vale opened its forms four ways: the composer drew its own dialog and sheet, two editors shared a frame, three small forms were plain dialogs, and each wrote its own header and buttons. None asked before dropping what was typed, and the two questions the app does ask used `window.confirm`. This builds one layer for forms and one question, so every lane opens a form and asks a question the same way.

## Decisions

### The form layer (`components/editor-frame.tsx`)

`FormLayer` is the layer; the form inside it draws itself with `FormLayerForm`, which knows the form's state (its name as typed, whether its save runs).

| Width | Form |
|---|---|
| Desktop and medium | A dialog sized by name: `form` (640), or `compose` (720) for a message. Header: an overline (what the form is), the item's name as typed as the title, the close button. Footer: Cancel, then the one primary. What else the form can do (Delete, the composer's tools) stands at the start of the footer |
| The phone's shells (compact, or a short screen) | The whole screen. Top row (`TopBar`): close, the title, the one primary as a float button (`checkmark`; `send--alt` for mail). The form's other actions are a row at its foot. The sending strip stays at the very foot (ADR-0086) |

- **Keys.** ⌘ or Ctrl + Enter runs the primary from any field. Esc closes. A press outside never closes a form.
- **The title** is the item's name as typed, and the overline's words while it has none ("New event"). The layer is named for assistive tech by both: "New message, Saturday ferry".
- **A failed save** keeps the form open with the server's words in a compact critical banner above the actions (`error`). The three small forms raised a toast before.
- **The first field** is the one marked `data-form-focus`.
- **Above the keyboard.** On a phone the layer ends at `--keyboard-inset`, as the composer's sheet did, so every form's fields stay above the iOS keyboard.
- **Forms on it now:** the composer, the event editor, the contact editor, the split editor, the smart group form and the smart folder form. Their fields are as they were; each lane rebuilds its own. The layer pads the sides, so the forms' rows lost their own side padding.

### The leave guard (`lib/leave-guard.ts`)

A form says what it holds with `useLeaveGuard(dirty)`. Who asks depends on where the form stands.

- **In the form layer:** Esc, the close button and Cancel ask "Discard changes?" when the form holds writing. DISCARD closes it; KEEP EDITING is the no and takes focus. Esc in the question keeps editing. A save closes without asking.
- **In the pane** (a contact edited in the detail column, a task's Plan; none is built yet): every move away asks. The places store is wrapped with `guardPlaces`, so a place change, a jump, a toast's OPEN, a section switch, Search, Settings and the browser's Back all wait for the answer. A move the store does not see (another row, a key that moves rows) goes through `leaveThen(run)` by the view that makes it. `LeaveQuestion`, mounted once at the root, asks.
- **What counts as writing.** A message: any recipient, subject, text or file, so a reply and a message reopened by Undo send always ask; the signature alone does not. Every other form: a value that differs from when it opened.

### The confirm question (`lib/confirm.tsx`)

`useConfirm()` over unicron's `ConfirmDialog`: a question of 480 on a desktop, a sheet on a phone; the yes repeats the verb; focus starts on the no. `ask(question)` resolves to the answer; `run` keeps the question open while the yes works and shows the server's words if it fails. `question(children)` draws it, with the caller's own `RadioRow`s or consequence lines as its body.

The rule (cross-app decisions §10): what the code can undo is done at once with UNDO in a toast; a question is only for what cannot be undone. Each lane builds its own questions with it: remove an account, remove a team member, delete an event, merge duplicates, block a sender, remove a note's lock, stop sharing, cancel a booking.

## DC4 (proposal)

ADR-0037 and the baton's sheet rule put Quick Note and the editors in the adaptive sheet: a side panel on a desktop. Section 3.2 of the design gives every form one home: a dialog on a desktop, the whole screen on a phone. The editors on the form layer follow it now; Quick Note moves when the notes lane rebuilds it. **Question for Sean:** are dialogs right for forms on a desktop, or should an editor stay a side panel so the list behind it stays in view?

## DC10 (proposal)

Closing a form dropped what was typed, and deleting an event ran at once; neither can be undone. Forms now ask first (this ADR). Deleting an event asks through `useConfirm` when the calendar lane builds it. **Question for Sean:** a message asks whenever it holds anything, so a reply closed untouched asks too. Right, or should a reply ask only once something is typed?

## Not built, and why

- **The per-feature questions** (the list above), and `window.confirm` in `accounts.tsx` and `team-members.tsx`: each lane's, with `useConfirm`.
- **UNDO on a deleted split, smart group or smart folder** (brief X6): each lane's. Delete still toasts without it.
- **A message reopened from the Outbox** going back to its time when closed unchanged: the mail lane's, with the Outbox.
- **Menus as sheets on a phone, pickers, the side panel** (the other kinds in 3.2): adopted by each lane on its own screens.
- **A form in the pane.** The guard is built and was driven by a trial; the first real one is the contact editor, when the contacts lane moves it into the detail column.

## Known limits

- The browser's Back with a form in the pane: the history has already stepped when the question opens. DISCARD lands on the place; KEEP EDITING leaves the history one step behind the screen until the next move.
- A create flow that changes section and then opens a form (quick create from another section) makes the first move wait for the answer while the form opens over the question's page.
- Calendar's range lives outside the places store (`view-prefs.ts`), so a change of range is not guarded.

## Checks

Scenes `discard-question`, `form-layer-compose`, `form-layer-split` (`scenes/mail.mjs`), `form-layer-event` (`calendar.mjs`), `form-layer-contact` (`contacts.mjs`) and `form-layer-smart-folder` (`notes.mjs`) assert the layer's parts and size, Esc on an untouched form, the question once it holds writing, KEEP EDITING, DISCARD, a message reopened by Undo, and Ctrl+Enter, at desktop, phone and medium widths. `closeForm` in `scenes/helpers.mjs` closes a written form for the other scenes.

Ratchet: className overrides 129 → 122 (the composer's and the old frame's dialog and sheet classes went); 1 style, 0 spread, 15 plain buttons, 0 look-alikes.
