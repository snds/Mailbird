import { useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"

import { useUi } from "@/app/ui-store"
import { Icon, Button, Checkbox, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, NativeSelect, NativeSelectOption, DialogAction, DialogActions } from "@unicron/ui"
import { getCoreClient } from "@/core/client"
import { useCollections, useNoteTasks, useNotesPrefs } from "@/core/queries"
import type { NoteTask, TimeSlot } from "@/core/types"

import { setTaskDone } from "../notes/checklists"
import { dateInput, dayLabel, deviceTimeZone, fmt, fromSecs, timeInput } from "./dates"

const SHOWN = 5
const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e))
const when = (s: number) => `${dayLabel(fromSecs(s))}, ${fmt.time(s)}`

/**
 * Tasks (ADR-0028): the open checklist items from your notes, beside the
 * calendar, so an intention becomes a block of time. A task stays in its
 * note; checking it here checks it there.
 */
export function TasksPanel({ onOpen }: { onOpen: (eventId: string, start: number) => void }) {
  const { data: tasks = [] } = useNoteTasks()
  const { data: prefs } = useNotesPrefs()
  const [all, setAll] = useState(false)
  const [planning, setPlanning] = useState<NoteTask | null>(null)
  const qc = useQueryClient()
  const shown = all ? tasks : tasks.slice(0, SHOWN)

  const check = async (t: NoteTask, done: boolean) => {
    try {
      const core = await getCoreClient()
      await setTaskDone(core, t, done, prefs?.sortChecked ?? true)
      await qc.invalidateQueries({ queryKey: ["notes"], predicate: (q) => q.queryKey[1] !== "note" })
      if (done) toast.success(`Done: ${t.text}`, { duration: 4000, action: { label: "Undo", onClick: () => void check(t, false) } })
    } catch (e) {
      fail(e)
    }
  }

  return (
    <section aria-label="Tasks" className="flex flex-col gap-1">
      <h3 className="flex items-baseline justify-between pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Tasks {tasks.length > 0 && <span className="font-normal tabular-nums normal-case">{tasks.length} open</span>}
      </h3>
      {tasks.length === 0 && <p className="text-xs text-muted-foreground">Checklist items in your notes show up here, ready to plan.</p>}
      {shown.map((t) => (
        <div key={`${t.noteId}:${t.index}`} className="flex items-start gap-2 rounded-lg px-1 py-1 text-sm hover:bg-accent/50">
          <Checkbox className="mt-0.5" checked={false} onCheckedChange={(on) => on && void check(t, true)} aria-label={`Done: ${t.text}`} />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate">{t.text}</span>
            {t.planned ? (
              <span className="text-xs">
                {/* In the calendar's hue: it's on the calendar now. */}
                <Button variant="link" size="inline" className="text-vertical-calendar" onClick={() => onOpen(t.planned!.eventId, t.planned!.start)}>
                  <Icon name="event_available" /> {when(t.planned.start)}
                </Button>
              </span>
            ) : (
              <span className="truncate text-xs">
                <Button variant="link" size="inline" className="text-muted-foreground" onClick={() => useUi.getState().jumpTo({ kind: "note", id: t.noteId })}>
                  {t.noteTitle || "Untitled note"}
                </Button>
              </span>
            )}
          </div>
          <Button size="icon-sm" variant="ghost" aria-label={`${t.planned ? "Plan again" : "Plan"}: ${t.text}`} onClick={() => setPlanning(t)}>
            <Icon name="more_time" />
          </Button>
        </div>
      ))}
      {tasks.length > SHOWN && (
        <Button variant="ghost-muted" size="sm" className="justify-start px-1" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${tasks.length}`}
        </Button>
      )}
      <Dialog open={planning !== null} onOpenChange={(o) => !o && setPlanning(null)}>
        <DialogContent size="md">{planning && <PlanForm key={`${planning.noteId}:${planning.index}`} task={planning} onDone={() => setPlanning(null)} onOpen={onOpen} />}</DialogContent>
      </Dialog>
    </section>
  )
}

const LENGTHS = [15, 30, 45, 60, 90, 120]

/** Puts a task on the calendar: a time block titled with its words, linked from its note. */
function PlanForm({ task, onDone, onOpen }: { task: NoteTask; onDone: () => void; onOpen: (eventId: string, start: number) => void }) {
  const { data: calendars = [] } = useCollections("calendar")
  const writable = calendars.filter((c) => c.writable && !c.id.startsWith("interesting:"))
  const [calendarId, setCalendarId] = useState(() => (writable.find((c) => !c.hidden) ?? writable[0])?.id ?? "")
  const [minutes, setMinutes] = useState(30)
  // The next half hour, as a starting point.
  const [soon] = useState(() => new Date(Math.ceil(Date.now() / 1_800_000) * 1_800_000))
  const [day, setDay] = useState(() => dateInput(soon))
  const [time, setTime] = useState(() => timeInput(soon))
  const [free, setFree] = useState<TimeSlot[] | null>(null)
  const [busy, setBusy] = useState(false)
  const qc = useQueryClient()

  const findFree = async (m = minutes) => {
    try {
      const slots = await (await getCoreClient()).findTimes({ from: Math.floor(Date.now() / 1000), minutes: m, dayStart: 8 * 60, dayEnd: 20 * 60, weekdaysOnly: false, limit: 3 })
      setFree(slots)
    } catch (e) {
      fail(e)
    }
  }
  const pickSlot = (s: TimeSlot) => {
    setDay(dateInput(fromSecs(s.start)))
    setTime(timeInput(fromSecs(s.start)))
  }

  const submit = async () => {
    const start = new Date(`${day}T${time}`)
    if (Number.isNaN(start.getTime())) return toast.error("Pick a day and a time")
    const end = new Date(start.getTime() + minutes * 60_000)
    setBusy(true)
    try {
      const core = await getCoreClient()
      const e = await core.createEvent({
        calendarId: calendarId || writable[0]?.id || "",
        title: task.text,
        notes: `From your note “${task.noteTitle || "Untitled"}”.`,
        start: `${dateInput(start)}T${timeInput(start)}`,
        end: `${dateInput(end)}T${timeInput(end)}`,
        allDay: false,
        timeZone: deviceTimeZone(),
        repeat: "none",
      })
      // The note links to its block, which is what makes the task "planned".
      const link = await core.noteLinkFor({ kind: "event", id: e.eventId })
      if (link) {
        const note = await core.getNote(task.noteId)
        await core.setNoteMeta(task.noteId, { links: [...note.links, link] })
      }
      await qc.invalidateQueries({ queryKey: ["notes"], predicate: (q) => q.queryKey[1] !== "note" })
      await qc.invalidateQueries({ queryKey: ["pim"] })
      toast.success(`Planned “${task.text}”`, { description: when(e.start), duration: 4000, action: { label: "Show", onClick: () => onOpen(e.eventId, e.start) } })
      onDone()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const field = "h-9 w-full rounded-lg border bg-transparent px-2.5 text-sm dark:bg-input/30"
  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => (e.preventDefault(), void submit())}>
      <DialogHeader>
        <DialogTitle>Plan “{task.text}”</DialogTitle>
        <DialogDescription>Block time for it on your calendar. The task stays in “{task.noteTitle || "Untitled"}”, linked to its block.</DialogDescription>
      </DialogHeader>
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Day
          <input className={field} type="date" value={day} onChange={(e) => setDay(e.target.value)} required />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Start
          <input className={field} type="time" step={900} value={time} onChange={(e) => setTime(e.target.value)} required />
        </label>
      </div>
      <div className="flex flex-col gap-2">
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => void findFree()}>
          <Icon name="search" data-icon="inline-start" /> Find a free time
        </Button>
        {free && (free.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nothing free soon between 8 AM and 8 PM.</p>
        ) : (
          <div role="group" aria-label="Free times" className="flex flex-wrap gap-2">
            {free.map((s) => (
              <Button key={s.start} type="button" size="sm" variant={dateInput(fromSecs(s.start)) === day && timeInput(fromSecs(s.start)) === time ? "default" : "secondary"} onClick={() => pickSlot(s)}>
                {when(s.start)}
              </Button>
            ))}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Length
          <NativeSelect
            value={String(minutes)}
            onChange={(e) => {
              const m = Number(e.target.value)
              setMinutes(m)
              if (free) void findFree(m)
            }}
            className="w-full"
          >
            {LENGTHS.map((m) => (
              <NativeSelectOption key={m} value={String(m)}>
                {m < 60 ? `${m} minutes` : m === 60 ? "1 hour" : `${m / 60} hours`}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Calendar
          <NativeSelect value={calendarId} onChange={(e) => setCalendarId(e.target.value)} className="w-full">
            {writable.map((c) => (
              <NativeSelectOption key={c.id} value={c.id}>
                {c.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
      </div>
      <DialogActions>
        <DialogAction kind="cancel" type="button" onClick={onDone}>
          Cancel
        </DialogAction>
        <DialogAction type="submit" disabled={busy || !writable.length}>
          Plan it
        </DialogAction>
      </DialogActions>
    </form>
  )
}
