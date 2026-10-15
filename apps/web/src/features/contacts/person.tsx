import { Avatar, AvatarFallback, AvatarImage } from "@unicron/ui"
import type { ContactSummary } from "@/core/types"
import { cn } from "@/lib/utils"

const contactInitials = (name: string) =>
  name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase())
    .slice(0, 2)
    .join("")

/** A contact's photo (embedded data only), or initials. */
export function PersonAvatar({ contact, className, size }: { contact: Pick<ContactSummary, "fullName" | "photo">; className?: string; size?: "sm" | "default" | "lg" }) {
  return (
    <Avatar className={cn("shrink-0", className)} size={size}>
      {contact.photo && <AvatarImage src={contact.photo} alt="" />}
      <AvatarFallback>{contactInitials(contact.fullName) || "?"}</AvatarFallback>
    </Avatar>
  )
}
