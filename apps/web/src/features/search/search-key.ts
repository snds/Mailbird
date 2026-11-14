import { useEffect, useEffectEvent } from "react"

import { useUi } from "@/app/ui-store"
import { useKeyBindings } from "@/core/queries"
import { commandFor, searchKey } from "@/lib/keys"

import { openSearch } from "./open"

/**
 * The person's search key (`mail.search`, `/` until changed) opens Search
 * from every section and from Settings (ADR-0085), where it used to put the
 * cursor in Mail's own field and did nothing elsewhere. Ignored while
 * typing, and while a dialog, a menu or the composer has the keyboard.
 * Mounted once, beside the shell.
 */
export function useSearchKey() {
  const { data: keys } = useKeyBindings()
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return
    const key = searchKey(keys)
    if (!key || e.key !== key) return
    const t = e.target as HTMLElement
    if (t.closest("input, textarea, select, [contenteditable=true], [role=dialog], [role=menu]")) return
    const ui = useUi.getState()
    if (ui.composer || ui.eventEditor || ui.contactEditor || ui.quickNote || ui.paletteOpen || ui.shortcutsOpen) return
    // A calendar key set to the same key keeps it there: the calendar's own handler runs it.
    if (ui.vertical === "calendar" && !ui.settings && !ui.search && commandFor(keys, "calendar", e.key)) return
    e.preventDefault()
    openSearch()
  })
  useEffect(() => {
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
}
