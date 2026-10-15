import { useState } from "react"

import type { Collection, Occurrence } from "@/core/types"
import { cn } from "@/lib/utils"

import { eventStyle } from "./colors"
import { JoinButton } from "./join-button"
import { placeLabel } from "./meeting"
import { DAY, addDays, dayLabel, fmt, fromSecs, rangeLabel, sameDay, secs } from "./dates"
import { occurrenceKey } from "./layout"

/**
 * The phone's calendar: upcoming days with something on them, today always
 * shown (with "Nothing planned" when it's free) so you know where you are.
 */
export function Agenda({
  from,
  days,
  occurrences,
  calendars,
  selected,
  onSelect,
  onMore,
}: {
  from: Date
  days: number
  occurrences: Occurrence[]
  calendars: Map<string, Collection>
  selected: string | null
  onSelect: (o: Occurrence) => void
  onMore: () => void
}) {
  // Read once per mount; the view remounts when you navigate.
  const [now] = useState(() => new Date())
  const list = Array.from({ length: days }, (_, i) => addDays(from, i))
    .map((d) => ({
      day: d,
      items: occurrences.filter((o) => o.start < secs(d) + DAY && (o.end > secs(d) || (o.end === o.start && sameDay(fromSecs(o.start), d)))),
    }))
    .filter(({ day, items }) => items.length > 0 || sameDay(day, now))

  return (
    <div className="pb-24" data-slot="agenda">
      {list.map(({ day, items }) => (
        <section key={day.toISOString()} aria-label={dayLabel(day, now)}>
          <h3 className={cn("sticky top-0 z-10 bg-surface-chrome/95 px-4 py-2 text-xs font-semibold tracking-wide uppercase backdrop-blur", sameDay(day, now) ? "text-(--c-calendar-today)" : "text-muted-foreground")}>
            {dayLabel(day, now)}
            {/* "Today", "Tomorrow" get the date beside them. */}
            {dayLabel(day, now) !== fmt.dayLong(day) && <span className="ml-2 font-normal text-muted-foreground normal-case">{fmt.dayLong(day)}</span>}
          </h3>
          {items.length === 0 && <p className="px-4 pb-3 text-sm text-muted-foreground">Nothing planned</p>}
          {items.map((o) => (
            // The Join link sits beside the row's button: a link can't go inside a button.
            <div
              key={occurrenceKey(o)}
              data-selected={selected === occurrenceKey(o)}
              className="flex items-center has-[>button:hover]:bg-accent/50 has-[>button:focus-visible]:bg-accent data-[selected=true]:bg-surface-selected"
              style={eventStyle(calendars.get(o.calendarId))}
            >
              <button
                type="button"
                onClick={() => onSelect(o)}
                className="flex min-w-0 flex-1 items-stretch gap-3 py-2 pl-4 text-left outline-none last:pr-4"
              >
                <span className="w-16 shrink-0 pt-0.5 text-xs text-muted-foreground tabular-nums">
                  {o.allDay ? "All day" : fmt.time(Math.max(o.start, secs(day)))}
                  {!o.allDay && o.end > o.start && sameDay(fromSecs(o.end), day) && (
                    <>
                      <br />
                      {fmt.time(o.end)}
                    </>
                  )}
                </span>
                <span className="event-dot w-1 shrink-0 rounded-full" />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-medium">{o.title || "(no title)"}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {[placeLabel(o), o.allDay && o.end - o.start > DAY ? rangeLabel(o.start, o.end, true) : null].filter(Boolean).join(" · ")}
                  </span>
                </span>
              </button>
              {o.meetingUrl && o.end > now.getTime() / 1000 && <JoinButton url={o.meetingUrl} appUrl={o.meetingAppUrl} variant="outline" className="mx-4 shrink-0" />}
            </div>
          ))}
        </section>
      ))}
      <div className="px-4 py-4">
        <button type="button" onClick={onMore} className="text-sm font-medium text-primary hover:underline">
          Show the next {days} days
        </button>
      </div>
    </div>
  )
}
