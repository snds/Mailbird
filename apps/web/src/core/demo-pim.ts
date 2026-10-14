// In-memory calendars and contacts for the web demo. Follows the core's
// rules where they matter to the UI (series expansion, skipped dates,
// read-only collections, duplicate grouping, merges) on the device clock;
// the Rust core does the real iCalendar and time-zone work.

import type {
  Address,
  Collection,
  ContactDetail,
  ContactField,
  ContactInput,
  ContactSummary,
  EventDetail,
  EventInput,
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
  attendees: EventDetail["attendees"]
  organizer: Address | null
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

function expand(e: DemoEvent, from: number, to: number): { start: number; end: number }[] {
  const len = e.end - e.start
  if (e.repeat === "none" || e.repeat === "custom") return e.start < to && e.end > from ? [{ start: e.start, end: e.end }] : []
  const out = []
  for (let i = 0; i < 5000; i++) {
    const start = step(e.start, e.repeat, i)
    if (start >= to) break
    if (start + len > from && !e.skipped.includes(start)) out.push({ start, end: start + len })
  }
  return out
}

const normEmail = (e: string) => e.trim().toLowerCase()
const normPhone = (p: string) => p.replace(/\D/g, "").slice(-10)

export function createDemoPim(emit: (event: "pim:changed") => void, later: <T>(v: T) => Promise<T>) {
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
    { id: "cal-personal", accountId: "personal", kind: "calendar", name: "Personal", color: "#e05a47", writable: true, hidden: false },
    { id: "cal-work", accountId: "work", kind: "calendar", name: "Work", color: "#2563eb", writable: true, hidden: false },
    { id: "cal-holidays", accountId: "personal", kind: "calendar", name: "Holidays", color: "#16a34a", writable: false, hidden: false },
    { id: "cal-local", accountId: null, kind: "calendar", name: "On this device", color: null, writable: true, hidden: false },
    { id: "book-personal", accountId: "personal", kind: "contacts", name: "Personal", color: null, writable: true, hidden: false },
    { id: "book-work", accountId: "work", kind: "contacts", name: "Work", color: null, writable: true, hidden: false },
    { id: "book-local", accountId: null, kind: "contacts", name: "On this device", color: null, writable: true, hidden: false },
  ]

  let n = 0
  const ev = (calendarId: string, title: string, start: number, end: number, extra: Partial<DemoEvent> = {}): DemoEvent => ({
    id: `ev-${++n}`, calendarId, title, location: null, notes: null, start, end, allDay: false, repeat: "none",
    skipped: [], attendees: [], organizer: null, ...extra,
  })
  const priya = { name: "Priya Raman", email: "priya@studio.example" }
  const events: DemoEvent[] = [
    ev("cal-work", "Standup", at(0, 9, 30), at(0, 9, 45), { repeat: "weekly", location: "Studio, room 2" }),
    ev("cal-work", "Token audit review", at(0, 12), at(0, 13), {
      notes: "Walk through the semantic tier sheet. Decide on the three surface tokens that collapse in dark mode.",
      organizer: priya,
      attendees: [
        { ...priya, status: "accepted" },
        { name: "Me", email: "me@studio.example", status: "needs-action" },
        { name: "Sam Okafor", email: "sam@studio.example", status: "tentative" },
      ],
    }),
    ev("cal-personal", "Lunch with Ana", at(0, 12, 30), at(0, 13, 30), { location: "Café Lisboa" }),
    ev("cal-work", "Design review", at(1, 15), at(1, 16, 30), { location: "Video call" }),
    ev("cal-personal", "Climbing", at(2, 18), at(2, 19, 30), { repeat: "weekly", location: "North Wall gym" }),
    ev("cal-personal", "Ferry to the cabin", at(untilSaturday, 8, 15), at(untilSaturday, 9), { location: "Pier 3", notes: "Booking reference FX-2210. Arrive 30 minutes early." }),
    ev("cal-personal", "Cabin weekend", at(untilSaturday, 0), at(untilSaturday + 2, 0), { allDay: true }),
    ev("cal-personal", "Marcus’s birthday", at(5, 0), at(6, 0), { allDay: true, repeat: "yearly" }),
    ev("cal-holidays", "Bank holiday", at(9, 0), at(10, 0), { allDay: true }),
    ev("cal-work", "Quarterly planning", at(-2, 10), at(-2, 12)),
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
  const occurrence = (e: DemoEvent, o: { start: number; end: number }): Occurrence => ({
    eventId: e.id, calendarId: e.calendarId, title: e.title, location: e.location, start: o.start, end: o.end,
    allDay: e.allDay, recurring: e.repeat !== "none",
  })
  const detail = (e: DemoEvent, start?: number | null): EventDetail => {
    const all = expand(e, start != null ? start - 1 : -Infinity, Infinity)
    const o = all.find((x) => x.start === start) ?? all[0] ?? { start: e.start, end: e.end }
    return {
      ...occurrence(e, o), notes: e.notes, repeat: e.repeat, timeZone: e.allDay ? null : Intl.DateTimeFormat().resolvedOptions().timeZone,
      organizer: e.organizer, attendees: e.attendees, url: null, writable: calendar(e.calendarId).writable,
    }
  }
  const apply = (e: DemoEvent, input: EventInput) => {
    if (!input.title.trim()) throw new Error("give the event a title")
    const start = parseLocal(input.start)
    const end = parseLocal(input.end)
    if (end < start || (input.allDay && end === start)) throw new Error("the event ends before it starts")
    Object.assign(e, {
      calendarId: input.calendarId, title: input.title.trim(), location: input.location?.trim() || null,
      notes: input.notes?.trim() || null, start, end, allDay: input.allDay,
      repeat: input.repeat === "custom" ? e.repeat : input.repeat,
    })
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

  return {
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
        .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start - b.start || a.title.localeCompare(b.title))
      return later(out)
    },
    getEvent: async (id: string, start?: number | null) => later(detail(event(id), start)),
    createEvent: async (input: EventInput) => {
      writable(input.calendarId)
      const e = apply(ev(input.calendarId, "", 0, 0), input)
      events.push(e)
      changed()
      return later(detail(e))
    },
    updateEvent: async (id: string, input: EventInput) => {
      const e = event(id)
      writable(e.calendarId)
      writable(input.calendarId)
      apply(e, input)
      changed()
      return later(detail(e))
    },
    deleteEvent: async (id: string, occurrenceStart?: number | null) => {
      const e = event(id)
      writable(e.calendarId)
      if (occurrenceStart != null && e.repeat !== "none") e.skipped.push(occurrenceStart)
      else events.splice(events.indexOf(e), 1)
      changed()
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
