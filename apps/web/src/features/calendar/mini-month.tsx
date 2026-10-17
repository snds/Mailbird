import { useState } from "react"

import { Icon, Button } from "@unicron/ui"
import { cn } from "@/lib/utils"

import { addDays, addMonths, fmt, sameDay, startOfWeek } from "./dates"

/** A month to jump around in; days with events get a dot. */
export function MiniMonth({ month, onMonth, selected, onPick, busy }: { month: Date; onMonth: (d: Date) => void; selected: Date; onPick: (d: Date) => void; busy: (d: Date) => boolean }) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const start = startOfWeek(first)
  const cells = Array.from({ length: 42 }, (_, i) => addDays(start, i))
  // Read once per mount; the view remounts when you navigate.
  const [now] = useState(() => new Date())
  return (
    <div className="px-3 pb-2" data-slot="mini-month">
      <div className="flex items-center justify-between pb-1 pl-1">
        <span className="text-sm font-semibold">{fmt.monthYear(first)}</span>
        <div className="flex">
          <Button variant="ghost" size="icon-sm" aria-label="Previous month" onClick={() => onMonth(addMonths(first, -1))}>
            <Icon name="chevron_left" />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Next month" onClick={() => onMonth(addMonths(first, 1))}>
            <Icon name="chevron_right" />
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-7 text-center text-[11px] text-muted-foreground" aria-hidden>
        {cells.slice(0, 7).map((d) => (
          <span key={d.toISOString()} className="py-1">
            {d.toLocaleDateString(undefined, { weekday: "narrow" })}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-7" role="grid" aria-label={fmt.monthYear(first)}>
        {cells.map((d) => {
          const outside = d.getMonth() !== first.getMonth()
          return (
            <button
              key={d.toISOString()}
              type="button"
              onClick={() => onPick(d)}
              aria-label={fmt.dayLong(d)}
              aria-pressed={sameDay(d, selected)}
              className={cn(
                "relative mx-auto flex size-8 items-center justify-center rounded-full text-xs tabular-nums outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50",
                outside && "text-muted-foreground/60",
                sameDay(d, selected) && "bg-accent font-semibold",
                sameDay(d, now) && "font-semibold text-(--c-calendar-today-text)",
              )}
            >
              {d.getDate()}
              {busy(d) && <span className="absolute bottom-1 size-1 rounded-full bg-muted-foreground/70" />}
            </button>
          )
        })}
      </div>
    </div>
  )
}
