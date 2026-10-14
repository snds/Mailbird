import { useQueryClient } from "@tanstack/react-query"
import { useCallback } from "react"
import { toast } from "sonner"

import { useUi } from "@/app/ui-store"
import { getCoreClient } from "@/core/client"
import type { NoteInput } from "@/core/types"

/** Creates a note and opens it; empty new notes are thrown away when closed. */
export function useNewNote() {
  const jumpTo = useUi((s) => s.jumpTo)
  const qc = useQueryClient()
  return useCallback(
    async (input: NoteInput = { markdown: "" }) => {
      try {
        const n = await (await getCoreClient()).createNote(input)
        await qc.invalidateQueries({ queryKey: ["notes"] })
        jumpTo({ kind: "note", id: n.id, fresh: true })
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e))
      }
    },
    [jumpTo, qc],
  )
}
