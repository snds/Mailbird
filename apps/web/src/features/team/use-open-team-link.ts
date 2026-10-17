import { toast } from "sonner"

import { useUi } from "@/app/ui-store"

import type { ShareLink } from "../notes/share-link"
import { teamSync } from "./team-sync"

/** Opens a teammate's conversation link: joins it once, then shows it in Mail → Team. */
export function useOpenTeamLink() {
  const showTeam = useUi((s) => s.showTeam)
  return async (link: ShareLink): Promise<boolean> => {
    const sync = teamSync()
    if (!sync) return false
    try {
      const t = await sync.join({ id: link.id, relay: link.relay, token: link.token, title: link.title, from: link.from })
      if (t.role === "guest") toast.success(link.from ? `Joined ${link.from}'s conversation` : "Joined the conversation", { duration: 2500 })
      showTeam(t.id)
      return true
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
      return false
    }
  }
}
