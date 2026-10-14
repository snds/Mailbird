import { Icon } from "@/components/icon"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

import { meetingService } from "./meeting"

/** Opens the event's video call in the browser (or the service's app, if it claims the link). */
export function JoinButton({
  url,
  size = "sm",
  variant = "default",
  long = false,
  className,
}: {
  url: string
  size?: "sm" | "default"
  variant?: "default" | "outline"
  /** "Join Zoom" instead of "Join", where there's room. */
  long?: boolean
  className?: string
}) {
  // A real link (not a button rendered as one), so it opens, copies, and reads as a link.
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      aria-label={long ? undefined : `Join ${meetingService(url)}`}
      // Keep the click from also selecting the row or card it sits in.
      onClick={(e) => e.stopPropagation()}
      className={cn(buttonVariants({ size, variant }), className)}
    >
      <Icon name="videocam" data-icon="inline-start" /> {long ? `Join ${meetingService(url)}` : "Join"}
    </a>
  )
}
