import { useState } from "react"

import type { Collection, Occurrence } from "@/core/types"
import { cn } from "@/lib/utils"

import { eventStyle } from "./colors"
import { DAY, addDays, fmt, sameDay, secs, startOfWeek } from "./dates"
import { occurrenceKey } from "./layout"

/** Chips per day before "+N more"; the rest are a tap away in the day view. */
const PER_DAY = 3

/**
 * Six weeks around a month. Each day lists its events (all-day first, then
 * by time) as compact chips; a day's number opens that day.
 */
export function MonthGrid({
  month,
  occurrences,
  calendars,
  selected,
  onSelect,
  onDay,
}: {
  month: Date
  occurrences: Occurrence[]
  calendars: Map<string, Collection>
  selected: string | null
  onSelect: (o: Occurrence) => void
  onDay: (d: Date) => void
}) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const start = startOfWeek(first)
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i))
  const [now] = useState(() => new Date())
  const on = (d: Date) => occurrences.filter((o) => o.start < secs(d) + DAY && (o.end > secs(d) || (o.end === o.start && o.start >= secs(d))))

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-slot="month-grid">
      <div className="grid shrink-0 grid-cols-7 border-b text-center text-[11px] font-medium text-muted-foreground uppercase" aria-hidden>
        {days.slice(0, 7).map((d) => (
          <span key={d.toISOString()} className="py-1.5">
            {fmt.weekdayShort(d)}
          </span>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6" role="grid" aria-label={fmt.monthYear(first)}>
        {days.map((d) => {
          const list = on(d)
          const outside = d.getMonth() !== first.getMonth()
          const today = sameDay(d, now)
          return (
            <div key={d.toISOString()} role="gridcell" aria-label={fmt.dayLong(d)} className={cn("flex min-h-0 min-w-0 flex-col gap-0.5 overflow-hidden border-r border-b p-1 last:border-r-0", outside && "bg-muted/30")}>
              <button
                type="button"
                onClick={() => onDay(d)}
                aria-label={`Open ${fmt.dayLong(d)}`}
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center self-start rounded-full text-xs tabular-nums outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50",
                  outside && "text-muted-foreground",
                  today && "bg-(--c-calendar-today-chip) font-semibold text-(--c-calendar-today-chip-text) hover:bg-(--c-calendar-today-chip)",
                )}
              >
                {d.getDate()}
              </button>
              {list.slice(0, PER_DAY).map((o) => (
                <button
                  key={occurrenceKey(o)}
                  type="button"
                  onClick={() => onSelect(o)}
                  data-selected={selected === occurrenceKey(o)}
                  aria-label={`${o.title}, ${o.allDay ? "all day" : fmt.time(o.start)}`}
                  className={cn(
                    "flex min-w-0 items-center gap-1 rounded px-1 text-left text-[11px] leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring data-[selected=true]:ring-2 data-[selected=true]:ring-ring",
                    o.allDay ? "event-chip" : "hover:bg-accent",
                  )}
                  style={eventStyle(calendars.get(o.calendarId))}
                >
                  {!o.allDay && <span className="event-dot size-1.5 shrink-0 rounded-full" />}
                  <span className="truncate font-medium">{o.title || "(no title)"}</span>
                  {/* Times only where a day cell has room; the title always wins. */}
                  {!o.allDay && <span className="ml-auto hidden shrink-0 text-muted-foreground tabular-nums 2xl:inline">{fmt.time(o.start)}</span>}
                </button>
              ))}
              {list.length > PER_DAY && (
                <button type="button" onClick={() => onDay(d)} className="self-start px-1 text-[11px] font-medium text-muted-foreground hover:text-foreground">
                  +{list.length - PER_DAY} more
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
