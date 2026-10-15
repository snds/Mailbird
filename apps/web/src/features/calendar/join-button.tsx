import { Icon } from "@/components/icon"
import { buttonVariants } from "@/components/ui/button"
import { useCore, useMeetingPrefs } from "@/core/queries"
import { cn } from "@/lib/utils"

import { meetingService } from "./meeting"

/**
 * Joins the event's call (ADR-0030): in Zoom's or Teams' app when there's a
 * link for it and you haven't chosen the browser, else on the web. The
 * desktop app hands the link to the system, which knows which app takes it.
 */
export function JoinButton({
  url,
  appUrl,
  size = "sm",
  variant = "default",
  long = false,
  className,
}: {
  url: string
  /** The same call in its service's app. */
  appUrl?: string | null
  size?: "sm" | "default"
  variant?: "default" | "outline"
  /** "Join Zoom" instead of "Join", where there's room. */
  long?: boolean
  className?: string
}) {
  const { data: prefs } = useMeetingPrefs()
  const { data: core } = useCore()
  const inApp = !!appUrl && (prefs?.openInApps ?? true)
  const href = inApp ? appUrl! : url
  const service = meetingService(url)
  // The desktop (not a gateway's browser) opens links through the system.
  const native = core?.kind === "native" && !core.remote
  // A real link (not a button rendered as one), so it opens, copies, and reads as a link.
  return (
    <a
      href={href}
      // App links open the app; a new tab for them would stay blank.
      target={inApp ? undefined : "_blank"}
      rel="noreferrer"
      aria-label={long ? undefined : `Join ${service}`}
      title={inApp ? `Opens the ${service} app` : undefined}
      data-opens={inApp ? "app" : "browser"}
      onClick={(e) => {
        // Keep the click from also selecting the row or card it sits in.
        e.stopPropagation()
        if (native && core) {
          e.preventDefault()
          void core.openMeeting(href)
        }
      }}
      className={cn(buttonVariants({ size, variant }), className)}
    >
      <Icon name="videocam" data-icon="inline-start" /> {long ? `Join ${service}` : "Join"}
    </a>
  )
}
