import { create } from "zustand"

import type { Category, ContactInput, Draft, EditScope, EventInput, MessageSummary, SplitInput } from "@/core/types"

import type { MailTab } from "@/features/mail/lanes"

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
  composer: ComposerDraft | null
  openComposer: (draft?: ComposerDraft) => void
  closeComposer: () => void
  eventEditor: EventEditorState | null
  openEventEditor: (state?: EventEditorState) => void
  closeEventEditor: () => void
  contactEditor: ContactEditorState | null
  openContactEditor: (state?: ContactEditorState) => void
  closeContactEditor: () => void
  accountsOpen: boolean
  setAccountsOpen: (open: boolean) => void
  /** Signatures and templates. */
  writingOpen: boolean
  setWritingOpen: (open: boolean) => void
  /** The ⌘K command menu. */
  paletteOpen: boolean
  setPaletteOpen: (open: boolean) => void
  /** The mail tab: a lane, or "scheduled". Back to the inbox when you leave Mail. */
  mailTab: MailTab
  setMailTab: (tab: MailTab) => void
  /** Open Mail on a tab (from the command menu), optionally searching. */
  showMailTab: (tab: MailTab, search?: string) => void
  /** The mail search box. Cleared when you leave Mail. */
  mailSearch: string
  setMailSearch: (search: string) => void
  /** People, Updates, or Newsletters in the inbox; null for all. */
  mailCategory: Category | null
  setMailCategory: (category: Category | null) => void
  /** A split tab in the inbox; null for none. Exclusive with the category. */
  mailSplit: string | null
  setMailSplit: (split: string | null) => void
  /** The split editor: a new split (no id) or one being changed. */
  splitEditor: { id?: string; initial: Partial<SplitInput> } | null
  openSplitEditor: (state: { id?: string; initial: Partial<SplitInput> } | null) => void
}

/** A draft for the composer; `sendAt` reopens a scheduled message with its time. */
export type ComposerDraft = Partial<Draft> & { sendAt?: number | null }

export const useUi = create<UiState>((set, get) => ({
  vertical: "mail",
  setVertical: (vertical) => set({ vertical, jump: null, openNote: null, mailTab: "inbox", mailSearch: "", mailCategory: null, mailSplit: null }),
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
  writingOpen: false,
  setWritingOpen: (writingOpen) => set({ writingOpen }),
  paletteOpen: false,
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  mailTab: "inbox",
  setMailTab: (mailTab) => set({ mailTab }),
  showMailTab: (mailTab, mailSearch = "") => set({ vertical: "mail", mailTab, mailSearch, mailCategory: null, mailSplit: null, jump: null, openNote: null }),
  mailCategory: null,
  setMailCategory: (mailCategory) => set({ mailCategory, mailSplit: null }),
  mailSplit: null,
  splitEditor: null,
  openSplitEditor: (splitEditor) => set({ splitEditor }),
  setMailSplit: (mailSplit) => set({ mailSplit, mailCategory: null }),
  mailSearch: "",
  setMailSearch: (mailSearch) => set({ mailSearch }),
}))

/** The jump a view should open on mount, if it's for that view. Read-only; clear it with `takeJump`. */
export function pendingJump(kind: Jump["kind"]): Jump | null {
  const j = useUi.getState().jump
  return j?.kind === kind ? j : null
}
