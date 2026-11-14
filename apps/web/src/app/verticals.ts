import { type IconName } from "@unicron/ui"

export type VerticalId = "mail" | "calendar" | "contacts" | "notes"

export interface Vertical {
  id: VerticalId
  label: string
  icon: IconName
  /** The section's create action: the sidebar's button and the phone's create button. */
  create: { label: string; icon: IconName }
  /** The same action as quick create names it, where every kind is listed together. */
  quick: string
  /** A detail column with nothing open: "Pick a … to see it here." */
  pick: string
}

export const VERTICALS: Vertical[] = [
  { id: "mail", label: "Mail", icon: "email", create: { label: "Compose", icon: "edit" }, quick: "New message", pick: "Pick a conversation to see it here." },
  { id: "calendar", label: "Calendar", icon: "calendar", create: { label: "New event", icon: "add" }, quick: "New event", pick: "Pick an event to see it here." },
  { id: "contacts", label: "Contacts", icon: "user--multiple", create: { label: "New contact", icon: "add" }, quick: "New contact", pick: "Pick a person to see them here." },
  { id: "notes", label: "Notes", icon: "notebook", create: { label: "New note", icon: "add" }, quick: "New note", pick: "Pick a note to see it here." },
]

export const vertical = (id: VerticalId) => VERTICALS.find((v) => v.id === id)!
