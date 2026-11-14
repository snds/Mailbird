import { create } from "zustand"

import { showSection } from "@/app/places"

/**
 * An intent (ADR-0084): "Restore contacts", from the contacts groups and the
 * command menu. It shows Contacts, which mounts the form. `openedAt` is the
 * moment it was asked for, in Unix seconds, so "an hour ago" means an hour
 * before that.
 */
export const useRestoreContacts = create<{ openedAt: number | null }>(() => ({ openedAt: null }))

export function openRestoreContacts() {
  showSection("contacts")
  useRestoreContacts.setState({ openedAt: Math.floor(Date.now() / 1000) })
}

export const closeRestoreContacts = () => useRestoreContacts.setState({ openedAt: null })
