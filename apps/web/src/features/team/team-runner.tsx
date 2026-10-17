import { useEffect } from "react"
import { toast } from "sonner"

import { useCore, useNotesRelay } from "@/core/queries"

import { startTeamSync } from "./team-sync"

/** Keeps shared conversations connected (ADR-0060): yours on your relay, others' on theirs. Mount once. */
export function TeamSyncRunner() {
  const { data: core } = useCore()
  const { data: relay, isPending } = useNotesRelay()
  const url = relay?.url
  const token = relay?.token
  useEffect(() => {
    if (!core || isPending) return
    return startTeamSync(core, url ? { url, token: token ?? "" } : null, (title, from) =>
      toast(`${from ?? "The owner"} stopped sharing “${title || "a conversation"}”`, { description: "What you had stays in Team as your copy. Only you can see it.", duration: 8000 }),
    )
  }, [core, isPending, url, token])
  return null
}
