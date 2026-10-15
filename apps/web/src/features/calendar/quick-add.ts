import * as chrono from "chrono-node"

import type { EventDetail, EventInput } from "@/core/types"
import { zonedInput } from "@/lib/zoned"

import { addDays, dateInput, deviceTimeZone, fromSecs, startOfDay, timeInput } from "./dates"

export interface QuickEvent {
  title: string
  location: string | null
  start: Date
  end: Date
  allDay: boolean
  /** chrono found a date; without one the event lands at the next half hour. */
  dated: boolean
}

/**
 * "Lunch with Ana tomorrow 1pm at Café Lisboa" → title, time, location.
 * Dates and times come from chrono-node (MIT, forward-looking: "Friday"
 * means the coming one). A trailing "at …" or "@ …" that isn't a time is
 * the location.
 */
export function parseQuickAdd(text: string, now = new Date()): QuickEvent | null {
  const input = text.trim()
  if (!input) return null
  const [hit] = chrono.parse(input, now, { forwardDate: true })
  let rest = hit ? (input.slice(0, hit.index) + " " + input.slice(hit.index + hit.text.length)).replace(/\s+/g, " ").trim() : input

  let location: string | null = null
  const loc = /\s(?:at|@)\s+(.+)$/i.exec(` ${rest}`)
  if (loc) {
    location = loc[1]!.trim()
    rest = ` ${rest}`.slice(0, loc.index).trim()
  }
  // Leftover connectives from the removed date ("Dinner on", "Call at").
  const title = rest.replace(/\s+(on|at|from|for|@)$/i, "").trim()
  if (!title) return null

  if (!hit) {
    const start = new Date(now)
    start.setMinutes(start.getMinutes() < 30 ? 30 : 60, 0, 0)
    return { title, location, start, end: new Date(start.getTime() + 3_600_000), allDay: false, dated: false }
  }
  const allDay = !hit.start.isCertain("hour")
  if (allDay) {
    const start = startOfDay(hit.start.date())
    const last = hit.end ? startOfDay(hit.end.date()) : start
    return { title, location, start, end: addDays(last, 1), allDay, dated: true }
  }
  const start = hit.start.date()
  const end = hit.end?.date() ?? new Date(start.getTime() + 3_600_000)
  return { title, location, start, end: end > start ? end : new Date(start.getTime() + 3_600_000), allDay, dated: true }
}

export function quickToInput(q: QuickEvent, calendarId: string): EventInput {
  return {
    calendarId,
    title: q.title,
    location: q.location,
    notes: null,
    allDay: q.allDay,
    start: q.allDay ? dateInput(q.start) : `${dateInput(q.start)}T${timeInput(q.start)}`,
    end: q.allDay ? dateInput(q.end) : `${dateInput(q.end)}T${timeInput(q.end)}`,
    timeZone: deviceTimeZone(),
    repeat: "none",
  }
}

/** The editor's starting point for an existing event (its series start). */
export function inputFromDetail(e: EventDetail): Partial<EventInput> {
  const a = fromSecs(e.start)
  const b = fromSecs(e.end)
  // Timed events open in the zone they were written in, so saving keeps it (ADR-0029).
  const zone = !e.allDay && e.timeZone && zoneKnown(e.timeZone) ? e.timeZone : deviceTimeZone()
  return {
    calendarId: e.calendarId,
    title: e.title,
    location: e.location,
    notes: e.notes,
    allDay: e.allDay,
    start: e.allDay ? dateInput(a) : zonedInput(e.start, zone),
    end: e.allDay ? dateInput(b) : zonedInput(e.end, zone),
    repeat: e.repeat,
    timeZone: zone,
    travel: e.travel ?? 0,
  }
}

/** Whether this browser knows an IANA zone (Windows names from Outlook don't parse). */
function zoneKnown(zone: string) {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: zone })
    return true
  } catch {
    return false
  }
}
