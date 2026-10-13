// Placeholder data for calendar, contacts, and notes until their core phases
// land. Mail comes from the core (src/core), or its demo transport on the web.

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
