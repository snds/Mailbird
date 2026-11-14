import { useEffect, useState } from "react"
import { toast } from "@unicron/ui"

import { useUi } from "@/app/ui-store"
import { getCoreClient } from "@/core/client"
import { useOutbox } from "@/core/queries"
import type { OutboxItem } from "@/core/types"

import { UNDO_SECONDS } from "./format"

/** A message's name in a line about it: its subject, or what it is when it has none. */
export const sendName = (item: OutboxItem) => item.draft.subject.trim() || "message"

/** The messages still in their undo window, newest first, and the seconds the newest has left. */
export interface SendingWindow {
  items: OutboxItem[]
  newest: OutboxItem
  /** Whole seconds until the newest goes out: 10 down to 1. */
  secondsLeft: number
  /** The window's length, for the bar. */
  total: number
}

/** A send waiting out its undo window: queued, not sent later on purpose, and due within the window. */
const inWindow = (item: OutboxItem, nowMs: number) => item.state === "queued" && !item.scheduled && item.sendAt * 1000 > nowMs && item.sendAt * 1000 - nowMs <= (UNDO_SECONDS + 1) * 1000

/**
 * The sends that can still be taken back (ADR-0086; brief X4). Read by the
 * status strip and the status line, which show the newest; each is also a
 * row in the Outbox. It ticks only while something waits.
 */
export function useSending(): SendingWindow | null {
  const { data: outbox } = useOutbox()
  const [now, setNow] = useState(() => Date.now())
  const waiting = (outbox ?? []).filter((i) => i.state === "queued" && !i.scheduled)
  const any = waiting.length > 0
  useEffect(() => {
    if (!any) return
    const tick = () => setNow(Date.now())
    const first = setTimeout(tick, 0)
    const t = setInterval(tick, 250)
    return () => {
      clearTimeout(first)
      clearInterval(t)
    }
  }, [any, outbox])
  // Newest first; the outbox lists them oldest first, which settles two sent in the same second.
  const items = waiting.filter((i) => inWindow(i, now)).reverse().sort((a, b) => b.sendAt - a.sendAt)
  const newest = items[0]
  if (!newest) return null
  return { items, newest, secondsLeft: Math.min(UNDO_SECONDS, Math.max(1, Math.ceil(newest.sendAt - now / 1000))), total: UNDO_SECONDS }
}

/** Takes a send back while its window is open: the message reopens as it was. */
export async function undoSend(id: string) {
  try {
    const client = await getCoreClient()
    useUi.getState().openComposer(await client.cancelSend(id))
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e))
  }
}
