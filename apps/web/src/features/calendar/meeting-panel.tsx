import { toast } from "sonner"

import { Icon } from "@/components/icon"
import { Button, buttonVariants } from "@/components/ui/button"
import { useCore } from "@/core/queries"
import type { ManageLink, MeetingInfo } from "@/core/types"
import { cn } from "@/lib/utils"

import { JoinButton } from "./join-button"

/** "+16699006833" → "+1 669 900 6833" for North American numbers; others as written. */
const pretty = (n: string) => (/^\+1\d{10}$/.test(n) ? `+1 ${n.slice(2, 5)} ${n.slice(5, 8)} ${n.slice(8)}` : n)

const ACTION: Record<string, string> = { reschedule: "Reschedule", cancel: "Cancel booking", manage: "Change booking" }

/**
 * The call, as its invitation describes it (ADR-0030): Join (in the app or
 * the browser), the meeting ID and passcode to read out or paste, one-tap
 * dial-in, and the booking tool's own reschedule and cancel pages.
 */
export function MeetingPanel({ meeting, manage, compact = false }: { meeting: MeetingInfo | null | undefined; manage?: ManageLink[]; compact?: boolean }) {
  const { data: core } = useCore()
  const native = core?.kind === "native" && !core.remote
  if (!meeting && !manage?.length) return null
  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      toast.success(`${label} copied`, { duration: 1500 })
    } catch {
      toast(value, { description: label, duration: 6000 })
    }
  }
  // Booking tools' pages open in the browser (desktop: through the system).
  const open = (url: string) => (e: React.MouseEvent) => {
    if (native && core) {
      e.preventDefault()
      void core.openMeeting(url)
    }
  }
  return (
    <section aria-label="Video call" className={cn("flex flex-col gap-2", !compact && "pt-2 pl-6")} data-slot="meeting">
      {meeting && (
        <div className="flex flex-wrap items-center gap-2">
          <JoinButton url={meeting.url} appUrl={meeting.appUrl} size={compact ? "sm" : "default"} long />
          {meeting.appUrl && (
            <a href={meeting.url} target="_blank" rel="noreferrer" onClick={open(meeting.url)} className="text-xs text-muted-foreground hover:text-foreground hover:underline">
              Open in browser
            </a>
          )}
        </div>
      )}
      {meeting && (meeting.meetingId || meeting.passcode) && (
        <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {meeting.meetingId && (
            <div className="flex items-center gap-1">
              <dt className="text-muted-foreground">Meeting ID</dt>
              <dd className="font-medium tabular-nums">{meeting.meetingId}</dd>
              <Button variant="ghost" size="icon-xs" aria-label="Copy meeting ID" onClick={() => void copy("Meeting ID", meeting.meetingId!.replace(/\s/g, ""))}>
                <Icon name="content_copy" />
              </Button>
            </div>
          )}
          {meeting.passcode && (
            <div className="flex items-center gap-1">
              <dt className="text-muted-foreground">Passcode</dt>
              <dd className="font-medium tabular-nums">{meeting.passcode}</dd>
              <Button variant="ghost" size="icon-xs" aria-label="Copy passcode" onClick={() => void copy("Passcode", meeting.passcode!)}>
                <Icon name="content_copy" />
              </Button>
            </div>
          )}
        </dl>
      )}
      {meeting && meeting.dialIn.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs" role="group" aria-label="Call in">
          <span className="text-muted-foreground">Call in</span>
          {meeting.dialIn.slice(0, compact ? 1 : 2).map((d) => (
            <a key={d.tel} href={d.tel} className={buttonVariants({ size: "xs", variant: "outline" })} aria-label={`Call in on ${pretty(d.number)}${d.label ? `, ${d.label}` : ""}`}>
              <Icon name="call" data-icon="inline-start" /> {pretty(d.number)}
              {d.label && <span className="text-muted-foreground">{d.label}</span>}
            </a>
          ))}
        </div>
      )}
      {manage && manage.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs" role="group" aria-label="Booking">
          <span className="text-muted-foreground">Booked with {manage[0]!.tool}</span>
          {manage.map((m) => (
            <a key={m.url} href={m.url} target="_blank" rel="noreferrer" onClick={open(m.url)} className={buttonVariants({ size: "xs", variant: "outline" })}>
              <Icon name={m.action === "cancel" ? "event_busy" : "edit_calendar"} data-icon="inline-start" /> {ACTION[m.action] ?? "Change booking"}
            </a>
          ))}
        </div>
      )}
    </section>
  )
}
