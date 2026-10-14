// Calendar date math on the device clock. The core speaks seconds since the
// epoch; views think in local days.

export const HOUR = 3600
export const DAY = 86_400

export const secs = (d: Date) => Math.floor(d.getTime() / 1000)
export const fromSecs = (s: number) => new Date(s * 1000)

export function startOfDay(d: Date) {
  const c = new Date(d)
  c.setHours(0, 0, 0, 0)
  return c
}

/** Calendar arithmetic (DST-safe: adds days on the wall clock, not 24h blocks). */
export function addDays(d: Date, n: number) {
  const c = new Date(d)
  c.setDate(c.getDate() + n)
  return c
}

export function addMonths(d: Date, n: number) {
  const c = new Date(d.getFullYear(), d.getMonth() + n, 1)
  // Keep the day when the target month has it (Jan 31 → Feb 28, not Mar 3).
  c.setDate(Math.min(d.getDate(), new Date(c.getFullYear(), c.getMonth() + 1, 0).getDate()))
  return c
}

export const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

/** The locale's first day of the week (0 = Sunday), via Intl where available. */
export function firstDayOfWeek(): number {
  try {
    const loc = new Intl.Locale(navigator.language) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } }
    const info = loc.getWeekInfo?.() ?? loc.weekInfo
    if (info) return info.firstDay % 7 // Intl uses 1–7 with Monday = 1
  } catch {
    // fall through
  }
  return 0
}

export function startOfWeek(d: Date, first = firstDayOfWeek()) {
  const s = startOfDay(d)
  return addDays(s, -((s.getDay() - first + 7) % 7))
}

const pad = (n: number) => String(n).padStart(2, "0")

/** "2026-10-14" */
export const dateInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
/** "09:30" */
export const timeInput = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`

/** "2026-10-14" + "09:30" → Date on the device clock. */
export function fromInputs(date: string, time = "00:00") {
  const [y, m, day] = date.split("-").map(Number)
  const [h, min] = time.split(":").map(Number)
  return new Date(y!, (m ?? 1) - 1, day ?? 1, h ?? 0, min ?? 0)
}

export const deviceTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

/** Minutes past local midnight of `day`, clamped to that day. */
export function minutesInto(day: Date, s: number) {
  const t = fromSecs(s)
  if (t < day) return 0
  if (!sameDay(t, day)) return 24 * 60
  return t.getHours() * 60 + t.getMinutes()
}

export const fmt = {
  time: (s: number) => fromSecs(s).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
  weekdayShort: (d: Date) => d.toLocaleDateString(undefined, { weekday: "short" }),
  dayLong: (d: Date) => d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }),
  monthYear: (d: Date) => d.toLocaleDateString(undefined, { month: "long", year: "numeric" }),
  monthDay: (d: Date) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
}

/** "Today", "Tomorrow", or "Wednesday, October 14". */
export function dayLabel(d: Date, now = new Date()) {
  if (sameDay(d, now)) return "Today"
  if (sameDay(d, addDays(now, 1))) return "Tomorrow"
  if (sameDay(d, addDays(now, -1))) return "Yesterday"
  return fmt.dayLong(d)
}

/** "9:30 – 10:15 AM", "All day", or a multi-day span. */
export function rangeLabel(start: number, end: number, allDay: boolean) {
  const a = fromSecs(start)
  const b = fromSecs(end)
  if (allDay) {
    const last = addDays(b, -1)
    return sameDay(a, last) || last < a ? "All day" : `${fmt.monthDay(a)} – ${fmt.monthDay(last)}`
  }
  if (sameDay(a, b) || end === start) return end === start ? fmt.time(start) : `${fmt.time(start)} – ${fmt.time(end)}`
  return `${fmt.monthDay(a)} ${fmt.time(start)} – ${fmt.monthDay(b)} ${fmt.time(end)}`
}
