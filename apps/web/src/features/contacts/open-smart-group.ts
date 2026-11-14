import { create } from "zustand"

import { showSection } from "@/app/places"
import type { SmartGroup } from "@/core/types"

/** The smart group form: a new group (no `group`), or one being changed. The groups list opens it (`contacts-nav.tsx`). */
export const useSmartGroupEditor = create<{ editing: { group?: SmartGroup } | null }>(() => ({ editing: null }))
export function openSmartGroupEditor(group?: SmartGroup) {
  // From the sidebar while Settings is open: Contacts, which holds the form, comes back first.
  showSection("contacts")
  useSmartGroupEditor.setState({ editing: { group } })
}
