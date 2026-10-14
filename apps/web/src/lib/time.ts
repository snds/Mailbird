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
