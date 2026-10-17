import { useEffect, useState } from "react"
import type * as Y from "yjs"

import { useMyName } from "@/core/queries"


import { type TeamSnapshot, snapshot } from "./team-doc"
import { teamSync, useTeamVersions } from "./team-sync"

/** A shared conversation's document and what's in it, redrawn as it changes. */
export function useTeamDoc(id: string | null): { doc: Y.Doc | null; data: TeamSnapshot | null } {
  const [doc, setDoc] = useState<{ id: string; doc: Y.Doc } | null>(null)
  // Subscribed for its ticks: every change to the document redraws.
  useTeamVersions((s) => (id ? (s[id] ?? 0) : 0))
  useEffect(() => {
    if (!id) return
    let gone = false
    void teamSync()
      ?.doc(id)
      .then((d) => !gone && setDoc({ id, doc: d }))
    return () => {
      gone = true
    }
  }, [id])
  const current = doc && doc.id === id ? doc.doc : null
  const data = current ? snapshot(current) : null
  return { doc: current, data }
}


/** While a shared conversation is on screen, the others see you there (ADR-0061). */
export function useHereIn(id: string | null, live: boolean) {
  const me = useMyName()
  useEffect(() => {
    if (!id || !live) return
    teamSync()?.here(id, me)
    return () => teamSync()?.here(id, null)
  }, [id, live, me])
}
