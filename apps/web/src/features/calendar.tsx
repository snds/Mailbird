import { useState } from "react"

import { Icon } from "@/components/icon"
import { MasterDetail, PaneHeader } from "@/components/master-detail"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { events, type CalendarEvent } from "@/data/mock"
import { cn } from "@/lib/utils"

const CALENDAR_DOT: Record<CalendarEvent["calendar"], string> = {
  Work: "bg-vertical-mail",
  Personal: "bg-vertical-calendar",
  Family: "bg-vertical-contacts",
}

/**
 * Agenda first: on a phone the agenda is the calendar. Day/week grids arrive
 * with Schedule-X (MIT core), skinned with the same tokens.
 */
export function CalendarView() {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [range, setRange] = useState<string[]>(["agenda"])
  const selected = events.find((e) => e.id === selectedId) ?? null
  const days = [...new Set(events.map((e) => e.day))]

  return (
    <MasterDetail
      emptyIcon="event"
      emptyLabel="Pick an event to see details, notes, and the related thread."
      onBack={() => setSelectedId(null)}
      header={
        <>
          <PaneHeader title="Calendar">
            <Button variant="ghost" size="icon" aria-label="Today">
              <Icon name="today" />
            </Button>
          </PaneHeader>
          <div className="px-4 pb-3">
            {/* Natural-language quick add ("Lunch w/ Sam Fri 1pm") lands here. */}
            <ToggleGroup value={range} onValueChange={setRange} variant="outline" size="sm">
              <ToggleGroupItem value="agenda">Agenda</ToggleGroupItem>
              <ToggleGroupItem value="day">Day</ToggleGroupItem>
              <ToggleGroupItem value="week">Week</ToggleGroupItem>
            </ToggleGroup>
          </div>
        </>
      }
      list={days.map((day) => (
        <div key={day} className="pb-2">
          <h3 className="sticky top-0 bg-surface-chrome px-4 py-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {day}
          </h3>
          {events
            .filter((e) => e.day === day)
            .map((e) => (
              <button
                key={e.id}
                type="button"
                onClick={() => setSelectedId(e.id)}
                data-selected={e.id === selectedId}
                className="flex w-full items-stretch gap-3 px-4 py-2 text-left hover:bg-accent/50 data-[selected=true]:bg-surface-selected"
              >
                <span className="w-12 shrink-0 pt-0.5 text-xs text-muted-foreground tabular-nums">
                  {e.start}
                  <br />
                  {e.end}
                </span>
                <span className={cn("w-1 shrink-0 rounded-full", CALENDAR_DOT[e.calendar])} />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-medium">{e.title}</span>
                  {e.location && <span className="truncate text-xs text-muted-foreground">{e.location}</span>}
                </span>
              </button>
            ))}
        </div>
      ))}
      detail={
        selected && (
          <div className="mx-auto flex max-w-2xl flex-col gap-4 px-4 pb-8 md:px-8 md:pt-6">
            <div className="flex items-center gap-2">
              <span className={cn("size-3 rounded-full", CALENDAR_DOT[selected.calendar])} />
              <Badge variant="secondary">{selected.calendar}</Badge>
            </div>
            <h2 className="text-xl font-semibold tracking-tight">{selected.title}</h2>
            <dl className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-sm">
              <Icon name="schedule" className="text-muted-foreground" />
              <dd>
                {selected.day}, {selected.start}–{selected.end}
              </dd>
              {selected.location && (
                <>
                  <Icon name="location_on" className="text-muted-foreground" />
                  <dd>{selected.location}</dd>
                </>
              )}
            </dl>
            <Button variant="outline" className="self-start">
              <Icon name="note_add" data-icon="inline-start" /> Add meeting note
            </Button>
          </div>
        )
      }
    />
  )
}
