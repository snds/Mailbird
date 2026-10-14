import { useEffect } from "react"
import { toast } from "sonner"

import { useCore } from "@/core/queries"
import type { DueReminder } from "@/core/types"

import { fmt } from "./dates"

/**
 * Reminders as they come due. The desktop shell also raises an OS
 * notification; this keeps the reminder visible inside the app, and is the
 * only one the web demo has. Mounted once at the root.
 */
export function ReminderWatcher() {
  const { data: core } = useCore()
  useEffect(() => {
    if (!core) return
    return core.on("reminder", (payload) => {
      const r = payload as DueReminder
      const minutes = Math.round((r.start - r.fireAt) / 60)
      const when = minutes <= 0 ? `Now · ${fmt.time(r.start)}` : minutes < 60 ? `In ${minutes} min · ${fmt.time(r.start)}` : `${fmt.dayLong(new Date(r.start * 1000))}, ${fmt.time(r.start)}`
      toast(r.title || "(no title)", {
        id: `reminder-${r.eventId}-${r.fireAt}`,
        description: r.location ? `${when} · ${r.location}` : when,
        duration: 15_000,
      })
    })
  }, [core])
  return null
}
