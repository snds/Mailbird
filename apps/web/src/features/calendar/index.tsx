import { useEffect, useState } from "react"

import { usePushedScreen, useSectionSwitcher } from "@/app/places"
import { SectionSwitcher } from "@/app/section-switcher"
import { pendingJump, useUi } from "@/app/ui-store"
import { Icon, AppFrameColumn, Button, Sheet, SheetContent, SheetTitle, ToggleGroup, ToggleGroupItem, toast, useAppFrame, useViewport } from "@unicron/ui"
import { DemoBar } from "@/app/demo-bar"
import { useRefresh, useScreenFact, useScreenPlace, useScreenRoot } from "@/app/screen"
import { ScreenHead } from "@/components/page"
import { useAccounts, useKeyBindings, useOccurrences, usePimAction } from "@/core/queries"
import type { Collection, Occurrence } from "@/core/types"
import { ariaKey, commandFor } from "@/lib/keys"
import { cn } from "@/lib/utils"

import { Agenda } from "./agenda"
import { CalendarNav } from "./calendar-nav"
import { SaveSetDialog } from "./calendar-sets"
import { DAY, addDays, addMonths, dateInput, fmt, fromSecs, secs, startOfDay, startOfWeek, timeInput } from "./dates"
import { EventDetailPane } from "./event-detail"
import { MiniMonth } from "./mini-month"
import { useCalendars } from "./use-calendars"
import { MonthGrid } from "./month-grid"
import { parseQuickAdd, quickToInput } from "./quick-add"
import { BookingLinks } from "./booking-links"
import { AddCalendarsDialog } from "./interesting"
import { TasksPanel } from "./tasks"
import { occurrenceKey } from "./layout"
import { TimeGrid } from "./time-grid"
import { setCalendarRange, useCalendarViewPrefs, type CalendarRange } from "./view-prefs"

type View = CalendarRange

interface Selected {
  eventId: string
  start: number
}

/** Natural-language add: "Lunch with Ana tomorrow 1pm at Café". */
export function QuickAdd({ calendars }: { calendars: Map<string, Collection> }) {
  const [text, setText] = useState("")
  const create = usePimAction((c, input: Parameters<typeof c.createEvent>[0]) => c.createEvent(input))
  const target = [...calendars.values()].find((c) => c.writable && !c.hidden) ?? [...calendars.values()].find((c) => c.writable)
  const parsed = parseQuickAdd(text)
  const submit = async () => {
    if (!parsed || !target) return
    try {
      const e = await create.mutateAsync(quickToInput(parsed, target.id))
      setText("")
      toast.success(`Added “${e.title}”`, { description: `${fmt.dayLong(fromSecs(e.start))}${e.allDay ? "" : `, ${fmt.time(e.start)}`} · ${target.name}`, duration: 3000 })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }
  return (
    <form className="flex flex-col gap-1 px-4 pb-3" onSubmit={(e) => (e.preventDefault(), void submit())} data-slot="quick-add">
      <div className="flex h-10 items-center gap-2 rounded-xl bg-muted/70 px-3 focus-within:ring-3 focus-within:ring-ring/50">
        <Icon name="add" tone="muted" />
        <input
          aria-label="Quick add event"
          placeholder="Lunch with Ana tomorrow 1pm"
          className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          value={text}
          onChange={(e) => setText(e.target.value)}
          enterKeyHint="done"
        />
      </div>
      {parsed && (
        <p className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground" aria-live="polite" data-slot="quick-add-preview">
          <Icon name={parsed.dated ? "calendar" : "time"} size={14} />
          <span className="truncate">
            <strong className="font-medium text-foreground">{parsed.title}</strong>
            {" · "}
            {parsed.allDay ? fmt.dayLong(parsed.start) : `${fmt.dayLong(parsed.start)}, ${fmt.time(secs(parsed.start))}`}
            {parsed.location && ` · ${parsed.location}`}
            {!parsed.dated && " (add a time, like “fri 3pm”)"}
          </span>
        </p>
      )}
    </form>
  )
}

/** Calendars and contacts that did not sync, by account. They stay at the top of the calendar until the status lane's banner takes them. */
function SyncProblems() {
  const { data: accounts = [] } = useAccounts()
  const failing = accounts.filter((a) => a.davError)
  if (failing.length === 0) return null
  return (
    <div className="flex flex-col gap-2 pb-3" data-slot="calendar-sync-problems">
      {failing.map((a) => (
        <p key={a.id} role="status" className="flex gap-2 rounded-lg bg-destructive/10 p-2 text-xs text-destructive">
          <Icon name="warning--alt" size="sm" />
          <span>
            {a.displayName}: calendars didn't sync. {a.davError}
          </span>
        </p>
      ))}
    </div>
  )
}

export function CalendarView() {
  // The frame's width class decides (ADR-0083): the phone's shells get the agenda and a full-screen event;
  // from medium up the week, and an event beside the grid once list and detail have the room (expanded).
  const frame = useAppFrame()
  const tabletUp = !frame.phone
  const beside = frame.split
  // The range is this device's choice (view-prefs.ts): the agenda on a phone and the week from medium up, until changed.
  const view = useCalendarViewPrefs().range
  const setView = setCalendarRange
  // Calendar's place (ADR-0084): the calendar itself, or one of its two tools, which take the list column.
  const place = useUi((s) => s.calendarPlace)
  const setPlace = useUi((s) => s.setCalendarPlace)
  // Opened from a note's link: show that event, on its day.
  const [jumped] = useState(() => pendingJump("event"))
  useEffect(() => void useUi.getState().takeJump("event"), [])
  const [focus, setFocus] = useState(() => startOfDay(jumped?.start ? new Date(jumped.start * 1000) : new Date()))
  const [month, setMonth] = useState(focus)
  const [agendaDays, setAgendaDays] = useState(30)
  const [selected, setSelected] = useState<Selected | null>(jumped?.start != null ? { eventId: jumped.id, start: jumped.start } : null)
  const openEditor = useUi((s) => s.openEventEditor)
  const calendars = useCalendars()

  const days = view === "week" ? Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(focus), i)) : view === "day" ? [focus] : []
  const monthStart = startOfWeek(new Date(focus.getFullYear(), focus.getMonth(), 1))
  const [from, to] =
    view === "agenda" ? [focus, addDays(focus, agendaDays)] : view === "month" ? [monthStart, addDays(monthStart, 42)] : [days[0]!, addDays(days.at(-1)!, 1)]
  const { data: occurrences = [], refetch } = useOccurrences(secs(from), secs(to))

  // Busy dots for the mini month (six visible weeks).
  const gridStart = startOfWeek(new Date(month.getFullYear(), month.getMonth(), 1))
  const { data: monthOcc = [] } = useOccurrences(secs(gridStart), secs(addDays(gridStart, 42)))
  const busy = (d: Date) => monthOcc.some((o) => o.start < secs(d) + DAY && o.end > secs(d))

  const step = (n: number) => {
    const next = view === "week" ? addDays(focus, 7 * n) : view === "day" ? addDays(focus, n) : view === "month" ? addMonths(focus, n) : addDays(focus, agendaDays * n)
    setFocus(next)
    setMonth(next)
  }
  const goToday = () => {
    const t = startOfDay(new Date())
    setFocus(t)
    setMonth(t)
  }
  const pick = (d: Date) => {
    setFocus(startOfDay(d))
    if (view === "agenda" && tabletUp) setView("day")
  }

  const title =
    view === "month"
      ? fmt.monthYear(focus)
      : view === "day"
      ? fmt.dayLong(focus)
      : view === "week"
        ? days[0]!.getMonth() === days[6]!.getMonth()
          ? fmt.monthYear(days[0]!)
          : `${days[0]!.toLocaleDateString(undefined, { month: "short" })} – ${days[6]!.toLocaleDateString(undefined, { month: "short", year: "numeric" })}`
        : fmt.monthYear(focus)

  // Keyboard (ADR-0032): your keys for today, views, and paging. Never while typing.
  const { data: keys } = useKeyBindings()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.metaKey || e.ctrlKey || e.altKey || t.closest("input, textarea, select, [contenteditable=true], [role=dialog]")) return
      // Settings covers the calendar (ADR-0075); its keys wait.
      if (useUi.getState().settings) return
      const run: Record<string, () => void> = {
        "calendar.today": goToday,
        "calendar.day": () => setView("day"),
        "calendar.week": () => setView("week"),
        "calendar.agenda": () => setView("agenda"),
        "calendar.month": () => setView("month"),
        "calendar.previous": () => step(-1),
        "calendar.next": () => step(1),
      }
      const command = commandFor(keys, "calendar", e.key)
      if (command) run[command]?.()
      else if (e.key === "?") useUi.getState().setShortcutsOpen(true)
      else return
      e.preventDefault()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  // A birthday is the contact's: open the card, not an event view.
  const select = (o: Occurrence) => (o.contactId ? useUi.getState().jumpTo({ kind: "contact", id: o.contactId }) : setSelected({ eventId: o.eventId, start: o.start }))
  const createAt = (at: Date) => {
    const end = new Date(at.getTime() + 3_600_000)
    openEditor({ initial: { start: `${dateInput(at)}T${timeInput(at)}`, end: `${dateInput(end)}T${timeInput(end)}` } })
  }
  const selectedKey = selected ? occurrenceKey(selected) : null
  const openEvent = (eventId: string, start: number) => {
    setFocus(startOfDay(fromSecs(start)))
    setSelected({ eventId, start })
  }

  // What the shell says about this screen (ADR-0083): the view as the place, its range as the fact.
  const VIEW_NAME: Record<View, string> = { agenda: "Agenda", day: "Day", week: "Week", month: "Month" }
  const tool = place === "tasks" ? "Tasks" : place === "booking" ? "Booking links" : null
  useScreenPlace(tool ?? VIEW_NAME[view])
  useScreenFact(
    view === "day"
      ? fmt.dayLong(focus)
      : view === "month"
        ? fmt.monthYear(focus)
        : `${from.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${addDays(to, -1).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`,
  )
  useRefresh(refetch)
  // A second tap on Calendar's tab, or its breadcrumb: back to the calendar itself, with nothing open.
  useScreenRoot(() => {
    setPlace("calendar")
    setSelected(null)
  })
  // Where the event is a full screen over the calendar (compact and medium), Back closes it.
  usePushedScreen(selected !== null && !beside, () => setSelected(null))
  // The page head opens the calendars wherever the sidebar does not list them (brief X1).
  const switching = useSectionSwitcher("Change calendars.")
  // The list column stands beside the grid from the old tablet width up, as it did; under it an open tool takes the screen.
  const sideColumn = useViewport().width >= 768
  const panel = place === "tasks" ? <TasksPanel onOpen={openEvent} /> : place === "booking" ? <BookingLinks /> : null
  const toolScreen = !!panel && !sideColumn

  const detail = selected && (
    <EventDetailPane key={selectedKey} eventId={selected.eventId} start={selected.start} calendars={calendars} onDeleted={() => setSelected(null)} />
  )

  return (
    <AppFrameColumn aria-label="Calendar">
     {/* The calendar keeps its own panes and scrolls inside them, so it fills the column exactly. */}
     <div className="flex h-full min-h-0 flex-col">
     <DemoBar in="column" />
     <div className="flex min-h-0 flex-1">
      {/* The list column: quick add and the month, until the calendar lane replaces them; then the open tool. */}
      {sideColumn && (
        <aside className="flex w-(--c-shell-list-width) shrink-0 flex-col overflow-y-auto border-r bg-surface-ground" aria-label={tool ?? "Go to a date"}>
          <QuickAdd calendars={calendars} />
          <MiniMonth month={month} onMonth={setMonth} selected={focus} onPick={pick} busy={busy} />
          {panel && <div className="px-4 pb-4">{panel}</div>}
        </aside>
      )}

      <section className={cn("flex min-w-0 flex-1 flex-col", tabletUp && "pl-6")}>
        <SyncProblems />
        <ScreenHead
          overline="Calendar"
          size="sm"
          gap="sm"
          title={toolScreen ? tool! : title}
          switcher={switching.switcher}
          actions={
            !toolScreen && <>
              <Button variant="outline" size="sm" onClick={goToday} aria-keyshortcuts={ariaKey(keys?.["calendar.today"] ?? "t")}>
                Today
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label={`Previous ${view === "agenda" ? "days" : view}`} onClick={() => step(-1)}>
                <Icon name="chevron--left" />
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label={`Next ${view === "agenda" ? "days" : view}`} onClick={() => step(1)}>
                <Icon name="chevron--right" />
              </Button>
              <ToggleGroup value={[view]} onValueChange={(v) => v[0] && (setView(v[0] as View), setPlace("calendar"))} variant="outline" size="sm" aria-label="View">
                <ToggleGroupItem value="agenda" aria-keyshortcuts={ariaKey(keys?.["calendar.agenda"] ?? "a")}>Agenda</ToggleGroupItem>
                <ToggleGroupItem value="day" aria-keyshortcuts={ariaKey(keys?.["calendar.day"] ?? "d")}>Day</ToggleGroupItem>
                <ToggleGroupItem value="week" aria-keyshortcuts={ariaKey(keys?.["calendar.week"] ?? "w")}>Week</ToggleGroupItem>
                <ToggleGroupItem value="month" aria-keyshortcuts={ariaKey(keys?.["calendar.month"] ?? "m")}>Month</ToggleGroupItem>
              </ToggleGroup>
            </>
          }
        />
        {/* Under the head, where its popover stands. It takes no room of its own. */}
        <div className="relative">
          <SectionSwitcher state={switching} overline={`Calendar // ${tool ?? VIEW_NAME[view]}`} title="Calendars">
            <CalendarNav standalone />
          </SectionSwitcher>
        </div>
        {!sideColumn && !toolScreen && <QuickAdd calendars={calendars} />}

        {/* Where the list column is not beside the grid, an open tool takes the screen. */}
        {toolScreen && <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">{panel}</div>}
        <div className={cn("min-h-0 flex-1 flex-col", toolScreen ? "hidden" : "flex")}>
        {view === "month" ? (
          <MonthGrid
            month={focus}
            occurrences={occurrences}
            calendars={calendars}
            selected={selectedKey}
            onSelect={select}
            onDay={(d) => {
              setFocus(startOfDay(d))
              setView("day")
            }}
          />
        ) : view === "agenda" ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <Agenda from={focus} days={agendaDays} occurrences={occurrences} calendars={calendars} selected={selectedKey} onSelect={select} onMore={() => setAgendaDays((d) => d + 30)} />
          </div>
        ) : (
          <TimeGrid days={days} occurrences={occurrences} calendars={calendars} selected={selectedKey} onSelect={select} onCreateAt={tabletUp ? createAt : undefined} />
        )}
        </div>
      </section>

      {/* Detail: a side panel beside the grid where there is room, a full screen otherwise. */}
      {beside ? (
        selected && (
          <aside className="flex w-96 shrink-0 flex-col border-l bg-background" aria-label="Event">
            <div className="flex h-12 shrink-0 items-center justify-end px-2">
              <Button variant="ghost" size="icon" aria-label="Close" onClick={() => setSelected(null)}>
                <Icon name="close" />
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">{detail}</div>
          </aside>
        )
      ) : (
        <Sheet open={selected !== null} onOpenChange={(o) => !o && setSelected(null)}>
          <SheetContent side="bottom" fullscreen showCloseButton={false}>
            <SheetTitle className="sr-only">Event</SheetTitle>
            <div className="flex h-14 shrink-0 items-center px-2">
              <Button variant="ghost" size="icon" onClick={() => setSelected(null)} aria-label="Back">
                <Icon name="arrow--left" className="size-5" />
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">{detail}</div>
          </SheetContent>
        </Sheet>
      )}

      {/* What the calendars list opens (brief X1): the holidays picker by its intent, and the form that names a set. */}
      <AddCalendarsDialog />
      <SaveSetDialog />
     </div>
     </div>
    </AppFrameColumn>
  )
}
