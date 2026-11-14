import { useEffect } from "react"
import { toast } from "@unicron/ui"

import { useUi } from "@/app/ui-store"
import { useCore } from "@/core/queries"
import type { DueReminder } from "@/core/types"

import { fmt } from "./dates"
import { markMissedRaised, openMissed, setMissedReminders, useMissedReminders } from "./missed-reminders"

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
          // A missed one stays until its action is pressed (or it is swiped away): unicron's
          // toast has one action and no close button.
          duration: missed ? Infinity : 15_000,
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
        // A missed one stays until closed; pressing a toast's action closes it.
        action: missed ? { label: "Dismiss", onClick: () => {} } : undefined,
      })
    }
    let live = true
    // Kept for the session, for the Missed list (ADR-0086): the core hands each over once.
    missedOnce ??= core
      .takeMissedReminders()
      .catch(() => [])
      .then((list) => (setMissedReminders(list), list))
    void missedOnce.then((list) => {
      if (!live) return
      // Several missed reminders are one notice and a list, not a pile of toasts (brief X5). It stays until SEE.
      if (list.length < 2) return list.forEach((r) => show(r, true))
      if (useMissedReminders.getState().raised) return
      markMissedRaised()
      toast(`${list.length} reminders came due while Vale was closed`, { id: "reminders-missed", duration: Infinity, action: { label: "See", onClick: openMissed } })
    })
    const off = core.on("reminder", (payload) => show(payload as DueReminder))
    return () => {
      live = false
      off()
    }
  }, [core, jumpTo])
  return null
}
