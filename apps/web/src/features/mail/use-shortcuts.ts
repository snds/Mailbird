import { useEffect, useEffectEvent } from "react"

import { useUi } from "@/app/ui-store"
import type { MessageSummary } from "@/core/types"
import { snoozeOptions } from "@/lib/time"

import type { useTriage } from "./actions"

/**
 * The keyboard half of the mail vocabulary (ADR-0025), listed in Shortcuts
 * and gestures. Swipes and the toolbar do the same actions.
 */
export const MAIL_SHORTCUTS: { keys: string[]; does: string }[] = [
  { keys: ["J", "K"], does: "Next / previous conversation" },
  { keys: ["Esc"], does: "Close the conversation" },
  { keys: ["E"], does: "Archive, or back to the inbox" },
  { keys: ["S"], does: "Star or unstar" },
  { keys: ["U"], does: "Mark unread" },
  { keys: ["H"], does: "Snooze until tomorrow" },
  { keys: ["C"], does: "Write a message" },
  { keys: ["/"], does: "Search mail" },
  { keys: ["⌘K"], does: "Commands and search, anywhere" },
  { keys: ["?"], does: "This list" },
]

/**
 * Single-key shortcuts (Gmail/Superhuman grammar), desktop only in practice.
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
    const ui = useUi.getState()
    if (ui.composer || ui.accountsOpen || ui.writingOpen || ui.paletteOpen || ui.grammarOpen) return

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
      h: () => {
        const o = snoozeOptions().find((x) => x.label === "Tomorrow")
        if (selected && o) triage.snooze(selected, o.until, o.label)
      },
      "?": () => ui.setGrammarOpen(true),
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
