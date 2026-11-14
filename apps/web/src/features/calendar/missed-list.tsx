import { AdaptiveDialog, ListRow } from "@unicron/ui"

import { useUi } from "@/app/ui-store"
import type { DueReminder } from "@/core/types"
import { useNowSecs } from "@/hooks/use-now"

import { fmt } from "./dates"
import { closeMissed, useMissedReminders } from "./missed-reminders"

/** When it was due, against now: "Started 12 min ago · 16:30", or the day for an older one. */
function when(r: DueReminder, now: number) {
  if (r.noteId) return "From your notes"
  const minutes = Math.round((r.start - now) / 60)
  const at = fmt.time(r.start)
  const line =
    minutes >= 60 ? `Starts ${at}` : minutes > 0 ? `Starts in ${minutes} min · ${at}` : minutes === 0 ? `Starting now · ${at}` : minutes > -60 ? `Started ${-minutes} min ago · ${at}` : `${fmt.dayLong(new Date(r.start * 1000))}, ${at}`
  return r.location ? `${line} · ${r.location}` : line
}

/**
 * "Missed": the reminders that came due while Vale was closed, as a plain
 * list (ADR-0086; brief X5). A question-size dialog on a desktop, a sheet on
 * a phone. A row opens its event or its note and closes the list. Mounted
 * once at the root; `openMissed()` opens it.
 */
export function MissedList() {
  const open = useMissedReminders((s) => s.open)
  const items = useMissedReminders((s) => s.items)
  const jumpTo = useUi((s) => s.jumpTo)
  const now = useNowSecs()
  const go = (r: DueReminder) => {
    closeMissed()
    if (r.noteId) jumpTo({ kind: "note", id: r.noteId })
    else jumpTo({ kind: "event", id: r.eventId, start: r.start })
  }
  return (
    <AdaptiveDialog open={open} onOpenChange={(o) => !o && closeMissed()} size="question" overline={`Reminders // ${String(items.length).padStart(2, "0")}`} title="Missed" description="These came due while Vale was closed.">
      <ul aria-label="Missed reminders" className="flex flex-col">
        {items.map((r) => (
          <li key={`${r.noteId ?? r.eventId}-${r.fireAt}`}>
            <ListRow size="compact" onClick={() => go(r)} title={r.leave ? `Time to leave: ${r.title || "(no title)"}` : r.title || (r.noteId ? "New note" : "(no title)")} meta={when(r, now)} metaStyle="plain" />
          </li>
        ))}
      </ul>
    </AdaptiveDialog>
  )
}
