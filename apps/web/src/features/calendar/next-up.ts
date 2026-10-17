import type { Occurrence } from "@/core/types"

/** How far ahead "next up" looks, as the menu bar does (ADR-0054). */
export const AHEAD = 12 * 3600

/** The event the menu bar talks about: on now, or the next to start in the
 * next 12 hours; all-day events and birthdays don't count, and something
 * starting within 5 minutes beats what's on now. The same rule as
 * `pim_app::menu_bar::next_up`, so the panel and the menu bar agree. */
export function nextUp(occurrences: Occurrence[], at: number): Occurrence | null {
  const timed = occurrences.filter((o) => !o.allDay && !o.contactId && o.end > at && o.start < at + AHEAD)
  const on = timed.filter((o) => o.start <= at).sort((a, b) => a.end - b.end)[0]
  const next = timed.filter((o) => o.start > at).sort((a, b) => a.start - b.start || a.end - b.end)[0]
  if (on && next && next.start - at <= 5 * 60) return next
  return on ?? next ?? null
}

/** "now", "in 25 min", "in 2 h 5 min": the menu bar's words. */
export function whenLabel(o: Occurrence, at: number) {
  if (o.start <= at) return "now"
  const mins = Math.ceil((o.start - at) / 60)
  const [h, m] = [Math.floor(mins / 60), mins % 60]
  return h === 0 ? `in ${m} min` : m === 0 ? `in ${h} h` : `in ${h} h ${m} min`
}
