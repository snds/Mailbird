import { useSyncExternalStore } from "react"

import { SHORT_HEIGHT, isExpandedWidth, viewportWidthFor } from "@unicron/ui"

/** How much of the calendar shows at once. */
export type CalendarRange = "agenda" | "day" | "week" | "month"

/**
 * How this device shows the calendar (ADR-0084): the range, and whether the
 * week and the day draw the hours. A per-device choice, so it lives in this
 * browser only, as the second time zone does. Storage can be missing (a
 * private window, blocked site data); then it lasts the session.
 */
export interface CalendarViewPrefs {
  range: CalendarRange
  /** The week and the day as a grid of hours, not cards. The calendar lane reads it when it builds the card week. */
  hours: boolean
}

const KEY = "vale.calendar.view"
const RANGES: readonly CalendarRange[] = ["agenda", "day", "week", "month"]
const listeners = new Set<() => void>()
let current: CalendarViewPrefs | null = null

/** With nothing chosen yet: the agenda on a phone's shells, the week from medium up, as before. */
function first(): CalendarViewPrefs {
  const width = viewportWidthFor(window.innerWidth)
  // The frame's phone shells: the compact width, or a short screen under the expanded width.
  const phone = width === "compact" || (window.innerHeight < SHORT_HEIGHT && !isExpandedWidth(width))
  return { range: phone ? "agenda" : "week", hours: true }
}

function load(): CalendarViewPrefs {
  const start = first()
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<CalendarViewPrefs> | null
    return {
      range: saved && RANGES.includes(saved.range as CalendarRange) ? (saved.range as CalendarRange) : start.range,
      hours: typeof saved?.hours === "boolean" ? saved.hours : start.hours,
    }
  } catch {
    // No storage, or a bad entry: the first choice.
    return start
  }
}

/** The choice now. The command menu and the place history read it outside React. */
export function calendarViewPrefs(): CalendarViewPrefs {
  return (current ??= load())
}

function save(next: CalendarViewPrefs) {
  current = next
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // Kept for this session instead.
  }
  listeners.forEach((l) => l())
}

export function setCalendarRange(range: CalendarRange) {
  if (calendarViewPrefs().range !== range) save({ ...calendarViewPrefs(), range })
}

export function setCalendarHours(hours: boolean) {
  if (calendarViewPrefs().hours !== hours) save({ ...calendarViewPrefs(), hours })
}

export function subscribeCalendarViewPrefs(listener: () => void) {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

export function useCalendarViewPrefs(): CalendarViewPrefs {
  return useSyncExternalStore(subscribeCalendarViewPrefs, calendarViewPrefs, calendarViewPrefs)
}
