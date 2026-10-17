import { useMemo, useState } from "react"

import { Badge, IconButton, Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@unicron/ui"
import { getCoreClient, type AppJump } from "@/core/client"
import { useCoreEvents, useOccurrences } from "@/core/queries"
import type { Occurrence } from "@/core/types"
import { useNowSecs } from "@/hooks/use-now"
import { APP_JUMP_KEY } from "@/lib/app-jump"

import { eventStyle } from "./colors"
import { addDays, dayLabel, fmt, fromSecs, rangeLabel, secs, startOfDay, startOfWeek } from "./dates"
import { QuickAdd } from "./index"
import { JoinButton } from "./join-button"
import { occurrenceKey } from "./layout"
import { placeLabel } from "./meeting"
import { MiniMonth } from "./mini-month"
import { AHEAD, nextUp, whenLabel } from "./next-up"
import { useCalendars } from "./use-calendars"

/** The menu-bar mini calendar (ADR-0054): today, what's next, a month to
 * pick a day from, that day's events, and quick add. It's the desktop's
 * small window under the tray icon; `/?mini` in a browser shows the same. */
export function MiniCalendar() {
  useCoreEvents()
  const calendars = useCalendars()
  const now = useNowSecs(30_000)
  const today = startOfDay(fromSecs(now))
  // The window stays open for days: a new day starts back at today.
  const todayKey = today.getTime()
  const [chosen, setChosen] = useState({ on: todayKey, picked: today, month: today })
  const { picked, month } = chosen.on === todayKey ? chosen : { picked: today, month: today }
  const setPicked = (d: Date) => setChosen({ on: todayKey, picked: startOfDay(d), month: d })
  const setMonth = (d: Date) => setChosen({ on: todayKey, picked, month: d })

  const { data: soon = [] } = useOccurrences(now - AHEAD, now + AHEAD)
  const { data: dayOcc = [] } = useOccurrences(secs(picked), secs(addDays(picked, 1)))
  const gridStart = startOfWeek(new Date(month.getFullYear(), month.getMonth(), 1))
  const { data: monthOcc = [] } = useOccurrences(secs(gridStart), secs(addDays(gridStart, 42)))
  const busyDays = useMemo(() => new Set(monthOcc.flatMap((o) => daysOf(o))), [monthOcc])
  const next = nextUp(soon, now)

  // The desktop brings its main window forward; a browser (the gateway) has
  // only this one, so it opens the app page in its place.
  const open = async (jump: AppJump | null) => {
    try {
      await (await getCoreClient()).showApp(jump)
    } catch {
      try {
        if (jump) sessionStorage.setItem(APP_JUMP_KEY, JSON.stringify(jump))
      } catch {
        // No storage: the app opens without the jump.
      }
      location.assign("/")
    }
  }
  const openEvent = (o: Occurrence) => void open({ kind: "event", id: o.eventId, start: o.start })

  return (
    <div data-slot="mini-calendar" className="mx-auto flex h-dvh max-w-md flex-col bg-background text-foreground">
      <header className="flex items-start justify-between gap-2 px-4 pt-3">
        <div>
          <p className="text-xs font-semibold tracking-wide text-(--c-calendar-today) uppercase">{today.toLocaleDateString(undefined, { weekday: "long" })}</p>
          <h1 className="text-lg font-semibold">{today.toLocaleDateString(undefined, { month: "long", day: "numeric" })}</h1>
        </div>
        <IconButton label="Open Mailbird" icon="open_in_new" onClick={() => void open(null)} />
      </header>

      <section aria-label="Next up" className="px-3 pt-2">
        {next ? (
          <div className="grid grid-cols-[1fr_auto] items-center gap-2" style={eventStyle(calendars.get(next.calendarId))}>
            <Item variant="muted" size="sm" render={<button type="button" onClick={() => openEvent(next)} />}>
              <ItemMedia>
                <span aria-hidden className="event-dot h-8 w-1 rounded-full" />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>
                  {next.title || "(no title)"}
                  <Badge variant={next.start <= now ? "default" : "secondary"}>{next.start <= now ? "Now" : whenLabel(next, now)}</Badge>
                </ItemTitle>
                <ItemDescription>{[rangeLabel(next.start, next.end, false), placeLabel(next)].filter(Boolean).join(" · ")}</ItemDescription>
              </ItemContent>
            </Item>
            {next.meetingUrl && <JoinButton url={next.meetingUrl} appUrl={next.meetingAppUrl} />}
          </div>
        ) : (
          <p className="px-1 py-2 text-sm text-muted-foreground">Nothing else in the next 12 hours.</p>
        )}
      </section>

      <div className="pt-2">
        <MiniMonth month={month} onMonth={setMonth} selected={picked} onPick={setPicked} busy={(d) => busyDays.has(startOfDay(d).getTime())} />
      </div>

      <section aria-label={dayLabel(picked, today)} className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
        <h2 className="px-1 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{dayLabel(picked, today)}</h2>
        {dayOcc.length === 0 && <p className="px-1 text-sm text-muted-foreground">Nothing planned.</p>}
        <div className="flex flex-col gap-0.5">
          {dayOcc.map((o) => (
            <div key={occurrenceKey(o)} className="grid grid-cols-[1fr_auto] items-center gap-2" style={eventStyle(calendars.get(o.calendarId))}>
              <Item size="xs" render={<button type="button" onClick={() => openEvent(o)} />}>
                <ItemMedia>
                  <span aria-hidden className="event-dot h-6 w-1 rounded-full" />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{o.title || "(no title)"}</ItemTitle>
                  <ItemDescription>{[o.allDay ? "All day" : `${fmt.time(Math.max(o.start, secs(picked)))} – ${fmt.time(o.end)}`, placeLabel(o)].filter(Boolean).join(" · ")}</ItemDescription>
                </ItemContent>
              </Item>
              {o.meetingUrl && o.end > now && <JoinButton url={o.meetingUrl} appUrl={o.meetingAppUrl} variant="outline" />}
            </div>
          ))}
        </div>
      </section>

      <div className="border-t pt-3">
        <QuickAdd calendars={calendars} />
      </div>
    </div>
  )
}

/** The local midnights an occurrence touches, for the month's busy dots. */
function daysOf(o: Occurrence): number[] {
  const out: number[] = []
  const end = o.end > o.start ? o.end - 1 : o.start
  for (let d = startOfDay(fromSecs(o.start)); secs(d) <= end && out.length < 42; d = addDays(d, 1)) out.push(d.getTime())
  return out
}
