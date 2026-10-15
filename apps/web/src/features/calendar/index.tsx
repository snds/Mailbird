import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import { pendingJump, useUi } from "@/app/ui-store"
import { Icon } from "@/components/icon"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useAccounts, useCollections, useOccurrences, usePimAction } from "@/core/queries"
import type { Collection, Occurrence } from "@/core/types"
import { useIsTabletUp } from "@/hooks/use-media-query"

import { Agenda } from "./agenda"
import { CalendarSets } from "./calendar-sets"
import { calendarColor } from "./colors"
import { DAY, addDays, addMonths, dateInput, fmt, fromSecs, secs, startOfDay, startOfWeek, timeInput } from "./dates"
import { EventDetailPane } from "./event-detail"
import { MiniMonth } from "./mini-month"
import { MonthGrid } from "./month-grid"
import { parseQuickAdd, quickToInput } from "./quick-add"
import { BookingLinks } from "./booking-links"
import { InterestingCalendarsButton } from "./interesting"
import { SecondZonePicker } from "./second-zone"
import { occurrenceKey } from "./layout"
import { TimeGrid } from "./time-grid"

type View = "agenda" | "day" | "week" | "month"

interface Selected {
  eventId: string
  start: number
}

function useCalendars() {
  const { data = [] } = useCollections("calendar")
  return useMemo(() => new Map(data.map((c) => [c.id, c])), [data])
}

/** Natural-language add: "Lunch with Ana tomorrow 1pm at Café". */
function QuickAdd({ calendars }: { calendars: Map<string, Collection> }) {
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
        <Icon name="add" className="size-5 text-muted-foreground" />
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
          <Icon name={parsed.dated ? "event" : "schedule"} className="size-3.5" />
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

function CalendarList({ calendars }: { calendars: Map<string, Collection> }) {
  const { data: accounts = [] } = useAccounts()
  const toggle = usePimAction((c, { id, hidden }: { id: string; hidden: boolean }) => c.setCollectionHidden(id, hidden))
  // Added holidays and moon phases get their own group, after the rest.
  const groupOf = (c: Collection) => (c.id.startsWith("interesting:") ? "interesting" : c.accountId)
  const groups = [...new Set([...calendars.values()].map(groupOf))].sort((a, b) => Number(a === "interesting") - Number(b === "interesting"))
  const name = (id: string | null) =>
    id === "interesting" ? "Holidays and more" : id ? accounts.find((a) => a.id === id)?.displayName ?? "Account" : "On this device"
  const failing = accounts.filter((a) => a.davError)
  return (
    <div className="flex flex-col gap-3 px-4 pb-4" data-slot="calendar-list">
      {failing.map((a) => (
        <p key={a.id} role="status" className="flex gap-2 rounded-lg bg-destructive/10 p-2 text-xs text-destructive">
          <Icon name="sync_problem" className="size-4 shrink-0" />
          <span>
            {a.displayName}: calendars didn't sync. {a.davError}
          </span>
        </p>
      ))}
      {groups.map((g) => (
        <section key={g ?? "local"} aria-label={name(g)}>
          <h3 className="pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{name(g)}</h3>
          {[...calendars.values()]
            .filter((c) => groupOf(c) === g)
            .map((c) => (
              <label key={c.id} className="flex h-9 items-center gap-2.5 rounded-lg px-1 text-sm hover:bg-accent/50">
                <Checkbox
                  checked={!c.hidden}
                  onCheckedChange={(on) => toggle.mutate({ id: c.id, hidden: !on })}
                  style={{ "--primary": calendarColor(c), borderColor: calendarColor(c) } as React.CSSProperties}
                  aria-label={`Show ${c.name}`}
                />
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                {!c.writable && <Icon name="lock" className="size-3.5 text-muted-foreground" label="Read-only" />}
              </label>
            ))}
        </section>
      ))}
      <InterestingCalendarsButton />
      <CalendarSets calendars={calendars} />
      <BookingLinks />
      <SecondZonePicker />
    </div>
  )
}

export function CalendarView() {
  const tabletUp = useIsTabletUp()
  const [view, setView] = useState<View>(() => (window.matchMedia("(min-width: 768px)").matches ? "week" : "agenda"))
  // Opened from a note's link: show that event, on its day.
  const [jumped] = useState(() => pendingJump("event"))
  useEffect(() => void useUi.getState().takeJump("event"), [])
  const [focus, setFocus] = useState(() => startOfDay(jumped?.start ? new Date(jumped.start * 1000) : new Date()))
  const [month, setMonth] = useState(focus)
  const [agendaDays, setAgendaDays] = useState(30)
  const [selected, setSelected] = useState<Selected | null>(jumped?.start != null ? { eventId: jumped.id, start: jumped.start } : null)
  const [listOpen, setListOpen] = useState(false)
  const openEditor = useUi((s) => s.openEventEditor)
  const calendars = useCalendars()

  const days = view === "week" ? Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(focus), i)) : view === "day" ? [focus] : []
  const monthStart = startOfWeek(new Date(focus.getFullYear(), focus.getMonth(), 1))
  const [from, to] =
    view === "agenda" ? [focus, addDays(focus, agendaDays)] : view === "month" ? [monthStart, addDays(monthStart, 42)] : [days[0]!, addDays(days.at(-1)!, 1)]
  const { data: occurrences = [] } = useOccurrences(secs(from), secs(to))

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

  // Keyboard: t today, d/w/a views, ←/→ page. Never while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.metaKey || e.ctrlKey || e.altKey || t.closest("input, textarea, select, [contenteditable=true], [role=dialog]")) return
      if (e.key === "t") goToday()
      else if (e.key === "d") setView("day")
      else if (e.key === "w") setView("week")
      else if (e.key === "a") setView("agenda")
      else if (e.key === "m") setView("month")
      else if (e.key === "ArrowLeft") step(-1)
      else if (e.key === "ArrowRight") step(1)
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

  const detail = selected && (
    <EventDetailPane key={selectedKey} eventId={selected.eventId} start={selected.start} calendars={calendars} onDeleted={() => setSelected(null)} />
  )

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="hidden w-(--c-shell-list-width) shrink-0 flex-col overflow-y-auto border-r bg-surface-chrome md:flex" aria-label="Calendars">
        <header className="flex items-center justify-between px-4 pt-4 pb-3">
          <h1 className="text-2xl font-semibold tracking-tight">Calendar</h1>
        </header>
        <QuickAdd calendars={calendars} />
        <MiniMonth month={month} onMonth={setMonth} selected={focus} onPick={pick} busy={busy} />
        <CalendarList calendars={calendars} />
      </aside>

      <section className="flex min-w-0 flex-1 flex-col bg-surface-canvas md:bg-background">
        <header className="flex shrink-0 flex-col gap-2 px-4 pt-4 pb-2 md:border-b md:py-2">
          <div className="flex items-center gap-2 md:hidden">
            <h1 className="min-w-0 flex-1 truncate text-2xl font-semibold tracking-tight" aria-live="polite">
              {view === "agenda" ? "Calendar" : title}
            </h1>
            <Button variant="ghost" size="icon" aria-label="Calendars" onClick={() => setListOpen(true)}>
              <Icon name="stacks" />
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <Button variant="outline" size="sm" onClick={goToday} aria-keyshortcuts="t">
              Today
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label={`Previous ${view === "agenda" ? "days" : view}`} onClick={() => step(-1)}>
              <Icon name="chevron_left" />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label={`Next ${view === "agenda" ? "days" : view}`} onClick={() => step(1)}>
              <Icon name="chevron_right" />
            </Button>
            <h2 className="ml-2 hidden min-w-0 flex-1 truncate text-base font-semibold md:block" aria-live="polite">
              {title}
            </h2>
            <ToggleGroup
              value={[view]}
              onValueChange={(v) => v[0] && setView(v[0] as View)}
              variant="outline"
              size="sm"
              // Phones: its own full-width row, so four views fit without scrolling.
              className="order-last mt-1 w-full *:flex-1 md:order-none md:mt-0 md:ml-auto md:w-auto md:*:flex-none"
              aria-label="View"
            >
              <ToggleGroupItem value="agenda" aria-keyshortcuts="a">Agenda</ToggleGroupItem>
              <ToggleGroupItem value="day" aria-keyshortcuts="d">Day</ToggleGroupItem>
              <ToggleGroupItem value="week" aria-keyshortcuts="w">Week</ToggleGroupItem>
              <ToggleGroupItem value="month" aria-keyshortcuts="m">Month</ToggleGroupItem>
            </ToggleGroup>
          </div>
        </header>
        <div className="md:hidden">
          <QuickAdd calendars={calendars} />
        </div>

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
      </section>

      {/* Detail: a side panel beside the grid from tablet up, a full screen on phones. */}
      {tabletUp ? (
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
          <SheetContent side="bottom" className="gap-0 rounded-none border-0 pt-[env(safe-area-inset-top)] data-[side=bottom]:h-dvh" showCloseButton={false}>
            <SheetTitle className="sr-only">Event</SheetTitle>
            <div className="flex h-14 shrink-0 items-center px-2">
              <Button variant="ghost" size="icon" onClick={() => setSelected(null)} aria-label="Back">
                <Icon name="arrow_back" className="size-5" />
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">{detail}</div>
          </SheetContent>
        </Sheet>
      )}

      <Sheet open={listOpen} onOpenChange={setListOpen}>
        <SheetContent side="bottom" className="max-h-[80dvh] pb-[env(safe-area-inset-bottom)]">
          <SheetTitle className="px-4 pt-4">Calendars</SheetTitle>
          <div className="overflow-y-auto pt-2">
            <CalendarList calendars={calendars} />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}
