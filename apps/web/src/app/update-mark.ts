import { create } from "zustand"

import { useUpdates } from "@/features/updates/use-updates"

/**
 * A demo scenario's stand-in for the desktop updater (`update-ready`,
 * core/demo-scenarios/shell.ts): the version it says is ready. Only the
 * in-memory demo sets it; the desktop app's updater answers through
 * `useUpdates`.
 */
export const useDemoUpdate = create<{ offered: string | null }>(() => ({ offered: null }))

/**
 * The update mark on the way into Settings (ADR-0083, cross-app decisions §3):
 * a square on the sidebar's item, the rail's item and the phone's top-right
 * button, with its words in the control's name. Undefined when nothing waits.
 */
export function useUpdateMark() {
  const state = useUpdates()?.state
  const demo = useDemoUpdate((s) => s.offered)
  if (state === "ready" || demo !== null) return { square: true, label: "Update ready" } as const
  if (state === "available") return { square: true, label: "Update available" } as const
  return undefined
}
