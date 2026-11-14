import { useEffect, useRef } from "react"
import { toast } from "@unicron/ui"

import { useUi } from "@/app/ui-store"
import { useCore, useOutbox } from "@/core/queries"

import { sendName, undoSend, useSending } from "./sending"

/** Focus is where typing has its own undo: a field, a select, an editor. */
const typing = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))

/**
 * What happens to a send, said once. Mounted at the root.
 *
 * While its undo window is open the send is live, so the status strip and
 * the status line show it (`useSending` in sending.ts, app/status.tsx), not a toast. Here:
 * ⌘Z or Ctrl+Z outside a text field takes back the newest send, and when a
 * send leaves its window the core emits `outbox:changed` with its id, and a
 * toast says what became of it: "Sent {subject}", or "Not sent: {subject}"
 * with a way back into the message, which stays until it is used.
 */
export function OutboxWatcher() {
  const { data: core } = useCore()
  const openComposer = useUi((s) => s.openComposer)
  const { data: outbox } = useOutbox()
  const sending = useSending()
  const newest = useRef<string | null>(null)
  useEffect(() => {
    newest.current = sending?.newest.id ?? null
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "z" || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return
      if (!newest.current || typing(e.target)) return
      e.preventDefault()
      void undoSend(newest.current)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  useEffect(() => {
    if (!core) return
    return core.on("outbox:changed", async (id) => {
      if (typeof id !== "string") return
      const failed = (await core.listOutbox()).find((i) => i.id === id && i.state === "failed")
      if (failed) {
        toast.error(`Not sent: ${sendName(failed)}`, {
          description: failed.error ?? undefined,
          duration: Infinity,
          action: { label: "Edit", onClick: () => openComposer(failed.draft) },
        })
      } else {
        const sent = sentNames.get(id)
        sentNames.delete(id)
        toast(sent ? `Sent ${sent}` : "Sent message")
      }
    })
  }, [core, openComposer])

  // A sent item leaves the outbox's list, so its name is kept from while it waited.
  useEffect(() => {
    for (const item of outbox ?? []) sentNames.set(item.id, sendName(item))
  }, [outbox])
  return null
}

/** The names of messages seen waiting in the outbox, by id, for the toast once each has gone out. */
const sentNames = new Map<string, string>()
