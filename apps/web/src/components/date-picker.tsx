import { cloneElement, useRef, useState, type ReactElement, type ReactNode } from "react"

import { AdaptivePopover, Button, TextField, type AdaptivePopoverProps } from "@unicron/ui"
import { dateInput, fromInputs, secs, startOfDay, timeInput } from "@/features/calendar/dates"
import { useNowSecs } from "@/hooks/use-now"

import { MonthGrid } from "./month-grid"

/**
 * The date pickers (ADR-0088; briefs M8, 1.4 and 3.2): a popover under its
 * trigger on a desktop, a sheet on a phone, titled for the job. One part where
 * send later, "remind me if no reply" and the notes reminder each had a small
 * dialog, and where the event form had the browser's date fields.
 */

interface Layer {
  /** The control that opens it. Focus returns to it. */
  trigger: ReactElement<Record<string, unknown>>
  /** The job: "Send later", "Start date". It names the layer. */
  title: string
  overline?: ReactNode
  /** Held by the host when a menu row opens the picker. Left out, the trigger opens it. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  align?: AdaptivePopoverProps["align"]
}

/**
 * A menu's trigger as a picker's trigger, for a picker that a menu row opens
 * ("Pick a time…"): `trigger={<MenuAnchor menu={<DropdownMenuTrigger … />} />}`
 * with `open` held by the host. The picker then stands where the menu did, and
 * focus returns to the one button. The popover's own words about that button
 * (expanded, has a dialog) are dropped, so it keeps saying what the menu's
 * state is, and keeps the menu's open look.
 */
export function MenuAnchor({ menu, ...fromPicker }: { menu: ReactElement<Record<string, unknown>> } & Record<string, unknown>) {
  const { "aria-expanded": _expanded, "aria-haspopup": _has, "aria-controls": _controls, "data-popup-open": _open, "data-pressed": _pressed, ...plumbing } = fromPicker
  return cloneElement(menu, plumbing)
}

/** Open state the host may hold, or leave to the picker. */
function useOpen(open: boolean | undefined, onOpenChange: ((open: boolean) => void) | undefined) {
  const [own, setOwn] = useState(false)
  return [open ?? own, (next: boolean) => (open === undefined ? setOwn(next) : onOpenChange?.(next))] as const
}

/**
 * Picks a day: the month grid, and nothing else. Pressing a day picks it and
 * closes. Dates are the form's own strings ("2026-11-20").
 */
export function DatePicker({ value, onPick, min, ...layer }: Layer & { value: string; onPick: (date: string) => void; min?: string }) {
  const [open, setOpen] = useOpen(layer.open, layer.onOpenChange)
  return (
    <AdaptivePopover open={open} onOpenChange={setOpen} trigger={layer.trigger} title={layer.title} overline={layer.overline} align={layer.align ?? "start"}>
      <DateBody
        value={value}
        min={min}
        onPick={(date) => {
          setOpen(false)
          onPick(date)
        }}
      />
    </AdaptivePopover>
  )
}

// Mounted while the picker is open, so each opening starts on the field's own day.
function DateBody({ value, onPick, min }: { value: string; onPick: (date: string) => void; min?: string }) {
  const picked = fromInputs(value)
  const [month, setMonth] = useState(Number.isNaN(picked.getTime()) ? () => new Date() : picked)
  return <MonthGrid month={month} onMonthChange={setMonth} selected={Number.isNaN(picked.getTime()) ? null : picked} onPick={(d) => onPick(dateInput(d))} min={min ? fromInputs(min) : undefined} />
}

/**
 * Picks a day and a time: the month grid, a TIME field (the platform's time
 * input in the Text Field box) and one primary named for the job. Any day can
 * be picked; a time in the past is the field's error, and the primary then
 * goes to the field.
 * `onPick` gets the core's seconds.
 */
export function DateTimePicker({
  action,
  note,
  value,
  onPick,
  ...layer
}: Layer & {
  /** The time already set, in the core's seconds: the picker opens on it. Left out, or past, it opens an hour out, on the hour. */
  value?: number | null
  /** The primary's word: "Snooze", "Set reminder", "Schedule". */
  action: string
  /** A line about what happens at that time, kept in full. */
  note?: ReactNode
  onPick: (at: number) => void
}) {
  const [open, setOpen] = useOpen(layer.open, layer.onOpenChange)
  return (
    <AdaptivePopover open={open} onOpenChange={setOpen} trigger={layer.trigger} title={layer.title} overline={layer.overline} align={layer.align ?? "end"}>
      <DateTimeBody
        action={action}
        note={note}
        value={value}
        onPick={(at) => {
          setOpen(false)
          onPick(at)
        }}
      />
    </AdaptivePopover>
  )
}

// Mounted while the picker is open, so each opening starts afresh.
function DateTimeBody({ action, note, value, onPick }: { action: string; note?: ReactNode; value?: number | null; onPick: (at: number) => void }) {
  const [start] = useState(() => (value && value * 1000 > Date.now() ? new Date(value * 1000) : new Date(Math.ceil(Date.now() / 3_600_000 + 1) * 3_600_000)))
  const [day, setDay] = useState(() => startOfDay(start))
  const [month, setMonth] = useState(day)
  const [time, setTime] = useState(() => timeInput(start))
  const field = useRef<HTMLInputElement>(null)
  const now = useNowSecs(15_000)
  const at = /^\d\d:\d\d/.test(time) ? secs(fromInputs(dateInput(day), time)) : null
  const tooSoon = at !== null && at <= now + 60
  return (
    <form
      className="flex flex-col gap-4"
      // React events cross portals: keep the keys from reaching a form around the trigger (the composer).
      // Escape goes on: it closes this layer.
      onKeyDown={(e) => e.key !== "Escape" && e.stopPropagation()}
      onSubmit={(e) => {
        e.preventDefault()
        e.stopPropagation()
        if (at === null || tooSoon) return field.current?.focus()
        onPick(at)
      }}
    >
      <MonthGrid
        month={month}
        onMonthChange={setMonth}
        selected={day}
        onPick={(d) => {
          setDay(startOfDay(d))
          setMonth(d)
        }}
      />
      <TextField ref={field} label="Time" type="time" required value={time} onChange={(e) => setTime(e.target.value)} error={tooSoon ? "Pick a time at least a minute from now." : undefined} />
      {note && <p className="type-caption text-text-secondary">{note}</p>}
      <Button type="submit" block>
        {action}
      </Button>
    </form>
  )
}
