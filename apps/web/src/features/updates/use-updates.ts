import { useEffect, useState } from "react"

import { updateClient, type UpdateStatus } from "./update-client"

/** Where updates stand, kept current from the shell's event; null where there's no updater, or until it answers. */
export function useUpdates(): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  useEffect(() => {
    const pending = updateClient()
    if (!pending) return
    let live = true
    let off: (() => void) | undefined
    // An event that arrives first is newer than the first read's answer.
    let heard = false
    void pending.then((c) => {
      if (!live) return
      off = c.onStatus((s) => {
        heard = true
        if (live) setStatus(s)
      })
      c.status().then(
        (s) => live && !heard && setStatus(s),
        () => live && !heard && setStatus(null),
      )
    })
    return () => {
      live = false
      off?.()
    }
  }, [])
  return status
}
