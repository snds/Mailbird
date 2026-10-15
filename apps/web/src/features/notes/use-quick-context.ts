import { useEffect } from "react"

import { type QuickContext, useUi } from "@/app/ui-store"

/**
 * Tells Quick Note what's open on screen (ADR-0037): a conversation, an
 * event, or a contact. Cleared when that view closes, unless something
 * else has taken its place.
 */
export function useQuickContext(c: QuickContext | null) {
  const kind = c?.kind
  const id = c?.id
  const label = c?.label
  useEffect(() => {
    if (!kind || !id) return
    const mine = { kind, id, label: label ?? "" }
    useUi.getState().setQuickContext(mine)
    return () => {
      const now = useUi.getState().quickContext
      if (now?.kind === kind && now.id === id) useUi.getState().setQuickContext(null)
    }
  }, [kind, id, label])
}
