import { create } from "zustand"

import { showSection } from "@/app/places"
import { toast } from "@unicron/ui"
import { useCalendarSets, usePimAction } from "@/core/queries"
import type { Collection } from "@/core/types"

const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e))

/**
 * Saved combinations of calendars ("Work", "Personal"): one tap shows exactly
 * that set (ADR-0021; Fantastical's calendar sets). The rows are in the
 * calendars list (`calendar-nav.tsx`, brief X1); this file holds what they do.
 */
export function useSets(calendars: Map<string, Collection>) {
  const { data: sets = [] } = useCalendarSets()
  const apply = usePimAction((c, id: string) => c.applyCalendarSet(id))
  const remove = usePimAction((c, id: string) => c.deleteCalendarSet(id))
  const showing = [...calendars.values()].filter((c) => !c.hidden).map((c) => c.id)
  return {
    sets,
    /** The set that is exactly what shows now, if any. */
    active: sets.find((s) => s.calendarIds.length === showing.length && s.calendarIds.every((id) => showing.includes(id)))?.id ?? null,
    apply: (id: string) => apply.mutate(id, { onError: fail }),
    remove: (id: string) => remove.mutate(id, { onError: fail }),
  }
}

/** "Save as set…": the form that names what is showing. The calendar view mounts it; the list's row opens it. */
export const useSavingSet = create<{ open: boolean }>(() => ({ open: false }))
export function openSaveSet() {
  // From the sidebar while Settings is open: the calendar, which holds the form, comes back first.
  showSection("calendar")
  useSavingSet.setState({ open: true })
}
