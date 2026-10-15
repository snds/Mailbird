import { useEffect, useEffectEvent } from "react"

import { useUi } from "@/app/ui-store"
import type { MessageSummary } from "@/core/types"
import { snoozeOptions } from "@/lib/time"

import { useKeyBindings } from "@/core/queries"
import { commandFor } from "@/lib/keys"

import type { useTriage } from "./actions"
import type { useMailVerbs } from "./vocabulary"

/**
 * Single-key shortcuts (Gmail/Superhuman grammar), desktop only in practice.
 * The keys are yours (ADR-0032); the commands are the shared mail
 * vocabulary (ADR-0025). Ignored while typing or while a dialog is open.
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
  /** The swipe vocabulary, for the actions that began as swipes. */
  verb: ReturnType<typeof useMailVerbs>
}) {
  const { data: keys } = useKeyBindings()
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
    const swipe = (id: Parameters<typeof opts.verb>[0]) => () => selected && opts.verb(id, selected)?.onCommit()
    const handlers: Record<string, () => void> = {
      "mail.next": () => move(index < 0 ? 0 : 1),
      "mail.previous": () => move(-1),
      "mail.compose": opts.compose,
      "mail.search": opts.focusSearch,
      "mail.archive": () => selected && triage.toggleArchive(selected),
      "mail.star": () => selected && triage.toggleFlag(selected),
      "mail.unread": () => selected && triage.markSeen(selected, false),
      "mail.snooze-tomorrow": () => {
        const o = snoozeOptions().find((x) => x.label === "Tomorrow")
        if (selected && o) triage.snooze(selected, o.until, o.label)
      },
      "mail.snooze-next-week": swipe("snooze-next-week"),
      "mail.remind": swipe("remind"),
      "mail.newsletters": swipe("newsletters"),
    }
    // Esc and ? never change, so the way out and the way to this list stay put.
    const fixed: Record<string, () => void> = { Escape: () => select(null), "?": () => ui.setGrammarOpen(true) }
    const command = commandFor(keys, "mail", e.key)
    const run = (command && handlers[command]) || fixed[e.key]
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
