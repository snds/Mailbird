// Placeholder data for notes until their core phase lands. Mail, calendar,
// and contacts come from the core (src/core), or its demo transport on the web.

export interface Note {
  id: string
  title: string
  body: string
  updated: string
  pinned?: boolean
  tags: string[]
}

export const notes: Note[] = [
  { id: "n1", title: "Cabin packing list", body: "☐ Board games\n☐ Coffee + grinder\n☐ Rain jackets\n☐ Ferry tickets (in Mail)", updated: "Today", pinned: true, tags: ["trip"] },
  { id: "n2", title: "Icon axis ideas", body: "Fill animates on selection. Grade drops in dark mode. Optical size follows the rendered px size.", updated: "Yesterday", tags: ["design"] },
  { id: "n3", title: "Design review agenda", body: "1. Token drift\n2. List density\n3. Mobile tab bar labels", updated: "Mon", tags: ["work"] },
]
