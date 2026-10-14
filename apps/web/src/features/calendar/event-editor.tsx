import { useState } from "react"
import { toast } from "sonner"

import { useUi, type EventEditorState } from "@/app/ui-store"
import { EditorFrame, EditorHeader } from "@/components/editor-frame"
import { Icon } from "@/components/icon"
import { Button } from "@/components/ui/button"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Switch } from "@/components/ui/switch"
import { useAccounts, useCollections, usePimAction } from "@/core/queries"
import type { EventInput, Repeat } from "@/core/types"

import { formatRecipients, parseRecipients } from "../mail/format"
import { RecipientInput } from "../mail/recipient-input"
import { addDays, dateInput, deviceTimeZone, fromInputs, timeInput } from "./dates"
import { REMINDER_PRESETS, reminderLabel } from "./reminders"

const REPEAT_LABELS: [Repeat, string][] = [
  ["none", "Does not repeat"],
  ["daily", "Every day"],
  ["weekly", "Every week"],
  ["monthly", "Every month"],
  ["yearly", "Every year"],
]

/** Mounted once at the app root; opens whenever `useUi().eventEditor` is set. */
export function EventEditor() {
  const state = useUi((s) => s.eventEditor)
  const close = useUi((s) => s.closeEventEditor)
  return (
    <EditorFrame open={state !== null} onClose={close} title={state?.eventId ? "Edit event" : "New event"}>
      {state && <EventForm key={JSON.stringify(state)} state={state} onDone={close} />}
    </EditorFrame>
  )
}

/** Splits "2026-10-14T09:30" (or a date) into the form's date and time fields. */
function split(s: string | undefined, fallback: Date) {
  if (!s) return { date: dateInput(fallback), time: timeInput(fallback) }
  const [date, time] = s.split("T")
  return { date: date!, time: time?.slice(0, 5) ?? timeInput(fallback) }
}

function nextHalfHour() {
  const d = new Date()
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0)
  return d
}

const label = "w-20 shrink-0 text-sm text-muted-foreground"
const row = "flex min-h-12 items-center gap-3 border-b px-4"
const bare = "h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
const picker = "h-9 rounded-lg border bg-transparent px-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"

function EventForm({ state, onDone }: { state: EventEditorState; onDone: () => void }) {
  const { initial, eventId, guestOf } = state
  const scope = state.scope ?? "all"
  const single = eventId !== undefined && scope === "this"
  const { data: calendars = [] } = useCollections("calendar")
  const { data: accounts = [] } = useAccounts()
  const writable = calendars.filter((c) => c.writable)
  const save = usePimAction((c, input: EventInput) => (eventId ? c.updateEvent(eventId, input, scope, state.occurrence ?? null) : c.createEvent(input)))
  const [reminders, setReminders] = useState<number[]>(initial.reminders ?? [])
  const [guests, setGuests] = useState(formatRecipients(initial.attendees ?? []))

  const startDefault = nextHalfHour()
  const s = split(initial.start, startDefault)
  const e = split(initial.end, new Date(startDefault.getTime() + 3_600_000))
  const [title, setTitle] = useState(initial.title ?? "")
  const [location, setLocation] = useState(initial.location ?? "")
  const [notes, setNotes] = useState(initial.notes ?? "")
  const [allDay, setAllDay] = useState(initial.allDay ?? false)
  const [startDate, setStartDate] = useState(s.date)
  const [startTime, setStartTime] = useState(s.time)
  // All-day ends are exclusive in iCalendar; people think in the last day.
  const [endDate, setEndDate] = useState(initial.allDay && initial.end ? dateInput(addDays(fromInputs(e.date), -1)) : e.date)
  const [endTime, setEndTime] = useState(e.time)
  const [repeat, setRepeat] = useState<Repeat>(initial.repeat ?? "none")
  const [chosen, setCalendarId] = useState(initial.calendarId ?? "")
  const calendarId = chosen || writable[0]?.id || ""
  const [error, setError] = useState<string | null>(null)

  // Moving the start keeps the duration, like every calendar app.
  const moveStart = (date: string, time: string) => {
    const before = fromInputs(startDate, startTime)
    const after = fromInputs(date, time)
    const end = new Date(fromInputs(endDate, endTime).getTime() + (after.getTime() - before.getTime()))
    setStartDate(date)
    setStartTime(time)
    setEndDate(dateInput(end))
    setEndTime(timeInput(end))
  }

  const submit = async () => {
    setError(null)
    if (!title.trim()) return setError("Give the event a title.")
    if (!calendarId) return setError("There's no calendar you can write to.")
    const input: EventInput = {
      calendarId,
      title: title.trim(),
      location: location.trim() || null,
      notes: notes.trim() || null,
      allDay,
      start: allDay ? startDate : `${startDate}T${startTime}`,
      end: allDay ? dateInput(addDays(fromInputs(endDate), 1)) : `${endDate}T${endTime}`,
      timeZone: deviceTimeZone(),
      // One occurrence doesn't repeat; the series keeps its rule.
      repeat: single ? "none" : repeat,
      reminders,
      // Guests belong to the organizer; one-occurrence edits keep the series' list.
      attendees: guestOf || single ? undefined : parseRecipients(guests),
    }
    try {
      await save.mutateAsync(input)
      toast.success(eventId ? "Event updated" : "Event added", { duration: 2000 })
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const accountName = (id: string | null) => (id ? accounts.find((a) => a.id === id)?.displayName ?? "Account" : "On this device")
  const groups = [...new Set(writable.map((c) => c.accountId))]

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(ev) => (ev.preventDefault(), void submit())}
      onKeyDown={(ev) => {
        if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
          ev.preventDefault()
          void submit()
        }
      }}
    >
      <EditorHeader
        title={eventId ? "Edit event" : "New event"}
        onCancel={onDone}
        action={
          <Button type="submit" disabled={save.isPending}>
            {eventId ? "Save" : "Add"}
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="border-b px-4 py-2">
          <input aria-label="Title" placeholder="Title" className="h-11 w-full bg-transparent text-lg font-medium outline-none placeholder:text-muted-foreground" value={title} onChange={(ev) => setTitle(ev.target.value)} data-editor-focus="" />
          <input aria-label="Location" placeholder="Location" className={`${bare} w-full`} value={location} onChange={(ev) => setLocation(ev.target.value)} />
        </div>
        {eventId && initial.repeat && initial.repeat !== "none" && (
          <p className="flex items-center gap-2 border-b bg-muted/50 px-4 py-2 text-xs text-muted-foreground" data-slot="scope-note">
            <Icon name="repeat" className="size-4" />
            {scope === "this" ? "Changes apply to this event only." : scope === "following" ? "Changes apply to this and following events." : "Changes apply to every event in this series."}
          </p>
        )}
        {guestOf && (
          <p className="flex items-center gap-2 border-b bg-muted/50 px-4 py-2 text-xs text-muted-foreground">
            <Icon name="info" className="size-4" /> {guestOf} organizes this event. Your changes stay on your calendar.
          </p>
        )}
        <label className={row}>
          <span className={label}>All-day</span>
          <Switch checked={allDay} onCheckedChange={setAllDay} aria-label="All-day" className="ml-auto" />
        </label>
        <div className={row}>
          <span className={label}>Starts</span>
          <div className="ml-auto flex flex-wrap justify-end gap-2 py-1.5">
            <input type="date" aria-label="Start date" className={picker} value={startDate} onChange={(ev) => ev.target.value && moveStart(ev.target.value, startTime)} />
            {!allDay && <input type="time" aria-label="Start time" className={picker} value={startTime} onChange={(ev) => ev.target.value && moveStart(startDate, ev.target.value)} />}
          </div>
        </div>
        <div className={row}>
          <span className={label}>Ends</span>
          <div className="ml-auto flex flex-wrap justify-end gap-2 py-1.5">
            <input type="date" aria-label="End date" className={picker} value={endDate} min={startDate} onChange={(ev) => setEndDate(ev.target.value)} />
            {!allDay && <input type="time" aria-label="End time" className={picker} value={endTime} onChange={(ev) => setEndTime(ev.target.value)} />}
          </div>
        </div>
        <div className={single ? "hidden" : row}>
          <label htmlFor="event-repeat" className={label}>
            Repeat
          </label>
          <NativeSelect id="event-repeat" value={repeat} onChange={(ev) => setRepeat(ev.target.value as Repeat)} className="ml-auto">
            {REPEAT_LABELS.map(([v, l]) => (
              <NativeSelectOption key={v} value={v}>
                {l}
              </NativeSelectOption>
            ))}
            {initial.repeat === "custom" && <NativeSelectOption value="custom">Custom (kept as is)</NativeSelectOption>}
          </NativeSelect>
        </div>
        <div className={row}>
          <label htmlFor="event-calendar" className={label}>
            Calendar
          </label>
          <NativeSelect id="event-calendar" value={calendarId} onChange={(ev) => setCalendarId(ev.target.value)} className="ml-auto max-w-[60%]" disabled={single}>
            {groups.map((g) => (
              <optgroup key={g ?? "local"} label={accountName(g)}>
                {writable
                  .filter((c) => c.accountId === g)
                  .map((c) => (
                    <NativeSelectOption key={c.id} value={c.id}>
                      {c.name}
                    </NativeSelectOption>
                  ))}
              </optgroup>
            ))}
          </NativeSelect>
        </div>
        <div className="flex min-h-12 flex-wrap items-center gap-2 border-b px-4 py-2" role="group" aria-label="Reminders">
          <span className={label}>Remind me</span>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
            {reminders.map((m) => (
              <span key={m} className="flex items-center gap-1 rounded-full bg-muted py-0.5 pr-1 pl-2.5 text-xs">
                {reminderLabel(m, allDay)}
                <button type="button" aria-label={`Remove reminder ${reminderLabel(m, allDay)}`} className="flex size-5 items-center justify-center rounded-full hover:bg-background" onClick={() => setReminders(reminders.filter((x) => x !== m))}>
                  <Icon name="close" className="size-3.5" />
                </button>
              </span>
            ))}
            <NativeSelect
              size="sm"
              aria-label="Add reminder"
              value=""
              onChange={(ev) => ev.target.value !== "" && setReminders([...reminders, Number(ev.target.value)].sort((a, b) => a - b))}
            >
              <NativeSelectOption value="">{reminders.length ? "Add another" : "None"}</NativeSelectOption>
              {REMINDER_PRESETS.filter((m) => !reminders.includes(m)).map((m) => (
                <NativeSelectOption key={m} value={m}>
                  {reminderLabel(m, allDay)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        </div>
        {!guestOf && !single && (
          <div className={row}>
            <label htmlFor="event-guests" className={label}>
              Guests
            </label>
            <RecipientInput id="event-guests" className={bare} value={guests} onChange={setGuests} placeholder="Add people by name or email" inputMode="email" />
          </div>
        )}
        {!guestOf && !single && parseRecipients(guests).length > 0 && (
          <p className="border-b px-4 py-2 text-xs text-muted-foreground" data-slot="invite-note">
            {calendars.find((c) => c.id === calendarId)?.accountId
              ? calendars.find((c) => c.id === calendarId)?.scheduling
                ? "Your calendar server will send the invitations."
                : "Invitations go out from your mail account when you save."
              : "Invitations need a calendar on a mail account."}
          </p>
        )}
        <textarea aria-label="Notes" placeholder="Notes" className="min-h-32 w-full resize-none bg-transparent px-4 py-3 text-sm outline-none placeholder:text-muted-foreground" value={notes} onChange={(ev) => setNotes(ev.target.value)} />
      </div>
      {error && (
        <p role="alert" className="flex items-center gap-2 border-t bg-destructive/10 px-4 py-2 text-sm text-destructive">
          <Icon name="error" className="size-4" /> {error}
        </p>
      )}
    </form>
  )
}
