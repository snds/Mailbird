import { type IconName } from "@unicron/ui"

export type VerticalId = "mail" | "calendar" | "contacts" | "notes"

export interface Vertical {
  id: VerticalId
  label: string
  icon: IconName
  /** Primary create action for this vertical (FAB on mobile, button on desktop). */
  create: { label: string; icon: IconName }
}

export const VERTICALS: Vertical[] = [
  { id: "mail", label: "Mail", icon: "email", create: { label: "Compose", icon: "edit" } },
  { id: "calendar", label: "Calendar", icon: "calendar", create: { label: "New event", icon: "add" } },
  { id: "contacts", label: "Contacts", icon: "user--multiple", create: { label: "New contact", icon: "add" } },
  { id: "notes", label: "Notes", icon: "notebook", create: { label: "New note", icon: "add" } },
]
