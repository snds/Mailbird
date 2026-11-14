import { create } from "zustand"

import { showSection } from "@/app/places"

/**
 * An intent (ADR-0084): "Open a shared note…", from the notes folders and
 * the command menu. It shows Notes, which mounts the link form.
 */
export const useOpenSharedNote = create<{ open: boolean }>(() => ({ open: false }))

export function openSharedNote() {
  showSection("notes")
  useOpenSharedNote.setState({ open: true })
}

export const closeSharedNote = () => useOpenSharedNote.setState({ open: false })
