import type { Occurrence } from "@/core/types"

import { minutesInto } from "./dates"

/** Shortest drawn event, so a 5-minute call is still a tap target. */
const MIN_MINUTES = 22

export const occurrenceKey = (o: Pick<Occurrence, "eventId" | "start">) => `${o.eventId}@${o.start}`

export interface Placed {
  o: Occurrence
  top: number
  height: number
  col: number
  cols: number
}

/**
 * Overlap layout: events that overlap share a cluster and split its width
 * into columns, each event taking the first column free at its start.
 */
export function layoutDay(day: Date, list: Occurrence[]): Placed[] {
  const items = list
    .map((o) => {
      const top = minutesInto(day, o.start)
      const bottom = Math.max(minutesInto(day, o.end), top + MIN_MINUTES)
      return { o, top, bottom }
    })
    .sort((a, b) => a.top - b.top || b.bottom - a.bottom)
  const out: Placed[] = []
  let cluster: { o: Occurrence; top: number; bottom: number; col: number }[] = []
  let clusterEnd = -1
  const flush = () => {
    const cols = Math.max(1, ...cluster.map((c) => c.col + 1))
    for (const c of cluster) out.push({ o: c.o, top: c.top, height: c.bottom - c.top, col: c.col, cols })
    cluster = []
  }
  for (const it of items) {
    if (it.top >= clusterEnd && cluster.length) flush()
    const taken = new Set(cluster.filter((c) => c.bottom > it.top).map((c) => c.col))
    let col = 0
    while (taken.has(col)) col++
    cluster.push({ ...it, col })
    clusterEnd = Math.max(clusterEnd, it.bottom)
  }
  if (cluster.length) flush()
  return out
}
