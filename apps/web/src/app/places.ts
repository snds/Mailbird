import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react"

import { useAdaptiveSheet, useAppFrame, type PageHeadSwipe, type PageHeadSwitcher } from "@unicron/ui"
import type { Category } from "@/core/types"
import { calendarViewPrefs, setCalendarRange, subscribeCalendarViewPrefs, type CalendarRange } from "@/features/calendar/view-prefs"
import type { MailTab } from "@/features/mail/lanes"

import { useUi, type SettingsSection } from "./ui-store"
import type { VerticalId } from "./verticals"

/**
 * Where you are in Vale (ADR-0084; brief 3.1). Each section has one place at
 * a time, and Search and Settings are two more. A place is what a nav item
 * stands for: the one current item of a nav list is read from it, and only a
 * place carries `aria-current`. A filter (Mail's account, the calendars
 * shown, a note tag) narrows a place and has a role of its own.
 *
 * The store (`ui-store.ts`) holds them. This file names them, and keeps the
 * browser's history in step: a change of place, and a screen pushed over a
 * list where list and detail do not stand side by side, each add an entry,
 * so the browser's and the phone's Back go back one place. Only
 * `history.state` changes; the address never does.
 */

/** Mail: a lane, narrowed by an account (null: all of them) and by a category or a split in the Inbox. */
export interface MailPlace {
  lane: MailTab
  account: string | null
  category: Category | null
  split: string | null
}

/** Calendar: the calendar itself, in the range this device shows (`view-prefs.ts`); or one of its two tools. */
export type CalendarPlace = "calendar" | "tasks" | "booking"

/** Contacts: everyone, a label, a smart group, or one of the clean-up tools. */
export type ContactsPlace = { kind: "all" } | { kind: "label"; name: string } | { kind: "group"; id: string } | { kind: "duplicates" } | { kind: "deleted" }

/** Notes: a folder, narrowed by one tag. How they are drawn (list, cards, map) is the core's `NotesPrefs`. */
export interface NotesPlace {
  folder: { kind: "all" } | { kind: "pinned" } | { kind: "folder"; id: string } | { kind: "archive" }
  tag: string | null
}

/** Search, once it is a place (brief X2): what it looks through, the words, and the section it was opened from. */
export interface SearchPlace {
  scope: VerticalId | "all"
  query: string
  from: VerticalId
}

/** Whether the open section's place is an item of its own group in the sidebar. Calendar's ranges are not: "Calendar" under Apps stays current. */
export function placeIsGroupItem(section: VerticalId, calendar: CalendarPlace) {
  return section !== "calendar" || calendar !== "calendar"
}

/**
 * Brings a section on screen without moving it: from another section it
 * opens at its first place; from Settings it comes back as it was left. For
 * an intent that opens something a section's own view mounts
 * (`features/<area>/open-*.ts`).
 */
export function showSection(section: VerticalId) {
  const ui = useUi.getState()
  if (ui.vertical !== section) ui.setVertical(section)
  else if (ui.settings) ui.closeSettings()
}

// ── The page head as the switcher ──────────────────────────────────────────

/** What a page head and its layer share (`section-switcher.tsx` draws the layer). */
export interface SectionSwitch {
  /** For the page head's `switcher`; undefined where the sidebar shows the groups. */
  switcher: PageHeadSwitcher | undefined
  open: boolean
  setOpen: (open: boolean) => void
  /** The groups open as a sheet (a phone): the place for the sheet's own MORE group. */
  sheet: boolean
}

/**
 * `label` is what the button says after the head's title: "Personal. Change
 * folder or account." `onSwipe` steps a filter sideways (Mail's account).
 */
export function useSectionSwitcher(label: string, onSwipe?: (direction: PageHeadSwipe) => void): SectionSwitch {
  const frame = useAppFrame()
  const collapsed = useUi((s) => s.sidebarCollapsed)
  const sheet = useAdaptiveSheet()
  const [open, setOpen] = useState(false)
  const inSidebar = frame.layout === "expanded" && !collapsed && !frame.sidebarRail
  const switcher = useMemo<PageHeadSwitcher | undefined>(
    () => (inSidebar ? undefined : { label, onSwipe, "aria-haspopup": "dialog", "aria-expanded": open, onClick: () => setOpen(true) }),
    [inSidebar, label, onSwipe, open],
  )
  return { switcher, open: open && !inSidebar, setOpen, sheet }
}

export const PickedContext = createContext<() => void>(() => {})

/**
 * For a nav list's rows: call it after a place is picked, and before a row
 * opens a form. In the sheet and the popover it closes them; in the sidebar
 * it does nothing. A calendar's checkbox does not call it: more than one may
 * change, so the list stays open.
 */
export const useNavPicked = () => useContext(PickedContext)

// ── History ────────────────────────────────────────────────────────────────

/** Everything that says where you are. An open item is not here: it is a pushed screen, with an entry of its own. */
interface Snapshot {
  vertical: VerticalId
  settings: SettingsSection | "index" | null
  mailTab: MailTab
  mailAccount: string | null
  mailCategory: Category | null
  mailSplit: string | null
  calendarPlace: CalendarPlace
  range: CalendarRange
  contactsPlace: ContactsPlace
  notesPlace: NotesPlace
  search: SearchPlace | null
}

/** What an entry of ours keeps in `history.state`. */
interface Entry {
  /** Counts up with every entry, so a pop knows which way it went. */
  n: number
  place: Snapshot
  /** Set on a pushed screen's entry: which screen. */
  pushed?: number
}

const snapshot = (): Snapshot => {
  const s = useUi.getState()
  return {
    vertical: s.vertical,
    settings: s.settings,
    mailTab: s.mailTab,
    mailAccount: s.mailAccount,
    mailCategory: s.mailCategory,
    mailSplit: s.mailSplit,
    calendarPlace: s.calendarPlace,
    range: calendarViewPrefs().range,
    contactsPlace: s.contactsPlace,
    notesPlace: s.notesPlace,
    search: s.search,
  }
}
const same = (a: Snapshot, b: Snapshot) => JSON.stringify(a) === JSON.stringify(b)
const entry = (): Entry | null => (history.state as { vale?: Entry } | null)?.vale ?? null

let count = 0
/** The entry we stand on, as last written or popped to. */
let here: Entry | null = null
/** The entries behind this one, newest last, for `stepBack`. Empty after a reload: then a step back is made by hand. */
let behind: Snapshot[] = []
let restoring = false
/** The pushed screen that is open now, if any. An entry of one that has closed is passed over. */
let livePushed: number | null = null

function write(next: Entry, how: "push" | "replace") {
  const state = { ...(history.state as object | null), vale: next }
  if (how === "push") history.pushState(state, "")
  else history.replaceState(state, "")
  here = next
}

/**
 * Keeps the history in step with the place while the shell is mounted
 * (`AppShell` calls it once). Returns what stops it.
 */
export function watchPlaces() {
  count = 0
  behind = []
  write({ n: 0, place: snapshot() }, "replace")
  const changed = () => {
    if (restoring || !here) return
    const now = snapshot()
    if (same(now, here.place)) return
    behind.push(here.place)
    write({ n: ++count, place: now }, "push")
  }
  const offUi = useUi.subscribe(changed)
  const offPrefs = subscribeCalendarViewPrefs(changed)
  const onPop = (e: PopStateEvent) => {
    const to = (e.state as { vale?: Entry } | null)?.vale
    if (!to) return
    const back = !here || to.n < here.n
    // The places behind this one: one fewer on leaving a place backwards, one more on reaching a place forwards.
    if (back && here && here.pushed === undefined) behind.pop()
    if (!back && here && to.pushed === undefined) behind.push(here.place)
    // A screen that was pushed and has since closed another way: nothing to show there, keep going.
    if (to.pushed !== undefined && to.pushed !== livePushed) {
      here = to
      if (back) history.back()
      else history.forward()
      return
    }
    here = to
    restoring = true
    try {
      setCalendarRange(to.place.range)
      // A place lands as it was left; what was open over it is not brought back.
      const { range: _range, ...place } = to.place
      useUi.setState({ ...place, jump: null })
    } finally {
      restoring = false
    }
  }
  window.addEventListener("popstate", onPop)
  return () => {
    offUi()
    offPrefs()
    window.removeEventListener("popstate", onPop)
  }
}

/**
 * A control's own way back (Settings' back button, leaving Settings): when
 * the entry behind is the place it would go to, it is the browser's Back, so
 * the two never disagree. Otherwise `otherwise` goes there by hand.
 */
export function stepBack(wanted: (behind: Pick<Snapshot, "vertical" | "settings">) => boolean, otherwise: () => void) {
  const last = behind.at(-1)
  if (last && here?.pushed === undefined && wanted(last)) history.back()
  else otherwise()
}

let pushes = 0

/**
 * A pushed screen (ADR-0084): where list and detail do not stand side by
 * side (compact and medium), opening an item adds a history entry, so Back
 * closes it and leaves the list where it was. Closing it another way takes
 * the entry away again. `MasterDetail` calls it for every section; a view
 * with panes of its own (Calendar) calls it itself.
 */
export function usePushedScreen(open: boolean, close: () => void) {
  const frame = useAppFrame()
  const active = open && !frame.split
  const latest = useRef(close)
  useEffect(() => {
    latest.current = close
  })
  const id = useRef<number | null>(null)
  const leaving = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!active) return
    // Set up again at once (React's development double run): the entry is still ours.
    if (leaving.current !== null) {
      clearTimeout(leaving.current)
      leaving.current = null
    }
    if (id.current === null || entry()?.pushed !== id.current) {
      id.current = ++pushes
      if (here) write({ n: ++count, place: here.place, pushed: id.current }, "push")
    }
    const mine = id.current
    livePushed = mine
    const onPop = () => {
      // Popped off it: Back was pressed.
      if (entry()?.pushed === mine) return
      id.current = null
      if (livePushed === mine) livePushed = null
      latest.current()
    }
    window.addEventListener("popstate", onPop)
    return () => {
      window.removeEventListener("popstate", onPop)
      leaving.current = setTimeout(() => {
        leaving.current = null
        if (livePushed === mine) livePushed = null
        // Closed from the screen itself while its entry is on top: take the entry away too.
        if (id.current === mine && entry()?.pushed === mine) history.back()
        id.current = null
      }, 0)
    }
  }, [active])
}
