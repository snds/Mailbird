import { useEffect, useRef, useState, type KeyboardEvent } from "react"

import { Button, Icon } from "@unicron/ui"
import { addDays, addMonths, fmt, sameDay, startOfDay, startOfWeek } from "@/features/calendar/dates"
import { swatchSquare, type SwatchNumber } from "@/lib/swatches"
import { cn } from "@/lib/utils"

/** What a day carries: how many events, and the swatches of their calendars (the phone's Month shows up to three). */
export interface DayMark {
  events: number
  swatches?: SwatchNumber[]
}

export interface MonthGridProps {
  /** Any day of the month to show. */
  month: Date
  /** Another month is wanted: the paging buttons, Page Up and Down, or an arrow off the month's edge. */
  onMonthChange: (month: Date) => void
  /** The picked day. It takes the primary block. */
  selected?: Date | null
  /** Pressing a day, or Enter on it. Without it no day can be picked, and today takes the block. */
  onPick?: (day: Date) => void
  /**
   * `picker` (the default): the date pickers, Go to date, the calendar's list column.
   * `month`: the phone's Month, with taller cells and up to three swatch squares a day.
   * `compact`: the 320 px menu-bar window.
   */
  variant?: "picker" | "month" | "compact"
  /** The month's name over the grid, with the two paging buttons. Off where the page head already has both. */
  paging?: boolean
  /** A day's events, for its mark and its spoken name. */
  marks?: (day: Date) => DayMark | undefined
  /** The first day that can be picked. Earlier days are shown and cannot be. */
  min?: Date
}

const eventsLabel = (n: number) => (n === 1 ? "1 event" : `${n} events`)
const key = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`

/**
 * The month grid (ADR-0088; briefs 1.3, 1.4, C1, C8): weekday initials and six
 * weeks. One part for the date pickers, Go to date, the phone's Month and the
 * menu-bar month.
 *
 * - The picked day is the primary block. Today, when another day is picked,
 *   keeps its ink and takes the 2 px edge under it. Where no day can be picked,
 *   today takes the block. Days outside the month are faint.
 * - A grid named for its month; each day is named with its full date and its
 *   events. One day is in the tab order. Arrows move a day, Page Up and Down a
 *   month (with Shift, a year), Home and End to the week's ends; Enter or
 *   Space picks.
 *
 * The cells are plain elements drawn from tokens in `styles/calendar.css`.
 */
export function MonthGrid({ month, onMonthChange, selected = null, onPick, variant = "picker", paging = true, marks, min }: MonthGridProps) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const start = startOfWeek(first)
  const weeks = Array.from({ length: 6 }, (_, w) => Array.from({ length: 7 }, (_, d) => addDays(start, w * 7 + d)))
  // Read once per mount; the views remount when you navigate.
  const [today] = useState(() => startOfDay(new Date()))
  const inMonth = (d: Date | null): d is Date => !!d && d.getMonth() === first.getMonth() && d.getFullYear() === first.getFullYear()
  const floor = min ? startOfDay(min) : null
  const tooEarly = (d: Date) => !!floor && d < floor

  // The one day in the tab order: where the keys last went, else the picked day, else today, else the 1st.
  const [cursor, setCursor] = useState<Date | null>(null)
  const active = inMonth(cursor) ? cursor : inMonth(selected) ? startOfDay(selected) : inMonth(today) ? today : first
  const cells = useRef(new Map<string, HTMLDivElement>())
  const refocus = useRef(false)
  useEffect(() => {
    // After a key moved the day (to another month, perhaps): focus follows it.
    if (!refocus.current) return
    refocus.current = false
    cells.current.get(key(active))?.focus()
  })

  const go = (day: Date) => {
    refocus.current = true
    setCursor(day)
    if (!inMonth(day)) onMonthChange(day)
  }
  const pick = (day: Date) => {
    if (!onPick || tooEarly(day)) return
    setCursor(day)
    onPick(day)
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const weekStart = startOfWeek(active)
    const to: Record<string, () => Date> = {
      ArrowLeft: () => addDays(active, -1),
      ArrowRight: () => addDays(active, 1),
      ArrowUp: () => addDays(active, -7),
      ArrowDown: () => addDays(active, 7),
      PageUp: () => addMonths(active, e.shiftKey ? -12 : -1),
      PageDown: () => addMonths(active, e.shiftKey ? 12 : 1),
      Home: () => weekStart,
      End: () => addDays(weekStart, 6),
    }
    if (to[e.key]) go(to[e.key]!())
    else if (e.key === "Enter" || e.key === " ") pick(active)
    else return
    // The keys are the grid's: a form or a list around it does not also act on them.
    e.preventDefault()
    e.stopPropagation()
  }

  return (
    <div className="month-grid" data-slot="month-grid" data-variant={variant}>
      {/* The days come first in the page's order, so a picker opens on its day; the head stands over them by its grid area. */}
      <div className="month-grid-days" role="grid" aria-label={fmt.monthYear(first)} onKeyDown={onKeyDown}>
        <div role="row" className="month-grid-week">
          {weeks[0]!.map((d) => (
            <span key={d.getDay()} role="columnheader" aria-label={d.toLocaleDateString(undefined, { weekday: "long" })} className="month-grid-weekday type-overline">
              {d.toLocaleDateString(undefined, { weekday: "narrow" })}
            </span>
          ))}
        </div>
        {weeks.map((week) => (
          <div key={key(week[0]!)} role="row" className="month-grid-week">
            {week.map((d) => {
              const mark = marks?.(d)
              const isToday = sameDay(d, today)
              const picked = !!selected && sameDay(d, selected)
              const off = tooEarly(d)
              const squares = variant === "month" ? (mark?.swatches ?? []).slice(0, 3) : []
              return (
                <div
                  key={key(d)}
                  ref={(el) => {
                    if (el) cells.current.set(key(d), el)
                    else cells.current.delete(key(d))
                  }}
                  role="gridcell"
                  tabIndex={sameDay(d, active) ? 0 : -1}
                  aria-label={[fmt.dayLong(d), d.getFullYear() !== today.getFullYear() ? String(d.getFullYear()) : null, isToday ? "today" : null, mark?.events ? eventsLabel(mark.events) : null].filter(Boolean).join(", ")}
                  aria-selected={onPick ? picked : undefined}
                  aria-current={isToday ? "date" : undefined}
                  aria-disabled={off || undefined}
                  data-outside={inMonth(d) ? undefined : ""}
                  data-today={isToday ? "" : undefined}
                  // The block: the picked day, or today where no day can be picked.
                  data-block={picked || (!onPick && isToday) ? "" : undefined}
                  data-pick={onPick && !off ? "" : undefined}
                  className="month-grid-day"
                  onClick={() => pick(d)}
                >
                  <span className={variant === "compact" ? "type-label" : "type-body-strong"}>{String(d.getDate()).padStart(2, "0")}</span>
                  {squares.length > 0 ? (
                    <span className="month-grid-marks" aria-hidden>
                      {squares.map((s, i) => (
                        <span key={i} className={cn(swatchSquare(s))} />
                      ))}
                    </span>
                  ) : mark?.events ? (
                    <span className="month-grid-marks" aria-hidden>
                      <span className="month-grid-busy" />
                    </span>
                  ) : null}
                </div>
              )
            })}
          </div>
        ))}
      </div>
      {paging && (
        <>
          <p className="month-grid-title type-overline" aria-hidden>
            {fmt.monthYear(first)}
          </p>
          <div className="month-grid-paging">
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Previous month" onClick={() => onMonthChange(addMonths(first, -1))}>
              <Icon name="chevron--left" />
            </Button>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Next month" onClick={() => onMonthChange(addMonths(first, 1))}>
              <Icon name="chevron--right" />
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
