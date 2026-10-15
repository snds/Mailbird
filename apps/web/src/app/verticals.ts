import { type IconName } from "@unicron/ui"

export type VerticalId = "mail" | "calendar" | "contacts" | "notes"

export interface Vertical {
  id: VerticalId
  label: string
  icon: IconName
  /** Tailwind text color utility bound to the vertical's semantic accent token. */
  accent: string
  /** Primary create action for this vertical (FAB on mobile, button on desktop). */
  create: { label: string; icon: IconName }
}

export const VERTICALS: Vertical[] = [
  { id: "mail", label: "Mail", icon: "inbox", accent: "text-vertical-mail", create: { label: "Compose", icon: "edit_square" } },
  { id: "calendar", label: "Calendar", icon: "calendar_month", accent: "text-vertical-calendar", create: { label: "New event", icon: "event" } },
  { id: "contacts", label: "Contacts", icon: "contacts", accent: "text-vertical-contacts", create: { label: "New contact", icon: "person_add" } },
  { id: "notes", label: "Notes", icon: "stylus_note", accent: "text-vertical-notes", create: { label: "New note", icon: "note_add" } },
]
