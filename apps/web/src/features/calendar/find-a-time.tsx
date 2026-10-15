import { useState } from "react"
import { toast } from "sonner"

import { Icon, Button } from "@unicron/ui"
import { getCoreClient } from "@/core/client"
import type { TimeSlot } from "@/core/types"

import { dayLabel, fmt, fromInputs, fromSecs, secs } from "./dates"

// Working hours for suggestions: 9 to 6, weekdays.
const DAY_START = 9 * 60
const DAY_END = 18 * 60

/**
 * Free times in your calendars for an event this long, from the chosen day
 * on. Picking one fills in the start and end.
 */
export function FindATime({ date, minutes, onPick }: { date: string; minutes: number; onPick: (start: Date, end: Date) => void }) {
  const [slots, setSlots] = useState<TimeSlot[] | null>(null)
  const [busy, setBusy] = useState(false)
  const find = async () => {
    setBusy(true)
    try {
      // From the chosen day's start; the core never suggests the past.
      setSlots(await (await getCoreClient()).findTimes({ from: secs(fromInputs(date)), minutes: Math.max(15, minutes), dayStart: DAY_START, dayEnd: DAY_END, weekdaysOnly: true, limit: 6 }))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col gap-2 border-b px-4 py-2" data-slot="find-a-time">
      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" size="sm" className="-ml-2" disabled={busy} onClick={() => void find()}>
          <Icon name="event_upcoming" data-icon="inline-start" /> {slots ? "Find again" : "Find a time"}
        </Button>
        <span className="text-xs text-muted-foreground">Free {minutes >= 60 ? `${+(minutes / 60).toFixed(1)} h` : `${minutes} min`} in your calendars, weekdays 9–6</span>
      </div>
      {slots && slots.length === 0 && <p className="pb-1 text-xs text-muted-foreground">No free time like that in the next two weeks.</p>}
      {slots && slots.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pb-1" role="group" aria-label="Free times">
          {slots.map((s) => (
            <Button key={s.start} type="button" size="xs" variant="outline" className="rounded-full" onClick={() => onPick(fromSecs(s.start), fromSecs(s.end))}>
              {dayLabel(fromSecs(s.start))} · {fmt.time(s.start)}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}

