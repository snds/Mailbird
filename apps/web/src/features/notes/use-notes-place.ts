import type { NotesPlace } from "@/app/places"
import { useUi } from "@/app/ui-store"
import { useNoteFolders, useNoteTags } from "@/core/queries"

/**
 * Notes' place as it stands: the one in the store, unless its smart folder
 * or its tag is gone; then all notes, and no tag. The nav and the view both
 * read it.
 */
export function useNotesPlace() {
  const stored = useUi((s) => s.notesPlace)
  const { data: folders = [], isPending: foldersPending } = useNoteFolders()
  const { data: tags = [], isPending: tagsPending } = useNoteTags()
  const kept = stored.folder
  const folder = kept.kind === "folder" ? (folders.find((f) => f.id === kept.id) ?? null) : null
  // While the lists are still arriving, the stored place is trusted.
  const place: NotesPlace = {
    folder: kept.kind === "folder" && !folder && !foldersPending ? { kind: "all" } : kept,
    tag: stored.tag && (tagsPending || tags.some((t) => t.tag === stored.tag)) ? stored.tag : null,
  }
  const name = place.folder.kind === "archive" ? "Archive" : place.folder.kind === "pinned" ? "Pinned" : place.folder.kind === "folder" ? (folder?.name ?? "Smart folder") : "All notes"
  return { place, folder, folders, tags, name }
}
