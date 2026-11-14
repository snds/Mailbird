import { useSyncExternalStore } from "react"

import { useCore } from "@/core/queries"

/**
 * The in-memory demo needs no network, so it never says "Offline" (brief X4).
 * Its `offline` scenario (core/demo-scenarios/status.ts) turns this on, to
 * show the state; nothing else does.
 */
export const demoOffline = { on: false }

const subscribe = (changed: () => void) => {
  window.addEventListener("online", changed)
  window.addEventListener("offline", changed)
  return () => {
    window.removeEventListener("online", changed)
    window.removeEventListener("offline", changed)
  }
}

/**
 * Whether the device has a network, by the browser's own signal
 * (`navigator.onLine`). It can only say "no network at all": a server that
 * does not answer is a failed read, not this. True until the core is known.
 */
export function useOnline() {
  const { data: core } = useCore()
  const online = useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  )
  if (!core) return true
  if (core.kind === "demo") return !demoOffline.on
  return online
}
