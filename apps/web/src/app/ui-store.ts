import { create } from "zustand"

import type { ContactInput, Draft, EventInput } from "@/core/types"

/** What the event editor is working on: a new event, or a series being edited. */
export interface EventEditorState {
  /** Set when editing; absent for a new event. */
  eventId?: string
  initial: Partial<EventInput>
}

export interface ContactEditorState {
  contactId?: string
  initial: Partial<ContactInput>
}

/** App-level UI state that crosses views (composer, editors, settings). */
interface UiState {
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

export const useUi = create<UiState>((set) => ({
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
