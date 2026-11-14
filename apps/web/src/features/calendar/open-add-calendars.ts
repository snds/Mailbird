import { create } from "zustand"

import { showSection } from "@/app/places"

/**
 * An intent (ADR-0084): "Add calendars", from the calendars list and the
 * command menu. It shows Calendar, which mounts the picker: holidays by
 * country and region, and the moon (ADR-0024).
 */
export const useAddCalendars = create<{ open: boolean }>(() => ({ open: false }))

export function openAddCalendars() {
  showSection("calendar")
  useAddCalendars.setState({ open: true })
}

export const closeAddCalendars = () => useAddCalendars.setState({ open: false })
