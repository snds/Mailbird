import { useEffect, useRef } from "react"

import { useNow } from "@/hooks/use-now"

import type { Collection, Occurrence } from "@/core/types"
import { cn } from "@/lib/utils"

import { eventStyle } from "./colors"
import { DAY, addDays, fmt, sameDay, secs } from "./dates"
import { placeLabel } from "./meeting"
import { layoutDay, occurrenceKey } from "./layout"
import { deviceZone, useSecondZone, zoneAbbr, zoneCity, zoneHour } from "./zones"

const HOURS = Array.from({ length: 24 }, (_, h) => h)
const hourLabel = (h: number) => new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: "numeric" })

export function TimeGrid({
  days,
  occurrences,
  calendars,
  selected,
  onSelect,
  onCreateAt,
}: {
  days: Date[]
  occurrences: Occurrence[]
  calendars: Map<string, Collection>
  selected: string | null
  onSelect: (o: Occurrence) => void
  onCreateAt?: (at: Date) => void
}) {
  const now = useNow()
  const zone = useSecondZone()
  const scroller = useRef<HTMLDivElement>(null)
  // Open on the working day (or just before now), like Apple Calendar.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const hour = Math.max(0, Math.min(new Date().getHours() - 1, 7))
    const px = parseFloat(getComputedStyle(el).getPropertyValue("--c-calendar-hour-height")) * parseFloat(getComputedStyle(document.documentElement).fontSize)
    el.scrollTop = hour * (px || 48)
  }, [])

  const dayStart = (d: Date) => secs(d)
  const timed = (d: Date) => occurrences.filter((o) => !o.allDay && o.start < dayStart(d) + DAY && o.end > dayStart(d))
  const allDay = (d: Date) => occurrences.filter((o) => o.allDay && o.start < secs(addDays(d, 1)) && o.end > dayStart(d))
  const anyAllDay = days.some((d) => allDay(d).length > 0)
  // A second zone adds a gutter column to the left of the device's hours.
  // The second column is wider: half-hour zones read "10:30 PM".
  const gutter = zone ? "calc(var(--c-calendar-gutter) + 1.25rem) var(--c-calendar-gutter)" : "var(--c-calendar-gutter)"
  const cols = { gridTemplateColumns: `${gutter} repeat(${days.length}, minmax(0, 1fr))` }
  const hourAt = (h: number) => {
    const d = new Date(days[0]!)
    d.setHours(h, 0, 0, 0)
    return d
  }

  const chip = (o: Occurrence, className: string, style?: React.CSSProperties, compact = false) => (
    <button
      key={occurrenceKey(o)}
      type="button"
      onClick={(e) => (e.stopPropagation(), onSelect(o))}
      data-selected={selected === occurrenceKey(o)}
      aria-label={`${o.title}, ${o.allDay ? "all day" : `${fmt.time(o.start)} to ${fmt.time(o.end)}`}`}
      className={cn("event-chip overflow-hidden rounded-md text-left text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50 data-[selected=true]:ring-2 data-[selected=true]:ring-ring", className)}
      style={{ ...eventStyle(calendars.get(o.calendarId)), ...style }}
    >
      {compact ? (
        // Short events: one line, title first, so a 15-minute standup still reads.
        <span className="block truncate leading-tight">
          <span className="font-medium">{o.title || "(no title)"}</span> <span className="opacity-80">{fmt.time(o.start)}</span>
        </span>
      ) : (
        <>
          <span className="block truncate font-medium">{o.title || "(no title)"}</span>
          {!o.allDay && <span className="block truncate opacity-80">{fmt.time(o.start)}{placeLabel(o) ? ` · ${placeLabel(o)}` : ""}</span>}
        </>
      )}
    </button>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-slot="time-grid">
      {/* Day headers + all-day row stay put while hours scroll. */}
      <div className="grid shrink-0 border-b" style={cols}>
        {zone ? (
          <>
            <div className="self-end truncate pr-2 pb-1 text-right text-[11px] text-muted-foreground" title={zoneCity(zone)}>
              {zoneAbbr(zone, hourAt(12))}
            </div>
            <div className="self-end truncate pr-2 pb-1 text-right text-[11px] text-muted-foreground" title={zoneCity(deviceZone())}>
              {zoneAbbr(deviceZone(), hourAt(12))}
            </div>
          </>
        ) : (
          <div />
        )}
        {days.map((d) => {
          const today = sameDay(d, now)
          return (
            <div key={d.toISOString()} className="flex flex-col items-center py-1.5 text-xs" aria-current={today ? "date" : undefined}>
              <span className="text-muted-foreground uppercase">{fmt.weekdayShort(d)}</span>
              <span className={cn("flex size-7 items-center justify-center rounded-full text-base font-semibold tabular-nums", today && "bg-(--c-calendar-today) text-white")}>{d.getDate()}</span>
            </div>
          )
        })}
        {anyAllDay && (
          <>
            <div className="self-center pr-2 text-right text-[11px] text-muted-foreground" style={{ gridColumn: zone ? "span 2" : undefined }}>
              all-day
            </div>
            {days.map((d) => (
              <div key={d.toISOString()} className="flex min-w-0 flex-col gap-0.5 border-l px-0.5 pb-1">
                {allDay(d).map((o) => chip(o, "px-1.5 py-0.5"))}
              </div>
            ))}
          </>
        )}
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        <div className="relative grid" style={{ ...cols, height: `calc(var(--c-calendar-hour-height) * 24)` }}>
          {zone && (
            <div className="relative" data-slot="second-zone" aria-label={`Hours in ${zoneCity(zone)}`}>
              {HOURS.slice(1).map((h) => (
                <span key={h} className="absolute right-2 -translate-y-1/2 text-[11px] whitespace-nowrap text-muted-foreground/70 tabular-nums" style={{ top: `calc(var(--c-calendar-hour-height) * ${h})` }}>
                  {zoneHour(zone, hourAt(h))}
                </span>
              ))}
            </div>
          )}
          <div className="relative">
            {HOURS.slice(1).map((h) => (
              <span key={h} className="absolute right-2 -translate-y-1/2 text-[11px] text-muted-foreground tabular-nums" style={{ top: `calc(var(--c-calendar-hour-height) * ${h})` }}>
                {hourLabel(h)}
              </span>
            ))}
          </div>
          {days.map((d) => {
            const placed = layoutDay(d, timed(d))
            const today = sameDay(d, now)
            return (
              <div
                key={d.toISOString()}
                className="relative border-l"
                data-day={d.toDateString()}
                onClick={(e) => {
                  if (!onCreateAt) return
                  const box = e.currentTarget.getBoundingClientRect()
                  const minutes = Math.floor((((e.clientY - box.top) / box.height) * 24 * 60) / 30) * 30
                  const at = new Date(d)
                  at.setHours(0, minutes, 0, 0)
                  onCreateAt(at)
                }}
              >
                {HOURS.slice(1).map((h) => (
                  <div key={h} className="pointer-events-none absolute inset-x-0 border-t border-border/60" style={{ top: `calc(var(--c-calendar-hour-height) * ${h})` }} />
                ))}
                {placed.map((p) =>
                  chip(p.o, cn("absolute px-1.5", p.height < 45 ? "py-0" : "py-1"), {
                    top: `calc(var(--c-calendar-hour-height) * ${p.top / 60})`,
                    height: `calc(var(--c-calendar-hour-height) * ${p.height / 60} - 2px)`,
                    left: `calc(${(p.col / p.cols) * 100}% + 2px)`,
                    width: `calc(${100 / p.cols}% - 4px)`,
                  }, p.height < 45),
                )}
                {today && (
                  <div className="pointer-events-none absolute inset-x-0 z-10 flex items-center" style={{ top: `calc(var(--c-calendar-hour-height) * ${(now.getHours() * 60 + now.getMinutes()) / 60})` }} aria-hidden>
                    <span className="-ml-1 size-2 rounded-full bg-(--c-calendar-now)" />
                    <span className="h-0.5 flex-1 bg-(--c-calendar-now)" />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

