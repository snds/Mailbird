import { CalendarEvent, Highlight, type CalendarEventProps } from "@unicron/ui"
import type { Occurrence } from "@/core/types"

import { fromSecs } from "./dates"

const two = (n: number) => String(n).padStart(2, "0")
const clock = (d: Date) => `${two(d.getHours())}:${two(d.getMinutes())}`
/** A day as the frames write one in a mono line: `WED 11.18`. */
const folio = (d: Date) => `${d.toLocaleDateString(undefined, { weekday: "short" })} ${two(d.getMonth() + 1)}.${two(d.getDate())}`

/** When an occurrence is, as the frames write it: `16:30 – 17:15`, or "All day"; with `date`, the day first. */
function occurrenceTime(o: Pick<Occurrence, "start" | "end" | "allDay">, date = false) {
  const start = fromSecs(o.start)
  const hours = o.allDay ? "All day" : `${clock(start)} – ${clock(fromSecs(o.end))}`
  return date ? `${folio(start)} // ${hours}` : hours
}

export interface OccurrenceCardProps {
  occurrence: Occurrence
  onOpen: () => void
  /** The event open beside the list. */
  selected?: boolean
  /** Say the day before the hours, where the list is not already under a day (search results). */
  date?: boolean
  /** The calendar's swatch (`calendarSwatches`), for the bar. */
  swatch?: CalendarEventProps["swatch"]
  /** The next event: the primary tone. */
  next?: boolean
  /** One line, for a week strip or a month cell. */
  compact?: boolean
  /** The words a search matched: marked in the title and the place. */
  query?: string
}

/**
 * An occurrence as a card (ADR-0085): the core's `Occurrence` on unicron's
 * calendar event. Search lists with it; the calendar's views that adopt it
 * add what they need as optional props.
 */
export function OccurrenceCard({ occurrence: o, onOpen, selected, date, swatch, next, compact, query }: OccurrenceCardProps) {
  const title = o.title || "(no title)"
  return (
    <CalendarEvent
      tone={next ? "primary" : "neutral"}
      selected={selected}
      swatch={swatch}
      compact={compact}
      time={occurrenceTime(o, date)}
      title={query ? <Highlight text={title} query={query} /> : title}
      place={o.location ? query ? <Highlight text={o.location} query={query} /> : o.location : undefined}
      onClick={onOpen}
    />
  )
}
