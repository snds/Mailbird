// In-memory calendars and contacts for the web demo. Follows the core's
// rules where they matter to the UI (series expansion, skipped dates,
// read-only collections, duplicate grouping, merges) on the device clock;
// the Rust core does the real iCalendar and time-zone work.

import type { CoreEvent } from "./client"
import type {
  Address,
  Attendee,
  Collection,
  ContactActivity,
  ContactDetail,
  ContactField,
  ContactInput,
  ContactSummary,
  DueReminder,
  EditScope,
  EventDetail,
  EventInput,
  Invite,
  InviteResponse,
  Occurrence,
  Repeat,
} from "./types"

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
}

/** A demo message's invitation, as the organizer sent it. */
export interface DemoInviteSeed {
  uid: string
  title: string
  location: string | null
  start: number
  end: number
  organizer: Address
  attendees: Attendee[]
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
    skipped: [], overrides: {}, until: null, attendees: [], organizer: null, reminders: [], uid: `demo-${n}@mailbird`, ...extra,
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
    ev("cal-personal", "Ferry to the cabin", at(untilSaturday, 8, 15), at(untilSaturday, 9), { location: "Pier 3", notes: "Booking reference FX-2210. Arrive 30 minutes early." }),
    ev("cal-personal", "Cabin weekend", at(untilSaturday, 0), at(untilSaturday + 2, 0), { allDay: true }),
    ev("cal-holidays", "Bank holiday", at(9, 0), at(10, 0), { allDay: true }),
    ev("cal-work", "Quarterly planning", at(-2, 10), at(-2, 12), { organizer: priya, attendees: team("accepted") }),
  ]

  let c = 0
  const field = (value: string, label: string | null = null): ContactField => ({ label, value })
  const person = (bookId: string, fullName: string, extra: Partial<DemoContact> = {}): DemoContact => ({
    id: `ct-${++c}`, bookId, fullName, org: null, emails: [], phones: [], photo: null, title: null, note: null, birthday: null,
    writable: true, ...extra,
  })
  const contacts: DemoContact[] = [
    person("book-work", "Priya Raman", { org: "Studio", title: "Design systems lead", emails: [field("priya@studio.example", "work")], phones: [field("+1 555 010 4410", "cell")] }),
    person("book-personal", "Marcus Lee", { emails: [field("marcus@example.com", "home")], phones: [field("+1 555 010 7781", "cell")], birthday: "1990-" + String(new Date(at(5, 0) * 1000).getMonth() + 1).padStart(2, "0") + "-" + String(new Date(at(5, 0) * 1000).getDate()).padStart(2, "0"), note: "Board games, good coffee." }),
    person("book-personal", "Ana Duarte", { emails: [field("ana@example.com", "home")], org: "Lighthouse Studio" }),
    person("book-work", "Ana D.", { emails: [field("ANA@example.com")], phones: [field("+351 912 345 678", "cell")] }),
    person("book-work", "Sam Okafor", { org: "Studio", title: "Engineer", emails: [field("sam@studio.example", "work")] }),
    person("book-personal", "Lena Fischer", { emails: [field("lena@example.de")], phones: [field("+49 30 1234567", "home")] }),
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
      ...occurrence(e, o), meetingUrl: meetingLink(o.location, e.notes), notes: e.notes, repeat: e.repeat, timeZone: e.allDay ? null : Intl.DateTimeFormat().resolvedOptions().timeZone,
      organizer: e.organizer, attendees: e.attendees, url: null, writable: calendar(e.calendarId).writable, reminders: [...e.reminders].sort((a, b) => a - b),
    }
  }
  const me = (calendarId: string) => {
    const acct = calendar(calendarId).accountId
    return { name: "Me", email: acct === "work" ? "me@studio.example" : "me@personal.example" }
  }
  const parseTimes = (input: EventInput) => {
    if (!input.title.trim()) throw new Error("give the event a title")
    const start = parseLocal(input.start)
    const end = parseLocal(input.end)
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
    for (const e of events.filter((x) => x.reminders.length && visible(x.calendarId))) {
      const lead = Math.max(...e.reminders) * 60
      for (const o of expand(e, checked, until + lead + 1)) {
        for (const m of e.reminders) {
          const fireAt = o.start - m * 60
          if (fireAt > checked && fireAt <= until) due.push({ eventId: e.id, title: o.title, location: o.location, start: o.start, fireAt })
        }
      }
    }
    checked = until
    due.sort((a, b) => a.fireAt - b.fireAt).forEach((r) => emit("reminder", r))
  }, 5000)

  /** Invitations: the demo's mail calls these for messages carrying one. */
  const inviteFor = (seed: DemoInviteSeed, myEmail: string): Invite => {
    const copy = events.find((e) => e.uid === seed.uid)
    const people = copy?.attendees ?? seed.attendees
    return {
      method: "request", uid: seed.uid, title: seed.title, location: seed.location, start: seed.start, end: seed.end,
      allDay: false, recurring: false, organizer: seed.organizer, attendees: people,
      myStatus: people.find((a) => normEmail(a.email) === normEmail(myEmail))?.status ?? null,
      eventId: copy?.id ?? null, outdated: false, from: null,
    }
  }
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
        .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start - b.start || a.title.localeCompare(b.title))
      return later(out)
    },
    getEvent: async (id: string, start?: number | null) => later(id.startsWith(BIRTHDAY) ? birthdayDetail(id, start) : detail(event(id), start)),
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

    listContacts: (search?: string | null) => {
      const q = search?.trim().toLowerCase()
      const list = contacts
        .filter((x) => visible(x.bookId))
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
      const x = fromInput(person(input.bookId, ""), input)
      contacts.push(x)
      changed()
      return later(x)
    },
    updateContact: async (id: string, input: ContactInput) => {
      const x = contact(id)
      writable(x.bookId)
      writable(input.bookId)
      fromInput(x, input)
      changed()
      return later(x)
    },
    deleteContact: async (id: string) => {
      const x = contact(id)
      writable(x.bookId)
      contacts.splice(contacts.indexOf(x), 1)
      changed()
    },
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
