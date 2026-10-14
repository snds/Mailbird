import { useEffect, useState } from "react"

/** The current time, refreshed every `everyMs` (a minute by default). */
export function useNow(everyMs = 60_000) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), everyMs)
    return () => clearInterval(t)
  }, [everyMs])
  return now
}

/** The same, in the core's seconds. */
export function useNowSecs(everyMs = 60_000) {
  return Math.floor(useNow(everyMs).getTime() / 1000)
}
