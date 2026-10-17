import { toast } from "sonner"

import { useUi } from "@/app/ui-store"

import type { ShareLink } from "./share-link"
import { guestShares } from "./shared-docs"

/** Adds a link's note (or finds the one it already made) and opens it. Says why, when it can't. */
export function useAddShared() {
  const jumpTo = useUi((s) => s.jumpTo)
  return async (link: ShareLink): Promise<boolean> => {
    const g = guestShares()
    if (!g) return false
    try {
      const { id, ready } = await g.add(link)
      if (ready === "timeout") toast("Added. Its text arrives once the owner's relay can be reached.", { duration: 5000 })
      else toast.success(link.from ? `Added ${link.from}'s note` : "Added to your notes", { duration: 2500 })
      jumpTo({ kind: "note", id })
      return true
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
      return false
    }
  }
}
