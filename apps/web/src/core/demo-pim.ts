// In-memory calendars and contacts for the web demo. Follows the core's
// rules where they matter to the UI (series expansion, skipped dates,
// read-only collections, duplicate grouping, merges) on the device clock;
// the Rust core does the real iCalendar and time-zone work.

import type { CoreEvent } from "./client"
import { HOLIDAY_COUNTRIES, INTERESTING, MOON, SPECIAL, dayKey, daysOf, holidayId, localMidnight, moonPhases, parseDay } from "./demo-interesting"
import type {
  Address,
  Attendee,
  Collection,
  ContactActivity,
  ContactDetail,
  ContactField,
  ContactInput,
  ContactLabel,
  ContactsRestore,
  ContactsRestored,
  SmartGroup,
  SmartGroupInput,
  ContactSummary,
  DeletedContact,
  DueReminder,
  EditScope,
  EventDetail,
  EventInput,
  Invite,
  InviteResponse,
  Occurrence,
  Repeat,
  CalendarSet,
  FindTimes,
  InterestingCalendar,
  Booked,
  BookingLink,
  BookingLinkInput,
  BookingRequest,
  PublicBooking,
  TimeSlot,
  ContactSuggestion,
  SignatureCard,
} from "./types"
import { parseSignature } from "./demo-signature"
import { zonedDate } from "@/lib/zoned"

interface DemoEvent {
  id: string
  calendarId: string
  title: string
  location: string | null
  notes: string | null
  start: number
  end: number
  allDay: boolean
  repeat: Repeat
  /** Original starts of skipped occurrences. */
  skipped: number[]
  /** One-occurrence edits, by original start (RECURRENCE-ID). */
  overrides: Record<number, { title: string; location: string | null; start: number; end: number }>
  /** The series stops before this slot ("this and following" split it). */
  until: number | null
  attendees: EventDetail["attendees"]
  organizer: Address | null
  reminders: number[]
  uid: string
  /** Minutes to get there (ADR-0029). */
  travel: number | null
  /** The zone its times were written in; null for the device's. */
  timeZone: string | null
}

/** A demo message's invitation, as the organizer sent it, or a guest's counter-proposal. */
export interface DemoInviteSeed {
  uid: string
  title: string
  location: string | null
  /** For a counter-proposal: the time the guest proposes. */
  start: number
  end: number
  organizer: Address
  attendees: Attendee[]
  /** "counter": a guest (`attendees[0]`) proposes another time for your event. */
  method?: "request" | "counter"
  comment?: string
}

type DemoContact = ContactDetail

const secs = (d: Date) => Math.floor(d.getTime() / 1000)

/** "2026-10-14" or "2026-10-14T09:30" on the device clock → seconds. */
function parseLocal(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(s)
  if (!m) throw new Error(`“${s}” isn't a date and time`)
  const [, y, mo, d, h = "0", mi = "0"] = m
  return secs(new Date(+y!, +mo! - 1, +d!, +h, +mi))
}

function step(t: number, repeat: Repeat, n: number): number {
  const d = new Date(t * 1000)
  if (repeat === "daily") d.setDate(d.getDate() + n)
  else if (repeat === "weekly") d.setDate(d.getDate() + 7 * n)
  else if (repeat === "monthly") d.setMonth(d.getMonth() + n)
  else if (repeat === "yearly") d.setFullYear(d.getFullYear() + n)
  return secs(d)
}

interface Slot {
  start: number
  end: number
  original: number
  title: string
  location: string | null
}

function expand(e: DemoEvent, from: number, to: number): Slot[] {
  const len = e.end - e.start
  if (e.repeat === "none" || e.repeat === "custom") {
    return e.start < to && e.end > from ? [{ start: e.start, end: e.end, original: e.start, title: e.title, location: e.location }] : []
  }
  const out: Slot[] = []
  for (let i = 0; i < 5000; i++) {
    const original = step(e.start, e.repeat, i)
    if (e.until != null && original >= e.until) break
    // Overrides can move an occurrence past the window edge; look a day further.
    if (original >= to + 86_400) break
    if (e.skipped.includes(original)) continue
    const o = e.overrides[original]
    const slot = o ? { ...o, original } : { start: original, end: original + len, original, title: e.title, location: e.location }
    if (slot.start < to && slot.end > from) out.push(slot)
  }
  return out
}

/** Known video-call hosts, and the path a meeting link starts with (like the core's `meeting::meeting_link`). */
const MEETING_HOSTS: [string, string[]][] = [
  ["zoom.us", ["/j/", "/my/", "/w/", "/s/"]],
  ["zoomgov.com", ["/j/"]],
  ["meet.google.com", ["/"]],
  ["teams.microsoft.com", ["/l/meetup-join/", "/meet/"]],
  ["teams.live.com", ["/meet/"]],
  ["webex.com", ["/meet/", "/join/", "/wbxmjs/"]],
  ["meet.jit.si", ["/"]],
  ["whereby.com", ["/"]],
  ["facetime.apple.com", ["/join"]],
]

function meetingLink(...texts: (string | null | undefined)[]): string | null {
  for (const t of texts) {
    for (const token of (t ?? "").split(/[\s<>"'()[\]{}|]+/)) {
      const url = token.replace(/[.,;:!?]+$/, "")
      const m = /^https:\/\/([^/?#]+)([^]*)$/.exec(url)
      if (!m) continue
      const host = m[1]!.toLowerCase()
      const path = m[2]!
      if (MEETING_HOSTS.some(([h, paths]) => (host === h || host.endsWith(`.${h}`)) && path.length > 1 && paths.some((x) => path.startsWith(x) || (x === "/" && path.length > 3)))) return url
    }
  }
  return null
}

const BIRTHDAY = "birthday:"
const BIRTHDAYS = "birthdays"
/** A year past which the demo stops looking for contact activity. */
const ACTIVITY_WINDOW = 365 * 86_400

const normEmail = (e: string) => e.trim().toLowerCase()
const normPhone = (p: string) => p.replace(/\D/g, "").slice(-10)

export function createDemoPim(emit: (event: CoreEvent, payload?: unknown) => void, later: <T>(v: T) => Promise<T>) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const at = (dayOffset: number, h: number, m = 0) => {
    const d = new Date(today)
    d.setDate(d.getDate() + dayOffset)
    d.setHours(h, m, 0, 0)
    return secs(d)
  }
  const untilSaturday = (6 - today.getDay() + 7) % 7 || 7

  const collections: Collection[] = [
    { id: "cal-personal", accountId: "personal", kind: "calendar", name: "Personal", color: "#e05a47", writable: true, hidden: false, scheduling: false },
    { id: "cal-work", accountId: "work", kind: "calendar", name: "Work", color: "#2563eb", writable: true, hidden: false, scheduling: true },
    { id: "cal-holidays", accountId: "personal", kind: "calendar", name: "Holidays", color: "#16a34a", writable: false, hidden: false, scheduling: false },
    { id: "cal-local", accountId: null, kind: "calendar", name: "On this device", color: null, writable: true, hidden: false, scheduling: false },
    // Made from contacts' birthdays; read-only, like the core's.
    { id: BIRTHDAYS, accountId: null, kind: "calendar", name: "Birthdays", color: "#db2777", writable: false, hidden: false, scheduling: false },
    { id: "book-personal", accountId: "personal", kind: "contacts", name: "Personal", color: null, writable: true, hidden: false, scheduling: false },
    { id: "book-work", accountId: "work", kind: "contacts", name: "Work", color: null, writable: true, hidden: false, scheduling: false },
    { id: "book-local", accountId: null, kind: "contacts", name: "On this device", color: null, writable: true, hidden: false, scheduling: false },
  ]

  let n = 0
  const ev = (calendarId: string, title: string, start: number, end: number, extra: Partial<DemoEvent> = {}): DemoEvent => ({
    id: `ev-${++n}`, calendarId, title, location: null, notes: null, start, end, allDay: false, repeat: "none",
    skipped: [], overrides: {}, until: null, attendees: [], organizer: null, reminders: [], uid: `demo-${n}@mailbird`, travel: null, timeZone: null, ...extra,
  })
  const priya = { name: "Priya Raman", email: "priya@studio.example" }
  const team = (status: string) => [
    { ...priya, status: "accepted" },
    { name: "Me", email: "me@studio.example", status },
  ]
  const events: DemoEvent[] = [
    ev("cal-work", "Standup", at(0, 9, 30), at(0, 9, 45), { repeat: "weekly", location: "Studio, room 2", reminders: [5] }),
    ev("cal-work", "Token audit review", at(0, 12), at(0, 13), {
      notes: "Walk through the semantic tier sheet. Decide on the three surface tokens that collapse in dark mode.\n\nJoin Zoom: https://us02web.zoom.us/j/81234567890?pwd=tok3ns",
      organizer: priya,
      attendees: [
        { ...priya, status: "accepted" },
        { name: "Me", email: "me@studio.example", status: "needs-action" },
        { name: "Sam Okafor", email: "sam@studio.example", status: "tentative" },
      ],
    }),
    ev("cal-personal", "Lunch with Ana", at(0, 12, 30), at(0, 13, 30), { location: "Café Lisboa" }),
    ev("cal-work", "Design review", at(1, 15), at(1, 16, 30), { location: "https://meet.google.com/kfp-wqzr-xmd", organizer: priya, attendees: team("accepted") }),
    ev("cal-personal", "Climbing", at(2, 18), at(2, 19, 30), { repeat: "weekly", location: "North Wall gym" }),
    ev("cal-personal", "Ferry to the cabin", at(untilSaturday, 8, 15), at(untilSaturday, 9), { location: "Pier 3", notes: "Booking reference FX-2210. Arrive 30 minutes early.", travel: 30 }),
    ev("cal-personal", "Cabin weekend", at(untilSaturday, 0), at(untilSaturday + 2, 0), { allDay: true }),
    ev("cal-holidays", "Bank holiday", at(9, 0), at(10, 0), { allDay: true }),
    ev("cal-work", "Quarterly planning", at(-2, 10), at(-2, 12), { organizer: priya, attendees: team("accepted") }),
    // `?counter`: a meeting you organize, which Sam asks to move (see the demo's mail).
    ...(new URLSearchParams(globalThis.location?.search ?? "").has("counter")
      ? [
          ev("cal-work", "Studio sync", at(3, 11), at(3, 12), {
            uid: "sync-1@mailbird",
            organizer: { name: "Me", email: "me@studio.example" },
            attendees: [
              { name: "Me", email: "me@studio.example", status: "accepted" },
              { name: "Sam Okafor", email: "sam@studio.example", status: "tentative" },
              { name: "Ana Duarte", email: "ana@example.com", status: "accepted" },
            ],
          }),
        ]
      : []),
  ]

  let c = 0
  const field = (value: string, label: string | null = null): ContactField => ({ label, value })
  const person = (bookId: string, fullName: string, extra: Partial<DemoContact> = {}): DemoContact => ({
    id: `ct-${++c}`, bookId, fullName, org: null, emails: [], phones: [], photo: null, title: null, note: null, birthday: null,
    labels: [], writable: true, ...extra,
  })
  const contacts: DemoContact[] = [
    person("book-work", "Priya Raman", { labels: ["Work"], org: "Studio", title: "Design systems lead", emails: [field("priya@studio.example", "work")], phones: [field("+1 555 010 4410", "cell")] }),
    person("book-personal", "Marcus Lee", { emails: [field("marcus@example.com", "home")], phones: [field("+1 555 010 7781", "cell")], birthday: "1990-" + String(new Date(at(5, 0) * 1000).getMonth() + 1).padStart(2, "0") + "-" + String(new Date(at(5, 0) * 1000).getDate()).padStart(2, "0"), note: "Board games, good coffee." }),
    person("book-personal", "Ana Duarte", { emails: [field("ana@example.com", "home")], org: "Lighthouse Studio", labels: ["Clay club", "Family"] }),
    person("book-work", "Ana D.", { emails: [field("ANA@example.com")], phones: [field("+351 912 345 678", "cell")] }),
    person("book-work", "Sam Okafor", { org: "Studio", title: "Engineer", emails: [field("sam@studio.example", "work")], labels: ["Work"] }),
    person("book-personal", "Lena Fischer", { emails: [field("lena@example.de")], phones: [field("+49 30 1234567", "home")], labels: ["Clay club"] }),
    person("book-personal", "Diego Alvarez", { emails: [field("diego@example.mx")] }),
    person("book-local", "Ferry Line", { org: "Ferry Line", emails: [field("no-reply@ferry.example")], phones: [field("+351 21 000 1234", "work")] }),
  ]

  const changed = () => emit("pim:changed")
  const calendar = (id: string) => {
    const col = collections.find((x) => x.id === id)
    if (!col) throw new Error("that calendar or address book is gone")
    return col
  }
  const writable = (id: string) => {
    const col = calendar(id)
    if (!col.writable) throw new Error(`“${col.name}” is read-only`)
    return col
  }
  const visible = (id: string) => !calendar(id).hidden
  const event = (id: string) => {
    const e = events.find((x) => x.id === id)
    if (!e) throw new Error("that event was deleted")
    return e
  }
  const contact = (id: string) => {
    const x = contacts.find((k) => k.id === id)
    if (!x) throw new Error("that contact was deleted")
    return x
  }
  const occurrence = (e: DemoEvent, o: Slot): Occurrence => ({
    eventId: e.id, calendarId: e.calendarId, title: o.title, location: o.location, start: o.start, end: o.end,
    originalStart: o.original, allDay: e.allDay, recurring: e.repeat !== "none", meetingUrl: meetingLink(o.location), contactId: null,
    travel: e.allDay ? null : e.travel,
  })

  // Birthdays: a yearly all-day occurrence per contact with a birthday.
  const birthdays = (from: number, to: number): Occurrence[] => {
    if (calendar(BIRTHDAYS).hidden) return []
    const out: Occurrence[] = []
    for (const x of contacts.filter((k) => k.birthday && visible(k.bookId))) {
      const m = /^(\d{4}|-)-?(\d{2})-(\d{2})$/.exec(x.birthday!.replace(/^--/, "-"))
      if (!m) continue
      const born = m[1] === "-" ? null : +m[1]!
      for (let y = new Date(from * 1000).getFullYear(); y <= new Date(to * 1000).getFullYear(); y++) {
        const start = secs(new Date(y, +m[2]! - 1, +m[3]!))
        const end = secs(new Date(y, +m[2]! - 1, +m[3]! + 1))
        if (start >= to || end <= from) continue
        out.push({
          eventId: `${BIRTHDAY}${x.id}`, calendarId: BIRTHDAYS, title: born && y > born ? `${x.fullName} turns ${y - born}` : `${x.fullName}’s birthday`,
          location: null, start, end, originalStart: start, allDay: true, recurring: true, meetingUrl: null, contactId: x.id,
        })
      }
    }
    return out
  }
  // Interesting calendars: holidays and moon phases from rules (ADR-0024).
  const catalog = (): InterestingCalendar[] => [
    ...HOLIDAY_COUNTRIES.map((c) => ({ id: holidayId(c.code), name: `Holidays in ${c.country}`, group: "holidays" as const, country: c.code, subscribed: collections.some((x) => x.id === holidayId(c.code)) })),
    { id: MOON, name: "Moon phases", group: "sky" as const, country: null, subscribed: collections.some((x) => x.id === MOON) },
  ]
  const interesting = (from: number, to: number): Occurrence[] =>
    collections
      .filter((c) => c.id.startsWith(INTERESTING) && !c.hidden)
      .flatMap((c) =>
        daysOf(c.id, from, to).map(([d, n, title]): Occurrence => {
          const start = localMidnight(d)
          return { eventId: `${SPECIAL}${c.id}|${dayKey(d)}|${n}`, calendarId: c.id, title, location: null, start, end: localMidnight(d, 1), originalStart: start, allDay: true, recurring: false, meetingUrl: null, contactId: null }
        }),
      )
      .filter((o) => o.start < to && o.end > from)
  const specialDetail = (id: string): EventDetail => {
    const [cal, day, n] = id.slice(SPECIAL.length).split("|")
    const d = parseDay(day ?? "")
    const col = collections.find((c) => c.id === cal)
    const o = col && interesting(localMidnight(d), localMidnight(d, 1)).find((x) => x.eventId === id)
    if (!col || !o || n == null) throw new Error("that calendar was removed")
    const country = HOLIDAY_COUNTRIES.find((c) => holidayId(c.code) === cal)?.country
    const at = moonPhases(o.start, o.end).find(([, p]) => p === o.title)?.[0]
    const notes =
      cal === MOON
        ? `${o.title} at ${new Date((at ?? o.start) * 1000).toTimeString().slice(0, 5)}.`
        : /\((observed|substitute day)\)$/.test(o.title)
          ? `The day off for a holiday that falls on a weekend, in ${country}. From ${col.name}.`
          : `A public holiday in ${country}. Regional holidays aren't included. From ${col.name}.`
    return { ...o, notes, repeat: "none", timeZone: null, organizer: null, attendees: [], url: null, writable: false, reminders: [] }
  }
  // Scheduling links (ADR-0026), on the device clock: free half hours inside
  // the link's hours, two hours out through its days ahead.
  let links: BookingLink[] = []
  const busyBetween = (from: number, to: number) =>
    events.filter((e) => visible(e.calendarId) && !e.allDay).flatMap((e) => expand(e, from, to).map((o) => [o.start - (e.travel ?? 0) * 60, o.end] as const))
  const freeSlots = (l: BookingLink) => {
    const GRID = 1800, len = l.minutes * 60
    const nowS = Math.floor(Date.now() / 1000)
    const from = Math.floor((nowS + 7200) / GRID) * GRID + GRID
    const until = from + l.daysAhead * 86_400
    const busy = busyBetween(from - 86_400, until + 86_400)
    const out: { start: number; end: number }[] = []
    for (let d = 0; d <= l.daysAhead; d++) {
      const day = new Date(from * 1000)
      day.setHours(0, 0, 0, 0)
      day.setDate(day.getDate() + d)
      if (l.weekdaysOnly && (day.getDay() === 0 || day.getDay() === 6)) continue
      const open = day.getTime() / 1000 + l.dayStart * 60
      const close = day.getTime() / 1000 + l.dayEnd * 60
      for (let at = Math.ceil(Math.max(open, from) / GRID) * GRID; at + len <= close && at < until; at += GRID) {
        if (!busy.some(([s, e]) => s < at + len && e > at)) out.push({ start: at, end: at + len })
      }
    }
    return out
  }
  const checkLink = (i: BookingLinkInput): BookingLinkInput => {
    const title = i.title.trim()
    if (!title) throw new Error("give the link a title, like “Intro call”")
    if (i.minutes < 10 || i.minutes > 240) throw new Error("meetings can be 10 minutes to 4 hours")
    if (i.dayEnd <= i.dayStart || i.dayEnd > 1440 || i.dayEnd - i.dayStart < i.minutes) throw new Error("the hours you offer need to fit one meeting")
    if (i.daysAhead < 1 || i.daysAhead > 14) throw new Error("people can book 1 to 14 days ahead")
    const c = collections.find((x) => x.id === i.calendarId)
    if (!c || !c.writable) throw new Error("pick a calendar you can add events to")
    return { ...i, title, note: i.note?.trim() || null }
  }
  const byToken = (token: string) => {
    const l = links.find((x) => x.token === token)
    if (!l) throw new Error("this booking link isn't active")
    return l
  }
  const HOST = "Me"
  const birthdayDetail = (id: string, start?: number | null): EventDetail => {
    const from = start != null ? start - 1 : Math.floor(Date.now() / 1000)
    const o = birthdays(from, from + 367 * 86_400).find((b) => b.eventId === id)
    if (!o) throw new Error("that contact's birthday was removed")
    return { ...o, notes: null, repeat: "yearly", timeZone: null, organizer: null, attendees: [], url: null, writable: false, reminders: [] }
  }

  const detail = (e: DemoEvent, start?: number | null): EventDetail => {
    const all = expand(e, start != null ? start - 86_400 : -Infinity, Infinity)
    const o = all.find((x) => x.start === start || x.original === start) ?? all[0] ?? { start: e.start, end: e.end, original: e.start, title: e.title, location: e.location }
    return {
      ...occurrence(e, o), meetingUrl: meetingLink(o.location, e.notes), notes: e.notes, repeat: e.repeat, timeZone: e.allDay ? null : e.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      organizer: e.organizer, attendees: e.attendees, url: null, writable: calendar(e.calendarId).writable, reminders: [...e.reminders].sort((a, b) => a - b),
    }
  }
  const me = (calendarId: string) => {
    const acct = calendar(calendarId).accountId
    return { name: "Me", email: acct === "work" ? "me@studio.example" : "me@personal.example" }
  }
  const parseTimes = (input: EventInput) => {
    if (!input.title.trim()) throw new Error("give the event a title")
    // Times in another zone are that zone's wall clock (the core does the same with TZID).
    const zone = !input.allDay && input.timeZone && input.timeZone !== Intl.DateTimeFormat().resolvedOptions().timeZone ? input.timeZone : null
    const at = (v: string) => (zone ? Math.floor(zonedDate(v.slice(0, 10), v.slice(11, 16), zone).getTime() / 1000) : parseLocal(v))
    const start = at(input.start)
    const end = at(input.end)
    if (end < start || (input.allDay && end === start)) throw new Error("the event ends before it starts")
    return { start, end }
  }
  const apply = (e: DemoEvent, input: EventInput) => {
    const { start, end } = parseTimes(input)
    if (input.attendees?.length && !calendar(input.calendarId).accountId) throw new Error("invitations need a calendar on a mail account")
    Object.assign(e, {
      calendarId: input.calendarId, title: input.title.trim(), location: input.location?.trim() || null,
      notes: input.notes?.trim() || null, start, end, allDay: input.allDay,
      repeat: input.repeat === "custom" ? e.repeat : input.repeat,
    })
    if (input.reminders) e.reminders = [...new Set(input.reminders)]
    e.timeZone = input.allDay ? null : input.timeZone || null
    if (input.allDay) e.travel = null
    else if (input.travel != null) {
      if (input.travel < 0 || input.travel > 1440) throw new Error("travel time is up to a day")
      e.travel = input.travel || null
    }
    if (input.attendees) {
      const organizer = me(input.calendarId)
      const prior = e.attendees
      e.organizer = input.attendees.length ? organizer : null
      e.attendees = input.attendees.length
        ? [{ ...organizer, status: "accepted" }, ...input.attendees.filter((a) => normEmail(a.email) !== organizer.email).map((a) => ({ name: a.name, email: a.email, status: prior.find((p) => normEmail(p.email) === normEmail(a.email))?.status ?? "needs-action" }))]
        : []
    }
    return e
  }
  const summary = ({ title: _t, note: _n, birthday: _b, writable: _w, ...s }: DemoContact): ContactSummary => s
  const cleanLabels = (list: string[]) => {
    const out: string[] = []
    for (const l of list.map((x) => x.trim().replace(/,/g, " ")).filter(Boolean)) if (!out.some((o) => o.toLowerCase() === l.toLowerCase())) out.push(l)
    return out
  }
  // Recently deleted: a copy of each card for 30 days, like the core's.
  const trash: (DeletedContact & { card: DemoContact })[] = []
  const toTrash = (x: DemoContact) =>
    trash.unshift({ id: `tr-${++c}`, bookId: x.bookId, fullName: x.fullName, emails: x.emails, deletedAt: Math.floor(Date.now() / 1000), card: structuredClone(x) })
  // Restore to a point in time: a snapshot before every contact change, like
  // the core's history (which records each card instead).
  let seq = 0
  const history: { seq: number; at: number; snap: DemoContact[] }[] = []
  const record = () => history.push({ seq: ++seq, at: Math.floor(Date.now() / 1000), snap: structuredClone(contacts) })
  const restorePlan = (point: { since?: number; after?: number }) => {
    const h = history.find((x) => (point.after != null ? x.seq > point.after : x.at >= (point.since ?? Infinity)))
    if (!h) return { added: [], edited: [], deleted: [], snap: [] as DemoContact[] }
    const same = (a: DemoContact, b: DemoContact) => JSON.stringify(a) === JSON.stringify(b)
    return {
      added: contacts.filter((x) => !h.snap.some((y) => y.id === x.id)),
      deleted: h.snap.filter((y) => !contacts.some((x) => x.id === y.id)),
      edited: h.snap.filter((y) => contacts.some((x) => x.id === y.id && !same(x, y))),
      snap: h.snap,
    }
  }
  // Smart groups; "in touch" asks the demo's mail who you've written with.
  let groups: SmartGroup[] = []
  let mailSince: (since: number) => Set<string> = () => new Set()
  const groupMatch = (r: SmartGroupInput) => {
    const seen = r.inTouchDays ? mailSince(Math.floor(Date.now() / 1000) - r.inTouchDays * 86_400) : null
    return (x: DemoContact) => {
      const emails = x.emails.map((e) => normEmail(e.value))
      return (
        (!r.labels.length || x.labels.some((l) => r.labels.some((w) => w.toLowerCase() === l.toLowerCase()))) &&
        (!r.company || (x.org ?? "").toLowerCase().includes(r.company.toLowerCase())) &&
        (!r.domain || emails.some((e) => { const h = e.split("@")[1] ?? ""; return h === r.domain || h.endsWith(`.${r.domain}`) })) &&
        (!r.hasPhone || x.phones.length > 0) &&
        (!r.hasBirthday || !!x.birthday) &&
        (!seen || emails.some((e) => seen.has(e)))
      )
    }
  }
  const checkGroup = (input: SmartGroupInput): SmartGroupInput => {
    const name = input.name.trim()
    if (!name) throw new Error("give the group a name")
    const labels = input.labels.map((l) => l.trim()).filter(Boolean)
    const company = input.company?.trim() || null
    const domain = input.domain?.trim().replace(/^@/, "").toLowerCase() || null
    if (domain && (!domain.includes(".") || /[@\s]/.test(domain))) throw new Error(`“${domain}” isn't a domain like example.com`)
    const inTouchDays = input.inTouchDays && input.inTouchDays > 0 ? input.inTouchDays : null
    if (!labels.length && !company && !domain && !input.hasPhone && !input.hasBirthday && !inTouchDays) {
      throw new Error("say who belongs in it: a label, a company, a domain, or one of the checks")
    }
    return { name, labels, company, domain, hasPhone: input.hasPhone, hasBirthday: input.hasBirthday, inTouchDays }
  }
  const counted = (g: SmartGroup): SmartGroup => ({ ...g, count: contacts.filter((x) => visible(x.bookId)).filter(groupMatch(g)).length })
  const vcardOf = (x: DemoContact, short = false) => {
    const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/[;,]/g, (m) => `\\${m}`).replace(/\n/g, "\\n")
    const parts = x.fullName.trim().split(/\s+/)
    const lines = ["BEGIN:VCARD", "VERSION:3.0", ...(short ? [] : [`UID:${x.id}`]), `FN:${esc(x.fullName)}`, `N:${esc(parts.length > 1 ? parts.at(-1)! : "")};${esc(parts.length > 1 ? parts.slice(0, -1).join(" ") : x.fullName)};;;`]
    for (const e of x.emails) lines.push(`EMAIL${e.label ? `;TYPE=${e.label.toUpperCase()}` : ""}:${e.value}`)
    for (const p of x.phones) lines.push(`TEL${p.label ? `;TYPE=${p.label.toUpperCase()}` : ""}:${p.value}`)
    if (x.org) lines.push(`ORG:${esc(x.org)}`)
    if (x.title) lines.push(`TITLE:${esc(x.title)}`)
    if (!short && x.note) lines.push(`NOTE:${esc(x.note)}`)
    if (!short && x.labels.length) lines.push(`CATEGORIES:${x.labels.map(esc).join(",")}`)
    lines.push("END:VCARD")
    return lines.join("\r\n") + "\r\n"
  }
  const sortKey = (x: DemoContact) => {
    // Companies file under their whole name; people under their family name.
    const parts = x.fullName.trim().split(/\s+/)
    const lead = parts.length > 1 && x.fullName !== x.org ? parts.at(-1)! : x.fullName
    return `${lead.toLowerCase()} ${x.fullName.toLowerCase()}`
  }
  const fromInput = (x: DemoContact, input: ContactInput) => {
    const clean = (l: ContactField[]) => l.filter((f) => f.value.trim()).map((f) => ({ label: f.label?.trim() || null, value: f.value.trim() }))
    if (!input.fullName.trim() && !clean(input.emails).length && !input.org?.trim()) throw new Error("give the contact a name, an email, or a company")
    Object.assign(x, {
      bookId: input.bookId, fullName: input.fullName.trim() || input.org?.trim() || clean(input.emails)[0]?.value || "",
      emails: clean(input.emails), phones: clean(input.phones), org: input.org?.trim() || null,
      title: input.title?.trim() || null, note: input.note?.trim() || null, birthday: input.birthday?.trim() || null,
      writable: calendar(input.bookId).writable,
    })
    if (input.labels) x.labels = cleanLabels(input.labels)
    // Like the core: JPEG, PNG, or WebP data URLs; "" removes the photo.
    if (input.photo === "") x.photo = null
    else if (input.photo != null) {
      if (!/^data:image\/(jpeg|png|webp);base64,/.test(input.photo)) throw new Error("that photo isn't a JPEG, PNG, or WebP image")
      if (input.photo.length > 200 * 1024) throw new Error("that photo is too large; pick a smaller one")
      x.photo = input.photo
    }
    return x
  }

  // `?missed`: pretend the standup's reminder came due while the app was closed.
  let missed: DueReminder[] = new URLSearchParams(globalThis.location?.search ?? "").has("missed")
    ? [{ eventId: events[0]!.id, title: events[0]!.title, location: events[0]!.location, start: at(0, 9, 30), fireAt: at(0, 9, 25) }]
    : []

  // Reminders: like the desktop worker, check every few seconds and fire
  // each once (never replaying ones from before the page loaded).
  let checked = Math.floor(Date.now() / 1000) - 60
  setInterval(() => {
    const until = Math.floor(Date.now() / 1000)
    const due: DueReminder[] = []
    for (const e of events.filter((x) => (x.reminders.length || x.travel) && visible(x.calendarId))) {
      const lead = Math.max(0, ...e.reminders, e.travel ?? 0) * 60
      for (const o of expand(e, checked, until + lead + 1)) {
        for (const m of e.reminders) {
          const fireAt = o.start - m * 60
          if (fireAt > checked && fireAt <= until) due.push({ eventId: e.id, title: o.title, location: o.location, start: o.start, fireAt })
        }
        // Time to leave, unless a reminder already fires right then (as the core does).
        if (e.travel && !e.allDay && !e.reminders.includes(e.travel)) {
          const fireAt = o.start - e.travel * 60
          if (fireAt > checked && fireAt <= until) due.push({ eventId: e.id, title: o.title, location: o.location, start: o.start, fireAt, leave: true })
        }
      }
    }
    checked = until
    due.sort((a, b) => a.fireAt - b.fireAt).forEach((r) => emit("reminder", r))
  }, 5000)

  /** Invitations: the demo's mail calls these for messages carrying one. */
  // Timed events in visible calendars overlapping a time, except the invitation's own copy.
  const conflicts = (start: number, end: number, skipUid: string) =>
    events
      .filter((e) => visible(e.calendarId) && !e.allDay && e.uid !== skipUid)
      .flatMap((e) => expand(e, start, end).map((o) => occurrence(e, o)))
      .filter((o) => o.start < end && o.end > start)
  const proposals = new Map<string, { start: number; end: number }>()
  const counterAnswers = new Map<string, "accepted" | "declined">()
  const inviteFor = (seed: DemoInviteSeed, myEmail: string): Invite => {
    const copy = events.find((e) => e.uid === seed.uid)
    if (seed.method === "counter") {
      const key = `${seed.uid}@${seed.start}`
      return {
        method: "counter", uid: seed.uid, title: seed.title, location: seed.location, start: seed.start, end: seed.end,
        allDay: false, recurring: false, organizer: seed.organizer, attendees: seed.attendees, myStatus: null,
        eventId: copy?.id ?? null, outdated: false, from: seed.attendees[0] ?? null, comment: seed.comment ?? null,
        currentStart: copy?.start ?? null, currentEnd: copy?.end ?? null,
        conflicts: conflicts(seed.start, seed.end, seed.uid), answered: counterAnswers.get(key) ?? null,
      }
    }
    const people = copy?.attendees ?? seed.attendees
    return {
      method: "request", uid: seed.uid, title: seed.title, location: seed.location, start: seed.start, end: seed.end,
      allDay: false, recurring: false, organizer: seed.organizer, attendees: people,
      myStatus: people.find((a) => normEmail(a.email) === normEmail(myEmail))?.status ?? null,
      eventId: copy?.id ?? null, outdated: false, from: null,
      conflicts: conflicts(seed.start, seed.end, seed.uid), proposed: proposals.get(seed.uid) ?? null,
    }
  }
  /** A guest's COUNTER, from the demo's mail. */
  const proposeFor = (seed: DemoInviteSeed, myEmail: string, start: number, end: number) => {
    if (end <= start) throw new Error("the new time ends before it starts")
    proposals.set(seed.uid, { start, end })
    return inviteFor(seed, myEmail)
  }
  /** The organizer's answer to a COUNTER: move the event (everyone's asked again) or keep it. */
  const answerCounter = (seed: DemoInviteSeed, myEmail: string, accept: boolean) => {
    const e = events.find((x) => x.uid === seed.uid)
    if (!e) throw new Error("this event isn't in your calendar")
    if (accept) {
      Object.assign(e, { start: seed.start, end: seed.end })
      const proposer = normEmail(seed.attendees[0]?.email ?? "")
      e.attendees = e.attendees.map((a) =>
        e.organizer && normEmail(a.email) === normEmail(e.organizer.email) ? a : { ...a, status: normEmail(a.email) === proposer ? "accepted" : "needs-action" },
      )
      changed()
    }
    counterAnswers.set(`${seed.uid}@${seed.start}`, accept ? "accepted" : "declined")
    return inviteFor(seed, myEmail)
  }

  // Find a time: free stretches on the device clock, at most two a day, on the half hour.
  const findTimes = ({ from, minutes, dayStart, dayEnd, weekdaysOnly, limit = 6 }: FindTimes): TimeSlot[] => {
    const len = minutes * 60
    if (minutes <= 0 || dayEnd <= dayStart || dayEnd > 1440 || (dayEnd - dayStart) * 60 < len) throw new Error("that length doesn't fit in the day")
    const grid = 1800
    const up = (t: number) => Math.ceil(t / grid) * grid
    const start = up(Math.max(from, Math.floor(Date.now() / 1000)))
    const busy = events
      .filter((e) => visible(e.calendarId) && !e.allDay)
      // Travel time before an event is busy too (ADR-0029).
      .flatMap((e) => expand(e, start, start + 15 * 86_400).map((o) => [o.start - (e.travel ?? 0) * 60, o.end] as const))
    const out: TimeSlot[] = []
    const day = new Date(start * 1000)
    day.setHours(0, 0, 0, 0)
    for (let i = 0; i < 14 && out.length < limit; i++, day.setDate(day.getDate() + 1)) {
      if (weekdaysOnly && (day.getDay() === 0 || day.getDay() === 6)) continue
      const open = secs(new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, dayStart))
      const close = secs(new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, dayEnd))
      let at = up(Math.max(open, start))
      let today = 0
      while (at + len <= close && today < 2 && out.length < limit) {
        const blocking = busy.filter(([s, e]) => s < at + len && e > at)
        if (blocking.length) at = up(Math.max(...blocking.map(([, e]) => e)))
        else {
          out.push({ start: at, end: at + len })
          today++
          at = up(at + Math.max(len, 7200))
        }
      }
    }
    return out
  }

  // Calendar sets: saved combinations of visible calendars.
  let sets: CalendarSet[] = []
  let n_sets = 0
  const respondTo = (seed: DemoInviteSeed, myEmail: string, response: InviteResponse, calendarId?: string | null): Invite => {
    let copy = events.find((e) => e.uid === seed.uid)
    if (!copy && response !== "declined") {
      const target = calendarId ? writable(calendarId) : collections.find((c) => c.kind === "calendar" && c.writable && c.accountId === "work")!
      copy = ev(target.id, seed.title, seed.start, seed.end, { location: seed.location, uid: seed.uid, organizer: seed.organizer, attendees: seed.attendees.map((a) => ({ ...a })) })
      events.push(copy)
    }
    if (copy) copy.attendees = copy.attendees.map((a) => (normEmail(a.email) === normEmail(myEmail) ? { ...a, status: response } : a))
    changed()
    return inviteFor(seed, myEmail)
  }

  /** Stable keys for note links: the event's UID, the contact's id (demo cards have no UID). */
  const noteLinks = {
    event: (id: string) => events.find((e) => e.id === id) ?? null,
    eventByUid: (uid: string) => events.find((e) => e.uid === uid)?.id ?? null,
    eventByTitle: (title: string) => events.find((e) => e.title === title) ?? null,
    contact: (id: string) => contacts.find((k) => k.id === id) ?? null,
    contactByName: (name: string) => contacts.find((k) => k.fullName === name) ?? null,
  }

  return {
    inviteFor,
    respondTo,
    proposeFor,
    answerCounter,
    findTimes: async (q: FindTimes) => later(findTimes(q)),
    calendarSets: async () => later(sets),
    saveCalendarSet: async (name: string) => {
      const n = name.trim()
      if (!n) throw new Error("give the set a name")
      const ids = collections.filter((c) => c.kind === "calendar" && !c.hidden).map((c) => c.id)
      if (!ids.length) throw new Error("show at least one calendar first")
      const had = sets.find((s) => s.name.toLowerCase() === n.toLowerCase())
      sets = had ? sets.map((s) => (s === had ? { ...s, calendarIds: ids } : s)) : [...sets, { id: `set-${++n_sets}`, name: n, calendarIds: ids }]
      return later(sets)
    },
    deleteCalendarSet: async (id: string) => {
      sets = sets.filter((s) => s.id !== id)
      return later(sets)
    },
    applyCalendarSet: async (id: string) => {
      const set = sets.find((s) => s.id === id)
      if (!set) throw new Error("that calendar set was deleted")
      for (const c of collections.filter((x) => x.kind === "calendar")) c.hidden = !set.calendarIds.includes(c.id)
      changed()
    },
    noteLinks,
    setTimeZone: async () => {},
    listCollections: (kind: Collection["kind"]) => later(collections.filter((x) => x.kind === kind)),
    setCollectionHidden: async (id: string, hidden: boolean) => {
      calendar(id).hidden = hidden
      changed()
    },
    listOccurrences: (from: number, to: number) => {
      const out = events
        .filter((e) => visible(e.calendarId))
        .flatMap((e) => expand(e, from, to).map((o) => occurrence(e, o)))
        .concat(birthdays(from, to))
        .concat(interesting(from, to))
        .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start - b.start || a.title.localeCompare(b.title))
      return later(out)
    },
    getEvent: async (id: string, start?: number | null) =>
      later(id.startsWith(BIRTHDAY) ? birthdayDetail(id, start) : id.startsWith(SPECIAL) ? specialDetail(id) : detail(event(id), start)),
    interestingCalendars: async () => later(catalog()),
    bookingLinks: async () => later(links),
    saveBookingLink: async (id: string | null, input: BookingLinkInput) => {
      const i = checkLink(input)
      if (id && !links.some((l) => l.id === id)) throw new Error("that booking link was deleted")
      const hex = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("")
      const l: BookingLink = id ? { ...links.find((x) => x.id === id)!, ...i } : { id: `bl-${++c}`, token: hex(), bookedAt: [], ...i }
      links = id ? links.map((x) => (x.id === id ? l : x)) : [...links, l]
      return later(l)
    },
    deleteBookingLink: async (id: string) => {
      links = links.filter((l) => l.id !== id)
    },
    publicBooking: async (token: string): Promise<PublicBooking> => {
      const l = byToken(token)
      return later({ title: l.title, minutes: l.minutes, host: HOST, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, note: l.note, slots: freeSlots(l) })
    },
    bookSlot: async (token: string, req: BookingRequest): Promise<Booked> => {
      const l = byToken(token)
      const name = req.name.trim(), email = req.email.trim().toLowerCase()
      if (!name) throw new Error("add your name")
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("that email address doesn't look right")
      const slot = freeSlots(l).find((t) => t.start === req.start)
      if (!slot) throw new Error("that time was just taken; pick another")
      const e = ev(l.calendarId, `${l.title} with ${name}`, slot.start, slot.end)
      e.notes = `Booked by ${name} <${email}> through “${l.title}”.${req.note?.trim() ? `\n\n${req.note.trim()}` : ""}`
      events.push(e)
      l.bookedAt.push(Math.floor(Date.now() / 1000))
      changed()
      return later({ start: slot.start, end: slot.end, title: l.title, host: HOST, invited: false })
    },
    addInterestingCalendar: async (id: string) => {
      const c = catalog().find((x) => x.id === id)
      if (!c) throw new Error("there's no such calendar to add")
      const color = id === MOON ? "#64748b" : HOLIDAY_COUNTRIES.find((x) => holidayId(x.code) === id)!.color
      if (!c.subscribed) collections.push({ id, accountId: null, kind: "calendar", name: c.name, color, writable: false, hidden: false, scheduling: false })
      changed()
    },
    removeInterestingCalendar: async (id: string) => {
      if (!id.startsWith(INTERESTING)) throw new Error("only added calendars can be removed here")
      const i = collections.findIndex((c) => c.id === id)
      if (i >= 0) collections.splice(i, 1)
      changed()
    },
    createEvent: async (input: EventInput) => {
      writable(input.calendarId)
      const e = apply(ev(input.calendarId, "", 0, 0), input)
      events.push(e)
      changed()
      return later(detail(e))
    },
    updateEvent: async (id: string, input: EventInput, scope: EditScope = "all", original?: number | null) => {
      const e = event(id)
      writable(e.calendarId)
      writable(input.calendarId)
      const series = e.repeat !== "none" && original != null
      if (series && scope === "this") {
        if (input.calendarId !== e.calendarId) throw new Error("one occurrence can't move to another calendar; move the whole series instead")
        const { start, end } = parseTimes(input)
        e.overrides[original] = { title: input.title.trim(), location: input.location?.trim() || null, start, end }
        changed()
        return later(detail(e, original))
      }
      if (series && scope === "following" && original > e.start) {
        // End this series before the slot; a new one takes over from there.
        const tail = apply(ev(input.calendarId, "", 0, 0), { ...input, repeat: input.repeat === "custom" ? e.repeat : input.repeat })
        tail.attendees = input.attendees ? tail.attendees : e.attendees
        tail.organizer = input.attendees ? tail.organizer : e.organizer
        tail.reminders = input.reminders ?? e.reminders
        e.until = original
        events.push(tail)
        changed()
        return later(detail(tail))
      }
      apply(e, input)
      changed()
      return later(detail(e))
    },
    deleteEvent: async (id: string, original?: number | null, scope?: EditScope) => {
      const e = event(id)
      writable(e.calendarId)
      const s = scope ?? (original != null ? "this" : "all")
      if (original != null && e.repeat !== "none" && s === "this") e.skipped.push(original)
      else if (original != null && e.repeat !== "none" && s === "following" && original > e.start) e.until = original
      else events.splice(events.indexOf(e), 1)
      changed()
    },
    eventGuests: async (id: string) => {
      const e = event(id)
      return later(e.attendees.filter((a) => !e.organizer || normEmail(a.email) !== normEmail(e.organizer.email)).map(({ name, email }) => ({ name, email })))
    },

    listContacts: (search?: string | null, label?: string | null, group?: string | null) => {
      const q = search?.trim().toLowerCase()
      const l = label?.trim().toLowerCase()
      const g = group ? groups.find((x) => x.id === group) : null
      if (group && !g) throw new Error("that smart group was deleted")
      const list = contacts
        .filter((x) => visible(x.bookId))
        .filter((x) => !g || groupMatch(g)(x))
        .filter((x) => !l || x.labels.some((y) => y.toLowerCase() === l))
        .filter((x) => !q || [x.fullName, x.org ?? "", ...x.emails.map((e) => e.value), ...x.phones.map((p) => p.value)].some((f) => f.toLowerCase().includes(q)))
        .sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
      return later(list.map(summary))
    },
    getContact: async (id: string) => later(contact(id)),
    takeMissedReminders: async () => {
      const out = missed
      missed = []
      return later(out)
    },
    /** Meetings with this contact a year either side of now; the demo's mail adds the threads. */
    contactMeetings: (id: string): Omit<ContactActivity, "threads"> => {
      const emails = contact(id).emails.map((e) => normEmail(e.value))
      const t = Math.floor(Date.now() / 1000)
      const all = events
        .filter((e) => visible(e.calendarId) && [e.organizer, ...e.attendees].some((a) => a && emails.includes(normEmail(a.email))))
        .flatMap((e) => expand(e, t - ACTIVITY_WINDOW, t + ACTIVITY_WINDOW).map((o) => occurrence(e, o)))
      return {
        upcoming: all.filter((o) => o.end > t).sort((a, b) => a.start - b.start).slice(0, 3),
        past: all.filter((o) => o.end <= t).sort((a, b) => b.start - a.start).slice(0, 3),
      }
    },
    createContact: async (input: ContactInput) => {
      writable(input.bookId)
      record()
      const x = fromInput(person(input.bookId, ""), input)
      contacts.push(x)
      changed()
      return later(x)
    },
    updateContact: async (id: string, input: ContactInput) => {
      const x = contact(id)
      writable(x.bookId)
      writable(input.bookId)
      record()
      fromInput(x, input)
      changed()
      return later(x)
    },
    deleteContact: async (id: string) => {
      const x = contact(id)
      writable(x.bookId)
      record()
      toTrash(x)
      contacts.splice(contacts.indexOf(x), 1)
      changed()
    },
    contactCopies: async (id: string) => {
      const me = contact(id)
      const emails = me.emails.map((e) => normEmail(e.value))
      const phones = me.phones.map((p) => normPhone(p.value)).filter((p) => p.length >= 7)
      return later(
        contacts
          .filter((k) => k.id !== me.id && k.bookId !== me.bookId && visible(k.bookId))
          .filter((k) => k.emails.some((e) => emails.includes(normEmail(e.value))) || k.phones.some((p) => phones.includes(normPhone(p.value))))
          .map((k) => ({ id: k.id, bookId: k.bookId, fullName: k.fullName })),
      )
    },
    contactPhotos: async () => {
      const out: Record<string, string> = {}
      for (const k of contacts.filter((x) => x.photo && visible(x.bookId))) for (const e of k.emails) out[normEmail(e.value)] ??= k.photo!
      return later(out)
    },
    contactLabels: async () => {
      const counts = new Map<string, ContactLabel>()
      for (const x of contacts.filter((k) => visible(k.bookId))) {
        for (const l of x.labels) {
          const k = l.toLowerCase()
          const had = counts.get(k)
          counts.set(k, { name: had && had.name < l ? had.name : l, count: (had?.count ?? 0) + 1 })
        }
      }
      return later([...counts.values()].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())))
    },
    smartGroups: async () => later(groups.map(counted)),
    saveSmartGroup: async (id: string | null, input: SmartGroupInput) => {
      const rule = checkGroup(input)
      if (id && !groups.some((g) => g.id === id)) throw new Error("that smart group was deleted")
      const g: SmartGroup = { id: id ?? `sg-${++c}`, ...rule, count: 0 }
      groups = id ? groups.map((x) => (x.id === id ? g : x)) : [...groups, g]
      changed()
      return later(counted(g))
    },
    deleteSmartGroup: async (id: string) => {
      groups = groups.filter((g) => g.id !== id)
      changed()
    },
    contactsRestorePreview: async (point: { since?: number; after?: number }): Promise<ContactsRestore> => {
      const p = restorePlan(point)
      const names = (l: DemoContact[]) => l.map((x) => x.fullName).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
      return later({ added: names(p.added), edited: names(p.edited), deleted: names(p.deleted), readOnly: 0 })
    },
    restoreContacts: async (point: { since?: number; after?: number }): Promise<ContactsRestored> => {
      const p = restorePlan(point)
      const mark = seq
      record()
      for (const x of p.added) {
        toTrash(x)
        contacts.splice(contacts.indexOf(x), 1)
      }
      for (const y of p.edited) Object.assign(contacts.find((x) => x.id === y.id)!, structuredClone(y))
      for (const y of p.deleted) {
        contacts.push(structuredClone(y))
        trash.splice(0, trash.length, ...trash.filter((t) => t.card.id !== y.id))
      }
      changed()
      return later({ changed: p.added.length + p.edited.length + p.deleted.length, mark })
    },
    /** The demo's mail tells smart groups who you've exchanged mail with. */
    setMailSource: (fn: (since: number) => Set<string>) => void (mailSince = fn),
    deletedContacts: async () => {
      const cutoff = Math.floor(Date.now() / 1000) - 30 * 86_400
      trash.splice(0, trash.length, ...trash.filter((t) => t.deletedAt >= cutoff))
      return later(trash.map(({ card: _c, ...t }) => t))
    },
    restoreContact: async (id: string) => {
      const t = trash.find((x) => x.id === id)
      if (!t) throw new Error("that contact is no longer in Recently deleted")
      const book = collections.find((b) => b.id === t.bookId && b.writable) ?? collections.find((b) => b.kind === "contacts" && !b.accountId)!
      const x = { ...t.card, bookId: book.id, writable: true }
      record()
      if (!contacts.some((k) => k.id === x.id)) contacts.push(x)
      trash.splice(trash.indexOf(t), 1)
      changed()
      return later(x)
    },
    contactVcard: async (id: string) => {
      const x = contact(id)
      const stem = x.fullName.replace(/[/\\:*?"<>|]/g, "-").trim().slice(0, 80) || "contact"
      return later({ fileName: `${stem}.vcf`, vcf: vcardOf(x) })
    },
    contactQr: async (id: string) => {
      const { renderSVG } = await import("uqr")
      return later(renderSVG(vcardOf(contact(id), true), { ecc: "M", border: 2 }))
    },
    /** The demo's mail calls this with a card read from a message's signature. */
    suggestFor: (email: string, name: string | null, card: SignatureCard): ContactSuggestion | null => {
      const e = normEmail(email)
      const key = (n: string) => n.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").trim().replace(/\s+/g, " ")
      if (!card.emails.some((x) => normEmail(x.value) === e)) card.emails.unshift({ label: null, value: email })
      const named = name && key(name).includes(" ") ? contacts.filter((k) => key(k.fullName) === key(name)) : []
      const have = contacts.find((k) => k.emails.some((x) => normEmail(x.value) === e)) ?? (named.length === 1 ? named[0] : undefined)
      if (!have) return { contactId: null, card, adds: ["contact", ...(card.phones.length ? ["phone"] : []), ...(card.title ? ["title"] : []), ...(card.org ? ["company"] : [])] }
      if (!have.writable) return null
      const adds: string[] = []
      const merged: SignatureCard = { fullName: have.fullName, org: have.org, title: have.title, emails: [...have.emails], phones: [...have.phones] }
      const phones = card.phones.filter((p) => !have.phones.some((h) => normPhone(h.value) === normPhone(p.value)))
      if (phones.length) {
        adds.push(phones.length === 1 ? "phone" : "phones")
        merged.phones.push(...phones)
      }
      const emails = card.emails.filter((x) => !have.emails.some((h) => normEmail(h.value) === normEmail(x.value)))
      if (emails.length) {
        adds.push("email")
        merged.emails.push(...emails)
      }
      if (!merged.title && card.title) {
        adds.push("title")
        merged.title = card.title
      }
      if (!merged.org && card.org) {
        adds.push("company")
        merged.org = card.org
      }
      return adds.length ? { contactId: have.id, card: merged, adds } : null
    },
    parseSignature: async (text: string) => later(parseSignature(text)),
    duplicateContacts: () => {
      const list = contacts.filter((x) => visible(x.bookId))
      const parent = list.map((_, i) => i)
      const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)))
      const seen = new Map<string, number>()
      list.forEach((x, i) => {
        const name = x.fullName.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").trim().replace(/\s+/g, " ")
        const keys = [
          ...x.emails.map((e) => `e:${normEmail(e.value)}`),
          ...x.phones.map((p) => normPhone(p.value)).filter((p) => p.length >= 7).map((p) => `p:${p}`),
          ...(name.includes(" ") ? [`n:${name}`] : []),
        ]
        for (const k of keys) {
          const j = seen.get(k)
          if (j === undefined) seen.set(k, i)
          else parent[find(i)] = find(j)
        }
      })
      const groups = new Map<number, ContactSummary[]>()
      list.forEach((x, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), summary(x)]))
      return later([...groups.values()].filter((g) => g.length > 1))
    },
    mergeContacts: async (primary: string, others: string[]) => {
      const p = contact(primary)
      writable(p.bookId)
      record()
      for (const id of others.filter((o) => o !== primary)) {
        const o = contact(id)
        writable(o.bookId)
        for (const e of o.emails) if (!p.emails.some((x) => normEmail(x.value) === normEmail(e.value))) p.emails.push(e)
        for (const ph of o.phones) if (!p.phones.some((x) => normPhone(x.value) === normPhone(ph.value))) p.phones.push(ph)
        p.org ??= o.org
        p.title ??= o.title
        p.note ??= o.note
        p.birthday ??= o.birthday
        p.photo ??= o.photo
        p.labels = cleanLabels([...p.labels, ...o.labels])
        toTrash(o)
        contacts.splice(contacts.indexOf(o), 1)
      }
      changed()
      return later(p)
    },
    suggestRecipients: async (prefix: string) => {
      const q = prefix.trim().toLowerCase()
      if (!q) return []
      const out: Address[] = []
      for (const x of contacts) {
        for (const e of x.emails) {
          if (x.fullName.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) || e.value.toLowerCase().startsWith(q)) out.push({ name: x.fullName, email: e.value })
        }
      }
      return later(out.slice(0, 8))
    },
    syncPimNow: () => later(undefined),
  }
}
