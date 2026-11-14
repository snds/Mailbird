import { useState } from "react"

import { SectionHeader, useAppFrame } from "@unicron/ui"
import { MonthGrid as MonthPicker } from "@/components/month-grid"
import type { Collection, Occurrence } from "@/core/types"
import { calendarSwatches, eventSwatch, type SwatchNumber } from "@/lib/swatches"
import { cn } from "@/lib/utils"

import { eventStyle } from "./colors"
import { DAY, addDays, dayLabel, fmt, sameDay, secs, startOfWeek } from "./dates"
import { occurrenceKey } from "./layout"
import { OccurrenceCard } from "./occurrence-card"

/** Chips per day before "+N more"; the rest are a tap away in the day view. */
const PER_DAY = 3

interface MonthProps {
  /** The day in focus: its month shows, and on a phone it is the picked day. */
  month: Date
  occurrences: Occurrence[]
  calendars: Map<string, Collection>
  selected: string | null
  onSelect: (o: Occurrence) => void
  /** Opens a day in the day view. */
  onDay: (d: Date) => void
  /** Picks a day without leaving the month (the phone's Month). */
  onPickDay: (d: Date) => void
}

const eventsOn = (occurrences: Occurrence[], d: Date) => occurrences.filter((o) => o.start < secs(d) + DAY && (o.end > secs(d) || (o.end === o.start && o.start >= secs(d))))

/**
 * Six weeks around a month. On a desktop each day lists its events (all-day
 * first, then by time) as compact chips, and a day's number opens that day.
 * On a phone the month is the shared month grid (ADR-0088; brief C1).
 */
export function MonthGrid(props: MonthProps) {
  return useAppFrame().phone ? <PhoneMonth {...props} /> : <DesktopMonth {...props} />
}

/**
 * The phone's Month (brief C1): the month grid with up to three swatch
 * squares a day. Pressing a day picks it and lists its events under the grid.
 */
function PhoneMonth({ month, occurrences, calendars, selected, onSelect, onPickDay }: MonthProps) {
  const swatches = calendarSwatches(calendars.values())
  const list = eventsOn(occurrences, month)
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-6" data-slot="month-grid">
      <div className="shrink-0">
      <MonthPicker
        variant="month"
        paging={false}
        month={month}
        // The page head pages the month; a key that leaves it moves the picked day with it.
        onMonthChange={onPickDay}
        selected={month}
        onPick={onPickDay}
        marks={(d) => {
          const on = eventsOn(occurrences, d)
          // One square a calendar, in the order of the day; an event of a calendar with no color adds none.
          const seen = [...new Set(on.map((o) => swatches.get(o.calendarId)).filter((s): s is SwatchNumber => !!s))]
          return { events: on.length, swatches: seen }
        }}
      />
      </div>
      <section className="flex shrink-0 flex-col gap-2" aria-label={dayLabel(month)}>
        <SectionHeader title={dayLabel(month)} count={list.length} />
        {list.length === 0 && <p className="type-body text-text-secondary">Nothing planned</p>}
        {list.map((o) => (
          <OccurrenceCard key={occurrenceKey(o)} occurrence={o} swatch={eventSwatch(swatches.get(o.calendarId))} selected={selected === occurrenceKey(o)} onOpen={() => onSelect(o)} />
        ))}
      </section>
    </div>
  )
}

function DesktopMonth({ month, occurrences, calendars, selected, onSelect, onDay }: MonthProps) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const start = startOfWeek(first)
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i))
  const [now] = useState(() => new Date())
  const on = (d: Date) => eventsOn(occurrences, d)

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
