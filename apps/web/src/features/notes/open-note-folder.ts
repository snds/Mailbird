import { create } from "zustand"

import { showSection } from "@/app/places"
import type { NoteFolder } from "@/core/types"

/** The smart folder form: a new folder (no `folder`), or one being changed. The folders list opens it (`notes-nav.tsx`). */
export const useNoteFolderEditor = create<{ editing: { folder?: NoteFolder } | null }>(() => ({ editing: null }))
export function openNoteFolderEditor(folder?: NoteFolder) {
  // From the sidebar while Settings is open: Notes, which holds the form, comes back first.
  showSection("notes")
  useNoteFolderEditor.setState({ editing: { folder } })
}
