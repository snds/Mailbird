// Placeholder data until the Rust core (packages/core) exposes real accounts.

export interface Message {
  id: string
  from: string
  email: string
  subject: string
  preview: string
  body: string
  time: string
  unread: boolean
  starred?: boolean
  account: "Personal" | "Work"
}

export interface CalendarEvent {
  id: string
  title: string
  day: string
  start: string
  end: string
  location?: string
  calendar: "Personal" | "Work" | "Family"
}

export interface Contact {
  id: string
  name: string
  email: string
  phone?: string
  company?: string
  source: "iCloud" | "Google" | "Local"
}

export interface Note {
  id: string
  title: string
  body: string
  updated: string
  pinned?: boolean
  tags: string[]
}

export const messages: Message[] = [
  { id: "m1", from: "Priya Raman", email: "priya@studio.example", subject: "Token audit — round two", preview: "I pulled the semantic tier into a single sheet so we can see where the aliases drift…", body: "Hi,\n\nI pulled the semantic tier into a single sheet so we can see where the aliases drift from the primitives. Three of the surface tokens resolve to the same value in dark mode, which is probably why the list pane feels flat.\n\nCan we review Thursday?\n\nPriya", time: "9:41", unread: true, starred: true, account: "Work" },
  { id: "m2", from: "Ferry Line", email: "no-reply@ferry.example", subject: "Your booking is confirmed", preview: "Saturday 08:15 crossing, vehicle under 5 m, two passengers.", body: "Saturday 08:15 crossing, vehicle under 5 m, two passengers. Arrive 30 minutes before departure.", time: "8:02", unread: true, account: "Personal" },
  { id: "m3", from: "Marcus Lee", email: "marcus@example.com", subject: "Re: Cabin weekend", preview: "Count me in. I'll bring the board games and the good coffee.", body: "Count me in. I'll bring the board games and the good coffee.\n\n— M", time: "Yesterday", unread: false, account: "Personal" },
  { id: "m4", from: "Design Systems Weekly", email: "digest@dsweekly.example", subject: "Issue 212: Variable fonts in production", preview: "This week: shipping icon fonts with live axes, plus a look at density modes.", body: "This week: shipping icon fonts with live axes, plus a look at density modes.", time: "Mon", unread: false, account: "Personal" },
  { id: "m5", from: "Ana Duarte", email: "ana@example.com", subject: "Photos from the trip", preview: "Finally sorted them. Shared album link inside — the lighthouse ones came out great.", body: "Finally sorted them. Shared album link inside — the lighthouse ones came out great.", time: "Sun", unread: false, starred: true, account: "Personal" },
]

export const events: CalendarEvent[] = [
  { id: "e1", title: "Design review", day: "Today", start: "10:00", end: "11:00", location: "Studio B", calendar: "Work" },
  { id: "e2", title: "Lunch with Marcus", day: "Today", start: "12:30", end: "13:30", location: "Tartine", calendar: "Personal" },
  { id: "e3", title: "Token audit sync", day: "Thursday", start: "14:00", end: "14:45", calendar: "Work" },
  { id: "e4", title: "Ferry to the island", day: "Saturday", start: "08:15", end: "09:30", location: "Pier 3", calendar: "Family" },
]

export const contacts: Contact[] = [
  { id: "c1", name: "Ana Duarte", email: "ana@example.com", phone: "+1 555 0101", source: "iCloud" },
  { id: "c2", name: "Marcus Lee", email: "marcus@example.com", phone: "+1 555 0144", source: "Google" },
  { id: "c3", name: "Priya Raman", email: "priya@studio.example", company: "Studio", source: "Google" },
  { id: "c4", name: "Sam Okafor", email: "sam@example.com", source: "Local" },
]

export const notes: Note[] = [
  { id: "n1", title: "Cabin packing list", body: "☐ Board games\n☐ Coffee + grinder\n☐ Rain jackets\n☐ Ferry tickets (in Mail)", updated: "Today", pinned: true, tags: ["trip"] },
  { id: "n2", title: "Icon axis ideas", body: "Fill animates on selection. Grade drops in dark mode. Optical size follows the rendered px size.", updated: "Yesterday", tags: ["design"] },
  { id: "n3", title: "Design review agenda", body: "1. Token drift\n2. List density\n3. Mobile tab bar labels", updated: "Mon", tags: ["work"] },
]
