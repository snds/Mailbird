import { useEffect, useEffectEvent } from "react"

import { useUi } from "@/app/ui-store"
import type { MessageSummary } from "@/core/types"

import type { useTriage } from "./actions"

/**
 * Single-key shortcuts (Gmail/Superhuman grammar), desktop only in practice:
 * j/k move, Enter opens, e archive, s star, u unread, c compose, / search.
 * Ignored while typing or while a dialog is open.
 */
export function useMailShortcuts(opts: {
  list: MessageSummary[]
  /** The selected conversation (thread id). */
  selectedId: string | null
  selected: MessageSummary | undefined
  select: (id: string | null) => void
  compose: () => void
  focusSearch: () => void
  triage: ReturnType<typeof useTriage>
}) {
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return
    const t = e.target as HTMLElement
    if (t.closest("input, textarea, select, [contenteditable=true], [role=dialog], [role=menu]")) return
    if (useUi.getState().composer || useUi.getState().accountsOpen) return

    const { list, selectedId, selected, select, triage } = opts
    const index = list.findIndex((m) => m.threadId === selectedId)
    const move = (delta: number) => {
      const next = list[Math.min(Math.max(index + delta, 0), list.length - 1)]
      if (next) select(next.threadId)
    }
    const handlers: Record<string, () => void> = {
      j: () => move(index < 0 ? 0 : 1),
      k: () => move(-1),
      Escape: () => select(null),
      c: opts.compose,
      "/": opts.focusSearch,
      e: () => selected && triage.toggleArchive(selected),
      s: () => selected && triage.toggleFlag(selected),
      u: () => selected && triage.markSeen(selected, false),
    }
    const run = handlers[e.key]
    if (run) {
      e.preventDefault()
      run()
    }
  })

  useEffect(() => {
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
}
