import { useEffect } from "react"
import { toast } from "sonner"

import { useUi } from "@/app/ui-store"
import { useCore } from "@/core/queries"
import type { DueReminder } from "@/core/types"

import { fmt } from "./dates"

// Taken once per page load, so a remount (or React's dev double-run) can't lose them.
let missedOnce: Promise<DueReminder[]> | null = null

/**
 * Reminders as they come due. The desktop shell also raises an OS
 * notification; this keeps the reminder visible inside the app, and is the
 * only one the web demo has. Mounted once at the root. On start it also
 * shows the reminders that came due while the app was closed, once.
 */
export function ReminderWatcher() {
  const { data: core } = useCore()
  const jumpTo = useUi((s) => s.jumpTo)
  useEffect(() => {
    if (!core) return
    const show = (r: DueReminder, missed = false) => {
      // A note coming back (ADR-0039): no start to count down to, one tap to open it.
      if (r.noteId) {
        const id = r.noteId
        const title = r.title || "New note"
        toast(missed ? `Missed: ${title}` : title, {
          id: `reminder-note-${id}-${r.fireAt}`,
          description: "From your notes",
          duration: missed ? Infinity : 15_000,
          closeButton: missed,
          action: { label: "Open", onClick: () => jumpTo({ kind: "note", id }) },
        })
        return
      }
      const minutes = Math.round((r.start - (missed ? Date.now() / 1000 : r.fireAt)) / 60)
      const when = missed
        ? minutes > 0
          ? `Starts in ${minutes} min · ${fmt.time(r.start)}`
          : minutes === 0
            ? `Starting now · ${fmt.time(r.start)}`
            : `Started ${-minutes} min ago · ${fmt.time(r.start)}`
        : minutes <= 0
          ? `Now · ${fmt.time(r.start)}`
          : minutes < 60
            ? `In ${minutes} min · ${fmt.time(r.start)}`
            : `${fmt.dayLong(new Date(r.start * 1000))}, ${fmt.time(r.start)}`
      // Time to leave (ADR-0029): the travel time before the event starts now.
      const title = r.leave ? `Time to leave: ${r.title || "(no title)"}` : r.title || "(no title)"
      const lead = r.leave && !missed ? `Starts in ${minutes} min · ${fmt.time(r.start)}` : when
      toast(missed ? `Missed: ${title}` : title, {
        id: `reminder-${r.eventId}-${r.fireAt}`,
        description: r.location ? `${lead} · ${r.location}` : lead,
        duration: missed ? Infinity : 15_000,
        closeButton: missed,
      })
    }
    let live = true
    missedOnce ??= core.takeMissedReminders().catch(() => [])
    void missedOnce.then((list) => live && list.forEach((r) => show(r, true)))
    const off = core.on("reminder", (payload) => show(payload as DueReminder))
    return () => {
      live = false
      off()
    }
  }, [core, jumpTo])
  return null
}
