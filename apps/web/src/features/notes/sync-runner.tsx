import { useEffect } from "react"

import { useCore, useNotesRelay } from "@/core/queries"

import { startNotesSync } from "./sync"

/** Keeps notes syncing with the relay, if one is set up. Mount once. */
export function NotesSyncRunner() {
  const { data: core } = useCore()
  const { data: relay } = useNotesRelay()
  const url = relay?.url
  const token = relay?.token
  useEffect(() => {
    if (!core || !url) return
    return startNotesSync(core, { url, token: token ?? "" })
  }, [core, url, token])
  return null
}
