// Time helpers. The core speaks seconds since the epoch.

export const toDate = (secs: number) => new Date(secs * 1000)

/** List-row timestamp: time today, weekday this week, date otherwise. */
export function shortTime(secs: number, now = new Date()) {
  const d = toDate(secs)
  const days = (startOfDay(now).getTime() - startOfDay(d).getTime()) / 86_400_000
  if (days <= 0) return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  if (days === 1) return "Yesterday"
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "short" })
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

export function longTime(secs: number) {
  return toDate(secs).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
}

function startOfDay(d: Date) {
  const c = new Date(d)
  c.setHours(0, 0, 0, 0)
  return c
}

function at(d: Date, hour: number) {
  const c = new Date(d)
  c.setHours(hour, 0, 0, 0)
  return c
}

export interface SnoozeOption {
  label: string
  until: number
  detail: string
}

/** Snooze presets, computed from now so labels never lie ("Tomorrow" at 1am). */
export function snoozeOptions(now = new Date()): SnoozeOption[] {
  const secs = (d: Date) => Math.floor(d.getTime() / 1000)
  const fmt = (d: Date) => d.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })
  const options: SnoozeOption[] = []

  const laterToday = new Date(now.getTime() + 3 * 3_600_000)
  if (laterToday.getDate() === now.getDate() && laterToday.getHours() < 21) {
    laterToday.setMinutes(0, 0, 0)
    options.push({ label: "Later today", until: secs(laterToday), detail: fmt(laterToday) })
  }
  const tomorrow = at(new Date(now.getTime() + 86_400_000), 8)
  options.push({ label: "Tomorrow", until: secs(tomorrow), detail: fmt(tomorrow) })

  const day = now.getDay() // 0 Sun … 6 Sat
  if (day >= 1 && day <= 4) {
    const saturday = at(new Date(now.getTime() + (6 - day) * 86_400_000), 9)
    options.push({ label: "This weekend", until: secs(saturday), detail: fmt(saturday) })
  }
  const toMonday = ((8 - day) % 7) || 7
  const monday = at(new Date(now.getTime() + toMonday * 86_400_000), 8)
  options.push({ label: "Next week", until: secs(monday), detail: fmt(monday) })
  return options
}

/** Send-later presets: working-hours times people actually pick. */
export function sendLaterOptions(now = new Date()): SnoozeOption[] {
  const secs = (d: Date) => Math.floor(d.getTime() / 1000)
  const fmt = (d: Date) => d.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })
  const options: SnoozeOption[] = []
  if (now.getHours() < 17) {
    const evening = at(now, 18)
    options.push({ label: "This evening", until: secs(evening), detail: fmt(evening) })
  }
  const tomorrow = new Date(now.getTime() + 86_400_000)
  options.push({ label: "Tomorrow morning", until: secs(at(tomorrow, 8)), detail: fmt(at(tomorrow, 8)) })
  options.push({ label: "Tomorrow afternoon", until: secs(at(tomorrow, 13)), detail: fmt(at(tomorrow, 13)) })
  const day = now.getDay()
  const toMonday = ((8 - day) % 7) || 7
  if (toMonday > 1) {
    const monday = at(new Date(now.getTime() + toMonday * 86_400_000), 8)
    options.push({ label: "Monday morning", until: secs(monday), detail: fmt(monday) })
  }
  return options
}

export interface FollowUpOption {
  label: string
  /** Seconds after sending. */
  after: number
}

/** "Remind me if no reply" presets, relative to when the message goes out. */
export const FOLLOW_UP_OPTIONS: FollowUpOption[] = [
  { label: "1 day", after: 86_400 },
  { label: "3 days", after: 3 * 86_400 },
  { label: "1 week", after: 7 * 86_400 },
]

/** A time as the value of an `<input type="datetime-local">`, in local time. */
export function toLocalInput(secs: number) {
  const d = toDate(secs)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** The inverse of `toLocalInput`; null when the field is empty or invalid. */
export function fromLocalInput(value: string): number | null {
  const t = new Date(value).getTime()
  return Number.isNaN(t) ? null : Math.floor(t / 1000)
}

/** A reminder's time, as short as it can be without being vague:
 * "Today, 3:00 PM", "Tomorrow, 8:00 AM", "Tue, 8:00 AM", "Oct 21, 8:00 AM". */
export function reminderLabel(secs: number, now = new Date()) {
  const d = toDate(secs)
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  const days = Math.round((startOfDay(d).getTime() - startOfDay(now).getTime()) / 86_400_000)
  if (days === 0) return `Today, ${time}`
  if (days === 1) return `Tomorrow, ${time}`
  if (days === -1) return `Yesterday, ${time}`
  if (days > 1 && days < 7) return `${d.toLocaleDateString(undefined, { weekday: "short" })}, ${time}`
  const sameYear = d.getFullYear() === now.getFullYear()
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) })}, ${time}`
}

// ── Someone else's clock (ADR-0040) ──────────────────────────────────────

/** "UTC+5:30", "UTC−4": the offset as people read it, with a real minus. */
export const utcLabel = (offset: number) => {
  if (offset === 0) return "UTC"
  const h = Math.floor(Math.abs(offset) / 60)
  const m = Math.abs(offset) % 60
  return `UTC${offset < 0 ? "\u2212" : "+"}${h}${m ? `:${String(m).padStart(2, "0")}` : ""}`
}

/** "4½ h ahead of you", "3 h behind you", "same time as you". */
export const gapLabel = (offset: number, mine: number) => {
  const d = offset - mine
  if (d === 0) return "same time as you"
  const h = Math.abs(d) / 60
  const n = Number.isInteger(h) ? `${h}` : Number.isInteger(h * 2) ? `${Math.floor(h)}½` : h.toFixed(2).replace(/0$/, "")
  return `${n} h ${d > 0 ? "ahead of" : "behind"} you`
}

/** Outside working hours, a word for what their day is doing; nothing between 8 and 6. */
export const partOfDay = (hour: number, weekday: number) =>
  hour >= 22 || hour < 5 ? "Night there" : hour < 8 ? "Early morning there" : weekday === 0 || weekday === 6 ? "Weekend there" : hour >= 18 ? "Evening there" : null

/** The next `hour`:00 on a weekday in someone's own time, at least 15 minutes
 * away, as Unix seconds: "9:00 AM their time" for send later (ADR-0041). */
export function nextLocalHour(offset: number, nowSecs: number, hour = 9) {
  // Work in their wall clock (UTC fields shifted by their offset), then shift back.
  const there = new Date((nowSecs + offset * 60) * 1000)
  const t = new Date(Date.UTC(there.getUTCFullYear(), there.getUTCMonth(), there.getUTCDate(), hour))
  const soonest = there.getTime() + 15 * 60_000
  while (t.getTime() < soonest || t.getUTCDay() === 0 || t.getUTCDay() === 6) t.setUTCDate(t.getUTCDate() + 1)
  return t.getTime() / 1000 - offset * 60
}

/** Someone's wall-clock time, formatted in their zone: "12:30 AM". */
export const timeThere = (offset: number, secs: number, opts: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" }) =>
  new Date((secs + offset * 60) * 1000).toLocaleString(undefined, { ...opts, timeZone: "UTC" })
