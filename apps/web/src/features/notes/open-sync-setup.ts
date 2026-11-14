import { create } from "zustand"

import { showSection } from "@/app/places"

/**
 * An intent (ADR-0084): setting up sync between devices, from anywhere. It
 * shows Notes, which mounts the form: today the relay dialog; the notes
 * settings once they are built (brief T5).
 */
export const useSyncSetup = create<{ open: boolean }>(() => ({ open: false }))

export function openSyncSetup() {
  showSection("notes")
  useSyncSetup.setState({ open: true })
}

export const closeSyncSetup = () => useSyncSetup.setState({ open: false })
