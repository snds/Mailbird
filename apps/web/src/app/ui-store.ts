import { isExpandedWidth, viewportWidthFor } from "@unicron/ui"
import { create } from "zustand"

import type { Category, ContactInput, Draft, EditScope, EventInput, MessageSummary, SplitInput } from "@/core/types"

import type { MailTab } from "@/features/mail/lanes"

import type { CalendarPlace, ContactsPlace, NotesPlace, SearchPlace } from "./places"
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

/** The settings page's sections (ADR-0075). */
export type SettingsSection = "accounts" | "writing" | "mail" | "appearance" | "shortcuts" | "ai" | "calendar" | "phone" | "team" | "gateway" | "about"

const VERTICAL_OF: Record<Jump["kind"], VerticalId> = { thread: "mail", event: "calendar", contact: "contacts", note: "notes" }

/** Something a note can link to, with the name to show for it. */
export interface QuickContext {
  kind: "event" | "contact" | "thread"
  id: string
  label: string
}

/** The sidebar by choice: full, or its rail (ADR-0073, kept per device). At medium width it is always the rail. */
const SIDEBAR_KEY = "vale.nav.expanded"
const sidebarCollapsed = () => {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === "0"
  } catch {
    // Storage can be off: the sidebar starts full.
    return false
  }
}

/**
 * App-level UI state that crosses views: where you are (ADR-0084: one place
 * per section, plus Search and Settings; `places.ts` names them and keeps the
 * browser's history in step), and what is open over it (composer, editors).
 */
interface UiState {
  vertical: VerticalId
  /** Opens a section at its first place. */
  setVertical: (v: VerticalId) => void
  /** The sidebar is its rail by choice. Then the page head opens the section's groups, as at medium width. */
  sidebarCollapsed: boolean
  setSidebarCollapsed: (collapsed: boolean) => void
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
  /**
   * The settings page (ADR-0075), in place of the open area: the section
   * shown, "index" for the list of sections alone (a phone), or null.
   */
  settings: SettingsSection | "index" | null
  /** Open settings, at a section; with none, the first one (or the list, where a section is a pushed screen). */
  openSettings: (section?: SettingsSection) => void
  closeSettings: () => void
  /** The keyboard shortcuts list (?), read-only; keys change in settings. */
  shortcutsOpen: boolean
  setShortcutsOpen: (open: boolean) => void
  /** The ⌘K command menu. */
  paletteOpen: boolean
  setPaletteOpen: (open: boolean) => void
  /** What's open on screen that a Quick Note would link to (ADR-0037). */
  quickContext: QuickContext | null
  setQuickContext: (c: QuickContext | null) => void
  /** The Quick Note sheet: open, and for what (defaults to quickContext). */
  quickNote: { target: QuickContext | null } | null
  openQuickNote: (target?: QuickContext | null) => void
  closeQuickNote: () => void
  /** Mail's place, part one: a lane, "scheduled", or the team's two lists. Back to the inbox when you leave Mail. */
  mailTab: MailTab
  /** Mail's place, part two: one account, or null for all of them. A filter with a radio's role, not a nav place. */
  mailAccount: string | null
  setMailAccount: (id: string | null) => void
  /** The shared conversation open in Mail's Team tab (ADR-0060). */
  teamOpen: string | null
  setTeamOpen: (id: string | null) => void
  /** Opens a shared conversation in Mail → Team. */
  showTeam: (id: string) => void
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
  /** Calendar's place: the calendar in this device's range (`view-prefs.ts`), Tasks, or Booking links. */
  calendarPlace: CalendarPlace
  setCalendarPlace: (place: CalendarPlace) => void
  /** Contacts' place: everyone, a label, a smart group, Duplicates, or Recently deleted. */
  contactsPlace: ContactsPlace
  setContactsPlace: (place: ContactsPlace) => void
  /** Notes' place: a folder, narrowed by one tag. */
  notesPlace: NotesPlace
  /** Opens a folder. The tag in force stays, except in the Archive, which has none. */
  setNotesFolder: (folder: NotesPlace["folder"]) => void
  /** Narrows the open folder by a tag; null, or the tag in force again, clears it. */
  setNotesTag: (tag: string | null) => void
  /** Search as a place (brief X2), or null. The search lane opens and fills it; until then Search is the command menu. */
  search: SearchPlace | null
  setSearch: (search: SearchPlace | null) => void
  /** The split editor: a new split (no id) or one being changed. */
  splitEditor: { id?: string; initial: Partial<SplitInput> } | null
  openSplitEditor: (state: { id?: string; initial: Partial<SplitInput> } | null) => void
}

/** A draft for the composer; `sendAt` reopens a scheduled message with its time. */
export type ComposerDraft = Partial<Draft> & {
  sendAt?: number | null
  /** A bottom-posted reply: the cursor starts below the quote (ADR-0055). */
  cursorAfterQuote?: boolean
}

/** Every section's first place: where a section opens, and where it falls back when its place is gone. */
const FIRST_PLACES = {
  mailTab: "inbox",
  mailAccount: null,
  mailSearch: "",
  mailCategory: null,
  mailSplit: null,
  calendarPlace: "calendar",
  contactsPlace: { kind: "all" },
  notesPlace: { folder: { kind: "all" }, tag: null },
} satisfies Partial<UiState>

export const useUi = create<UiState>((set, get) => ({
  vertical: "mail",
  setVertical: (vertical) => set({ vertical, settings: null, search: null, jump: null, openNote: null, ...FIRST_PLACES }),
  sidebarCollapsed: sidebarCollapsed(),
  setSidebarCollapsed: (collapsed) => {
    try {
      localStorage.setItem(SIDEBAR_KEY, collapsed ? "0" : "1")
    } catch {
      // Not remembered this time; it still collapses.
    }
    set({ sidebarCollapsed: collapsed })
  },
  jump: null,
  jumpTo: (jump) =>
    jump.kind === "note"
      ? set({ vertical: "notes", settings: null, search: null, jump: null, openNote: { id: jump.id, fresh: !!jump.fresh } })
      : set((s) => ({
          vertical: VERTICAL_OF[jump.kind],
          settings: null,
          search: null,
          jump,
          openNote: null,
          // An event shows on the calendar and a person in the list of people, not in one of their tools.
          calendarPlace: jump.kind === "event" ? "calendar" : s.calendarPlace,
          contactsPlace: jump.kind === "contact" && (s.contactsPlace.kind === "duplicates" || s.contactsPlace.kind === "deleted") ? { kind: "all" } : s.contactsPlace,
        })),
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
  settings: null,
  openSettings: (section) =>
    set((s) => ({
      // With none asked for: the first section where the list and the section stand side by side
      // (the expanded width and up), the list of sections alone where a section is a pushed screen.
      settings: section ?? (isExpandedWidth(viewportWidthFor(window.innerWidth)) ? "accounts" : "index"),
      paletteOpen: false,
      // Settings hides the area and lets go of its effects (ADR-0083). A note just made is closed
      // first, as leaving Notes does: empty, it is thrown away; written in, it is in the list.
      openNote: s.openNote?.fresh ? null : s.openNote,
    })),
  closeSettings: () => set({ settings: null }),
  shortcutsOpen: false,
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen, paletteOpen: false }),
  paletteOpen: false,
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  quickContext: null,
  setQuickContext: (quickContext) => set({ quickContext }),
  quickNote: null,
  openQuickNote: (target) => set((s) => ({ quickNote: { target: target === undefined ? s.quickContext : target }, paletteOpen: false })),
  closeQuickNote: () => set({ quickNote: null }),
  mailTab: "inbox",
  teamOpen: null,
  setTeamOpen: (teamOpen) => set({ teamOpen }),
  showTeam: (teamOpen) => set({ vertical: "mail", settings: null, search: null, mailTab: "team", teamOpen, mailSearch: "", mailCategory: null, mailSplit: null, jump: null, openNote: null }),
  setMailTab: (mailTab) => set({ mailTab, settings: null, search: null }),
  showMailTab: (mailTab, mailSearch = "") => set({ vertical: "mail", settings: null, search: null, mailTab, mailSearch, mailCategory: null, mailSplit: null, jump: null, openNote: null }),
  mailAccount: null,
  setMailAccount: (mailAccount) => set({ mailAccount }),
  calendarPlace: "calendar",
  setCalendarPlace: (calendarPlace) => set({ calendarPlace, settings: null, search: null }),
  contactsPlace: { kind: "all" },
  setContactsPlace: (contactsPlace) => set({ contactsPlace, settings: null, search: null }),
  notesPlace: { folder: { kind: "all" }, tag: null },
  setNotesFolder: (folder) => set((s) => ({ notesPlace: { folder, tag: folder.kind === "archive" ? null : s.notesPlace.tag }, settings: null, search: null })),
  setNotesTag: (tag) => set((s) => ({ notesPlace: { ...s.notesPlace, tag: tag === s.notesPlace.tag ? null : tag }, settings: null, search: null })),
  search: null,
  setSearch: (search) => set({ search }),
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
