import { useEffect } from "react"
import { toast } from "sonner"

import { useCore, useNotesRelay } from "@/core/queries"

import { startGuestShares } from "./shared-docs"
import { startNotesSync } from "./sync"

/** Keeps notes syncing with the relay, if one is set up, and notes shared with you with theirs. Mount once. */
export function NotesSyncRunner() {
  const { data: core } = useCore()
  const { data: relay } = useNotesRelay()
  const url = relay?.url
  const token = relay?.token
  const key = relay?.key ?? null
  useEffect(() => {
    if (!core || !url) return
    return startNotesSync(core, { url, token: token ?? "", key })
  }, [core, url, token, key])
  // Notes shared with you (ADR-0056) sync on the owner's relay, so they don't need one of your own.
  useEffect(() => {
    if (!core) return
    return startGuestShares(core, (title, from) =>
      toast(`${from ?? "The owner"} stopped sharing “${title || "a note"}”`, { description: "What you had is now your own note. Only you can see it.", duration: 8000 }),
    )
  }, [core])
  return null
}
