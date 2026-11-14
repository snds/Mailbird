import { create } from "zustand"

import type { DueReminder } from "@/core/types"

/**
 * The reminders that came due while Vale was closed (ADR-0086; brief X5).
 * The reminder watcher fills it once, at start. The list is kept for the
 * session: the toast's SEE opens it, and so does "Missed reminders" in the
 * command menu.
 */
interface MissedState {
  items: DueReminder[]
  /** The session's one notice about them has been raised, so a remount does not raise it again. */
  raised: boolean
  /** The list is open. */
  open: boolean
}

export const useMissedReminders = create<MissedState>(() => ({ items: [], raised: false, open: false }))

/** What the core handed over at start. Each reminder is handed over once, so this is the session's only copy. */
export const setMissedReminders = (items: DueReminder[]) => useMissedReminders.setState({ items })
/** The notice about them is up. */
export const markMissedRaised = () => useMissedReminders.setState({ raised: true })
/** Opens the Missed list. It does nothing when nothing was missed. */
export const openMissed = () => useMissedReminders.setState((s) => (s.items.length ? { open: true } : s))
export const closeMissed = () => useMissedReminders.setState({ open: false })
