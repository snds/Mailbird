import { useSyncExternalStore } from "react"

// A per-viewer display choice, so it lives in this browser only. Storage can
// be missing (private windows, blocked site data); then it lasts the session.
const KEY = "mailbird.calendar.secondZone"
let memory: string | null = null
const listeners = new Set<() => void>()
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}

function read(): string | null {
  try {
    return localStorage.getItem(KEY) ?? memory
  } catch {
    return memory
  }
}

export function setSecondZone(zone: string | null) {
  memory = zone
  try {
    if (zone) localStorage.setItem(KEY, zone)
    else localStorage.removeItem(KEY)
  } catch {
    // Kept in memory instead.
  }
  listeners.forEach((l) => l())
}

/** The second time zone shown beside the hours, or null for none. */
export function useSecondZone(): string | null {
  const zone = useSyncExternalStore(subscribe, read, () => null)
  return zone && zones().includes(zone) && zone !== deviceZone() ? zone : null
}

export const deviceZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

let cached: string[] | null = null
export function zones() {
  cached ??= Intl.supportedValuesOf("timeZone")
  return cached
}

/** "America/Los_Angeles" → "Los Angeles". */
export const zoneCity = (zone: string) => (zone.split("/").at(-1) ?? zone).replace(/_/g, " ")

/** "PDT", "GMT+1" … at `at`. */
export function zoneAbbr(zone: string, at: Date) {
  return new Intl.DateTimeFormat(undefined, { timeZone: zone, timeZoneName: "short" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? zoneCity(zone)
}

/** The wall time in `zone` at the instant `at`: "3 PM", or "3:30 PM" for half-hour zones. */
export function zoneHour(zone: string, at: Date) {
  const minute = Number(new Intl.DateTimeFormat("en-US", { timeZone: zone, minute: "numeric" }).format(at))
  return at.toLocaleTimeString(undefined, { timeZone: zone, hour: "numeric", ...(minute ? { minute: "2-digit" } : {}) })
}


export { zonedDate, zonedInput } from "@/lib/zoned"
