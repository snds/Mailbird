// Wall-clock times in a named time zone (ADR-0029). Shared by the event
// editor and the demo backend, which both turn "09:30 in Lisbon" into an
// instant and back.
const PARTS = new Map<string, Intl.DateTimeFormat>()
const partsIn = (zone: string) => {
  let f = PARTS.get(zone)
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    PARTS.set(zone, f)
  }
  return f
}

/** The wall clock in `zone` at `ms`, as numbers. */
function wall(zone: string, ms: number) {
  const p = Object.fromEntries(partsIn(zone).formatToParts(ms).map((x) => [x.type, x.value]))
  return { y: +p.year!, m: +p.month!, d: +p.day!, h: +p.hour! % 24, min: +p.minute!, s: +p.second! }
}

/** How far `zone` is ahead of UTC at `ms`, in ms. */
function offset(zone: string, ms: number) {
  const w = wall(zone, ms)
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.min, w.s) - Math.floor(ms / 1000) * 1000
}

/** An instant as the editor's fields in `zone`: "2026-10-14T09:30". */
export function zonedInput(secs: number, zone: string) {
  const w = wall(zone, secs * 1000)
  const two = (n: number) => String(n).padStart(2, "0")
  return `${w.y}-${two(w.m)}-${two(w.d)}T${two(w.h)}:${two(w.min)}`
}

/** The instant a wall time ("2026-10-14", "09:30") names in `zone`. */
export function zonedDate(date: string, time: string, zone: string) {
  const [y, m, d] = date.split("-").map(Number)
  const [h, min] = time.split(":").map(Number)
  const guess = Date.UTC(y!, (m ?? 1) - 1, d ?? 1, h ?? 0, min ?? 0)
  // Twice: the offset at the guess can differ from the one at the answer near a DST change.
  const first = guess - offset(zone, guess)
  return new Date(guess - offset(zone, first))
}
