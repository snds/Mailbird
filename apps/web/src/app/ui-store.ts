import { create } from "zustand"

import type { ContactInput, Draft, EditScope, EventInput, MessageSummary } from "@/core/types"

import type { VerticalId } from "./verticals"

/** What the event editor is working on: a new event, or one being edited. */
export interface EventEditorState {
  /** Set when editing; absent for a new event. */
  eventId?: string
  initial: Partial<EventInput>
  /** For a series: which occurrences change, and the one picked (its originalStart). */
  scope?: EditScope
  occurrence?: number
  /** You were invited: the guest list belongs to the organizer. */
  guestOf?: string
}

export interface ContactEditorState {
  contactId?: string
  initial: Partial<ContactInput>
}

/** Open something in another app area: a note's linked event, a contact's notes… */
export interface Jump {
  kind: "thread" | "event" | "contact" | "note"
  id: string
  /** For a note: it was just created, so an empty one is thrown away on close. */
  fresh?: boolean
  /** For an event: the occurrence to show. */
  start?: number
  /** For a conversation: its row, since it may not be in the lane that opens. */
  row?: MessageSummary
}

const VERTICAL_OF: Record<Jump["kind"], VerticalId> = { thread: "mail", event: "calendar", contact: "contacts", note: "notes" }

/** App-level UI state that crosses views (composer, editors, settings). */
interface UiState {
  vertical: VerticalId
  setVertical: (v: VerticalId) => void
  jump: Jump | null
  jumpTo: (j: Jump) => void
  /** The pending jump for this kind, cleared once read (each view reads it on mount). */
  takeJump: (kind: Jump["kind"]) => Jump | null
  /** The note open in Notes. `fresh`: just created, so it's thrown away if left empty. */
  openNote: { id: string; fresh: boolean } | null
  setOpenNote: (n: { id: string; fresh: boolean } | null) => void
  /** A draft being written, or null when the composer is closed. */
  composer: Partial<Draft> | null
  openComposer: (draft?: Partial<Draft>) => void
  closeComposer: () => void
  eventEditor: EventEditorState | null
  openEventEditor: (state?: EventEditorState) => void
  closeEventEditor: () => void
  contactEditor: ContactEditorState | null
  openContactEditor: (state?: ContactEditorState) => void
  closeContactEditor: () => void
  accountsOpen: boolean
  setAccountsOpen: (open: boolean) => void
}

export const useUi = create<UiState>((set, get) => ({
  vertical: "mail",
  setVertical: (vertical) => set({ vertical, jump: null, openNote: null }),
  jump: null,
  jumpTo: (jump) =>
    jump.kind === "note"
      ? set({ vertical: "notes", jump: null, openNote: { id: jump.id, fresh: !!jump.fresh } })
      : set({ vertical: VERTICAL_OF[jump.kind], jump, openNote: null }),
  openNote: null,
  setOpenNote: (openNote) => set({ openNote }),
  takeJump: (kind) => {
    const j = get().jump
    if (j?.kind !== kind) return null
    set({ jump: null })
    return j
  },
  composer: null,
  openComposer: (draft = {}) => set({ composer: draft }),
  closeComposer: () => set({ composer: null }),
  eventEditor: null,
  openEventEditor: (state = { initial: {} }) => set({ eventEditor: state }),
  closeEventEditor: () => set({ eventEditor: null }),
  contactEditor: null,
  openContactEditor: (state = { initial: {} }) => set({ contactEditor: state }),
  closeContactEditor: () => set({ contactEditor: null }),
  accountsOpen: false,
  setAccountsOpen: (accountsOpen) => set({ accountsOpen }),
}))

/** The jump a view should open on mount, if it's for that view. Read-only; clear it with `takeJump`. */
export function pendingJump(kind: Jump["kind"]): Jump | null {
  const j = useUi.getState().jump
  return j?.kind === kind ? j : null
}
