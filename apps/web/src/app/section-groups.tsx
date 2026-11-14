import { isMember } from "@/core/client"
import { CalendarNav } from "@/features/calendar/calendar-nav"
import { ContactsNav } from "@/features/contacts/contacts-nav"
import { MailNav } from "@/features/mail/mail-nav"
import { NotesNav } from "@/features/notes/notes-nav"

import type { VerticalId } from "./verticals"

/**
 * The open section's own groups in the sidebar, under APPS (ADR-0084; brief
 * X1): mail folders and accounts, calendars, contact groups, note folders and
 * tags. They scroll while the head and Settings stay put. Each lane owns its
 * list (`features/<area>/<area>-nav.tsx`); the page head opens the same list
 * where the sidebar is its rail (`section-switcher.tsx`).
 *
 * One item per nav list is current: a place's own row here, or the section
 * under APPS when the place has no row (the sidebar works that out).
 */
export function SectionGroups({ section }: { section: VerticalId }) {
  // A team member works the mail; the rest is the owner's (ADR-0063).
  if (section === "mail" || isMember()) return <MailNav />
  if (section === "calendar") return <CalendarNav />
  if (section === "contacts") return <ContactsNav />
  return <NotesNav />
}
