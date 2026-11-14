import { useState } from "react"

import { useUi, type EventEditorState } from "@/app/ui-store"
import { DatePicker } from "@/components/date-picker"
import { FormLayer, FormLayerForm } from "@/components/editor-frame"
import { ZonePicker } from "@/components/zone-picker"
import { Icon, Button, NativeSelect, NativeSelectOption, Switch, Chip, ChipRemove, toast } from "@unicron/ui"
import { useAccounts, useCollections, usePimAction } from "@/core/queries"
import type { EventInput, Repeat } from "@/core/types"
import { useLeaveGuard } from "@/lib/leave-guard"
import { meetingInfo, meetingLink } from "@/lib/meeting-info"

import { formatRecipients, parseRecipients } from "../mail/format"
import { RecipientInput } from "../mail/recipient-input"
import { addDays, dateInput, deviceTimeZone, fromInputs, timeInput } from "./dates"
import { FindATime } from "./find-a-time"
import { REMINDER_PRESETS, reminderLabel, travelLabel } from "./reminders"
import { meetingService } from "./meeting"
import { deviceZone, zoneCity, zoneLabel, zonedDate, zonedInput } from "./zones"

/** A fresh Jitsi room: unguessable, readable in a link. */
function jitsiRoom() {
  const bytes = crypto.getRandomValues(new Uint8Array(9))
  const id = Array.from(bytes, (b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("")
  return `https://meet.jit.si/Vale-${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}`
}

/** Minutes; how long getting there takes, blocked out before the start. */
const TRAVEL_PRESETS = [5, 10, 15, 20, 30, 45, 60, 90, 120]

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
    <FormLayer open={state !== null} onClose={close}>
      {state && <EventForm key={JSON.stringify(state)} state={state} onDone={close} />}
    </FormLayer>
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
const row = "flex min-h-12 items-center gap-3 border-b"
const bare = "h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
// The platform's time input, as tall as the date button beside it.
const picker = "h-10 rounded-lg border bg-transparent px-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"

/** A date field (brief C3): a button that shows "Fri 11.20", is named "Start date, Friday, November 20, 2026", and opens the month grid. */
function EventDay({ name, value, onPick, min }: { name: string; value: string; onPick: (date: string) => void; min?: string }) {
  const d = fromInputs(value)
  const two = (n: number) => String(n).padStart(2, "0")
  return (
    <DatePicker
      title={name}
      value={value}
      onPick={onPick}
      min={min}
      align="end"
      trigger={
        <Button type="button" variant="outline" aria-label={`${name}, ${d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}`}>
          {`${d.toLocaleDateString(undefined, { weekday: "short" })} ${two(d.getMonth() + 1)}.${two(d.getDate())}`}
        </Button>
      }
    />
  )
}

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
  const [zone, setZone] = useState(initial.timeZone ?? deviceTimeZone())
  const [travel, setTravel] = useState(initial.travel ?? 0)
  const [chosen, setCalendarId] = useState(initial.calendarId ?? "")
  const calendarId = chosen || writable[0]?.id || ""
  const [error, setError] = useState<string | null>(null)
  // Closing asks first once a value differs from when the form opened (ADR-0087).
  const values = JSON.stringify([title, location, notes, allDay, startDate, startTime, endDate, endTime, repeat, zone, travel, chosen, reminders, guests])
  const [opened] = useState(values)
  useLeaveGuard(values !== opened)
  // A call link pasted into the location or notes (an invitation's text, say).
  const found = meetingLink(location, notes)
  const foundId = found ? meetingInfo(location, notes)?.meetingId : null

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
      timeZone: allDay ? deviceTimeZone() : zone,
      travel: allDay ? 0 : travel,
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
    <FormLayerForm
      overline={eventId ? "Edit event" : "New event"}
      title={title.trim() || (eventId ? "Edit event" : "New event")}
      primary={{ label: eventId ? "Save" : "Add", loading: save.isPending }}
      error={error}
      onSubmit={() => void submit()}
    >
      <div>
        <div className="border-b py-2">
          <input aria-label="Title" placeholder="Title" className="h-11 w-full bg-transparent text-lg font-medium outline-none placeholder:text-muted-foreground" value={title} onChange={(ev) => setTitle(ev.target.value)} data-form-focus="" />
          <div className="flex items-center gap-2">
            <input aria-label="Location" placeholder="Location" className={`${bare} w-full`} value={location} onChange={(ev) => setLocation(ev.target.value)} />
            {!found && (
              // A Jitsi room needs no account and no sign-up: anyone with the link joins (ADR-0030).
              <Button type="button" variant="ghost-muted" size="sm" onClick={() => setLocation(location.trim() ? `${location.trim()} · ${jitsiRoom()}` : jitsiRoom())}>
                <Icon name="video--add" data-icon="inline-start" /> Add video call
              </Button>
            )}
          </div>
          {found && (
            <p className="flex items-center gap-1.5 pb-1 text-xs text-muted-foreground" data-slot="meeting-found">
              <Icon name="video" size={14} /> {meetingService(found)} call · Join shows on the event{foundId ? ` · Meeting ID ${foundId}` : ""}
            </p>
          )}
        </div>
        {eventId && initial.repeat && initial.repeat !== "none" && (
          <p className="flex items-center gap-2 border-b bg-muted/50 px-2 py-2 text-xs text-muted-foreground" data-slot="scope-note">
            <Icon name="repeat" size="sm" />
            {scope === "this" ? "Changes apply to this event only." : scope === "following" ? "Changes apply to this and following events." : "Changes apply to every event in this series."}
          </p>
        )}
        {guestOf && (
          <p className="flex items-center gap-2 border-b bg-muted/50 px-2 py-2 text-xs text-muted-foreground">
            <Icon name="information" size="sm" /> {guestOf} organizes this event. Your changes stay on your calendar.
          </p>
        )}
        <label className={row}>
          <span className={label}>All-day</span>
          <Switch checked={allDay} onCheckedChange={setAllDay} aria-label="All-day" className="ml-auto" />
        </label>
        <div className={row}>
          <span className={label}>Starts</span>
          <div className="ml-auto flex flex-wrap justify-end gap-2 py-1.5">
            <EventDay name="Start date" value={startDate} onPick={(date) => moveStart(date, startTime)} />
            {!allDay && <input type="time" aria-label="Start time" className={picker} value={startTime} onChange={(ev) => ev.target.value && moveStart(startDate, ev.target.value)} />}
          </div>
        </div>
        <div className={row}>
          <span className={label}>Ends</span>
          <div className="ml-auto flex flex-wrap justify-end gap-2 py-1.5">
            <EventDay name="End date" value={endDate} min={startDate} onPick={setEndDate} />
            {!allDay && <input type="time" aria-label="End time" className={picker} value={endTime} onChange={(ev) => setEndTime(ev.target.value)} />}
          </div>
        </div>
        {!allDay && !guestOf && (
          <FindATime
            date={startDate}
            minutes={Math.round((fromInputs(endDate, endTime).getTime() - fromInputs(startDate, startTime).getTime()) / 60_000) || 60}
            onPick={(s, e) => {
              // Free times are instants; write them as the event's own zone's clock.
              const [sd, st] = zonedInput(s.getTime() / 1000, zone).split("T")
              const [ed, et] = zonedInput(e.getTime() / 1000, zone).split("T")
              setStartDate(sd!)
              setStartTime(st!)
              setEndDate(ed!)
              setEndTime(et!)
            }}
          />
        )}
        {!allDay && <ZoneRow zone={zone} onZone={setZone} start={[startDate, startTime]} end={[endDate, endTime]} />}
        {!allDay && (
          <div className={row}>
            <label htmlFor="event-travel" className={label}>
              Travel
            </label>
            <NativeSelect id="event-travel" value={String(travel)} onChange={(ev) => setTravel(Number(ev.target.value))} className="ml-auto">
              <NativeSelectOption value="0">None</NativeSelectOption>
              {[...new Set([...TRAVEL_PRESETS, ...(travel ? [travel] : [])])]
                .sort((a, b) => a - b)
                .map((m) => (
                  <NativeSelectOption key={m} value={String(m)}>
                    {travelLabel(m)}
                  </NativeSelectOption>
                ))}
            </NativeSelect>
          </div>
        )}
        {!allDay && travel > 0 && (
          <p className="border-b py-2 text-xs text-muted-foreground" data-slot="travel-note">
            Blocked out before it starts, so nothing gets booked over it. You'll get a “time to leave” alert at {new Date(zonedDate(startDate, startTime, zone).getTime() - travel * 60_000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
            {zone !== deviceZone() ? " your time" : ""}.
          </p>
        )}
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
        <div className="flex min-h-12 flex-wrap items-center gap-2 border-b py-2" role="group" aria-label="Reminders">
          <span className={label}>Remind me</span>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
            {reminders.map((m) => (
              <Chip key={m}>
                {reminderLabel(m, allDay)}
                <ChipRemove label={`Remove reminder ${reminderLabel(m, allDay)}`} onClick={() => setReminders(reminders.filter((x) => x !== m))} />
              </Chip>
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
          <p className="border-b py-2 text-xs text-muted-foreground" data-slot="invite-note">
            {calendars.find((c) => c.id === calendarId)?.accountId
              ? calendars.find((c) => c.id === calendarId)?.scheduling
                ? "Your calendar server will send the invitations."
                : "Invitations go out from your mail account when you save."
              : "Invitations need a calendar on a mail account."}
          </p>
        )}
        <textarea aria-label="Notes" placeholder="Notes" className="min-h-32 w-full resize-none bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground" value={notes} onChange={(ev) => setNotes(ev.target.value)} />
      </div>
    </FormLayerForm>
  )
}

/**
 * The zone the event's times are in. Usually yours; pick another for a
 * flight, a trip, or a call set in someone else's city (ADR-0029). The note
 * says what that is on your clock.
 */
function ZoneRow({ zone, onZone, start, end }: { zone: string; onZone: (z: string) => void; start: [string, string]; end: [string, string] }) {
  const mine = deviceZone()
  const at = zonedDate(start[0], start[1], zone)
  const until = zonedDate(end[0], end[1], zone)
  const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  const sameDay = at.toDateString() === until.toDateString()
  const valid = !Number.isNaN(at.getTime())
  return (
    <>
      <div className={row}>
        <span className={label}>Time zone</span>
        <span className="ml-auto min-w-0 truncate text-sm" data-slot="event-zone">
          {zoneLabel(zone, valid ? at : undefined)}
        </span>
        {/* Every zone, found by typing (brief C3): "Yours" first. */}
        <ZonePicker
          value={zone}
          onPick={(z) => onZone(z ?? mine)}
          at={valid ? at : undefined}
          trigger={
            <Button type="button" variant="ghost" size="sm" aria-label="Change time zone">
              Change
            </Button>
          }
        />
      </div>
      {zone !== mine && valid && (
        <p className="border-b py-2 text-xs text-muted-foreground" data-slot="zone-note">
          {`That's ${at.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}, ${time(at)}–${sameDay ? "" : `${until.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}, `}${time(until)} your time (${zoneCity(mine)}).`}
        </p>
      )}
    </>
  )
}
