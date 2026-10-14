import { useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"

import { Icon, type IconName } from "@/components/icon"
import { Button } from "@/components/ui/button"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { useCollections, useMailAction } from "@/core/queries"
import type { Invite, InviteResponse } from "@/core/types"
import { cn } from "@/lib/utils"

import { dayLabel, fromSecs, rangeLabel } from "../calendar/dates"
import { displayName } from "./format"

const ANSWERS: { value: InviteResponse; label: string; icon: IconName }[] = [
  { value: "accepted", label: "Accept", icon: "check_circle" },
  { value: "tentative", label: "Maybe", icon: "help" },
  { value: "declined", label: "Decline", icon: "cancel" },
]

const STATUS_TEXT: Record<string, string> = {
  accepted: "You're going",
  tentative: "You might go",
  declined: "You declined",
}

const DONE_TEXT: Record<InviteResponse, string> = {
  accepted: "Accepted",
  tentative: "Replied maybe to",
  declined: "Declined",
}

const REPLY_TEXT: Record<string, string> = {
  accepted: "accepted",
  tentative: "said maybe to",
  declined: "declined",
}

/**
 * The meeting a message carries (iMIP): answer an invitation, apply a
 * cancellation, or record a guest's reply on your event. Sits above the
 * message body, like Outlook's and Apple Mail's invitation banners.
 */
export function InviteCard({ invite, messageId, accountId }: { invite: Invite; messageId: string; accountId: string }) {
  const { data: calendars = [] } = useCollections("calendar")
  const qc = useQueryClient()
  const writable = calendars.filter((c) => c.writable)
  const fallback = writable.find((c) => c.accountId === accountId) ?? writable[0]
  const [calendarId, setCalendarId] = useState<string>("")
  const target = calendarId || fallback?.id || ""
  const done = () => void qc.invalidateQueries({ queryKey: ["pim"] })
  const respond = useMailAction((c, r: InviteResponse) => c.respondToInvite(messageId, r, invite.eventId ? null : target))
  const apply = useMailAction((c) => c.applyInviteUpdate(messageId))

  const when = invite.start != null && invite.end != null ? `${dayLabel(fromSecs(invite.start))} · ${rangeLabel(invite.start, invite.end, invite.allDay)}` : null
  const answer = async (r: InviteResponse) => {
    try {
      await respond.mutateAsync(r)
      done()
      const where = invite.eventId ? "" : r === "declined" ? "" : ` · added to ${writable.find((c) => c.id === target)?.name ?? "your calendar"}`
      toast.success(`${DONE_TEXT[r]} “${invite.title}”${where}`, { duration: 3000 })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }
  const runApply = async () => {
    try {
      await apply.mutateAsync(undefined)
      done()
      toast.success(invite.method === "cancel" ? "Removed from your calendar" : "Your event is up to date", { duration: 2500 })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  const going = invite.attendees.filter((a) => a.status === "accepted").length
  return (
    <section
      aria-label={invite.method === "cancel" ? "Canceled event" : invite.method === "reply" ? "Reply to your invitation" : "Invitation"}
      className={cn("flex flex-col gap-3 rounded-xl border bg-muted/40 p-3", invite.method === "cancel" && "border-destructive/30 bg-destructive/5")}
      data-slot="invite-card"
    >
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 flex-col items-center justify-center rounded-lg bg-background text-center shadow-xs" aria-hidden>
          {invite.start != null && (
            <>
              <span className="text-[9px] font-semibold text-(--c-calendar-today) uppercase">{fromSecs(invite.start).toLocaleDateString(undefined, { month: "short" })}</span>
              <span className="text-base leading-none font-semibold tabular-nums">{fromSecs(invite.start).getDate()}</span>
            </>
          )}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className={cn("truncate text-sm font-semibold", invite.method === "cancel" && "line-through decoration-1")}>{invite.title || "(no title)"}</span>
          {when && <span className="text-xs text-muted-foreground">{when}</span>}
          {invite.location && <span className="truncate text-xs text-muted-foreground">{invite.location}</span>}
          {invite.organizer && invite.method === "request" && (
            <span className="truncate text-xs text-muted-foreground">
              From {displayName(invite.organizer)}
              {invite.attendees.length > 1 && ` · ${invite.attendees.length} invited, ${going} going`}
            </span>
          )}
        </div>
      </div>

      {invite.method === "request" &&
        (invite.outdated ? (
          <p className="text-xs text-muted-foreground">Your calendar has a newer version of this event.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Your answer">
              {ANSWERS.map((a) => (
                <Button
                  key={a.value}
                  size="sm"
                  variant={invite.myStatus === a.value ? "default" : "outline"}
                  aria-pressed={invite.myStatus === a.value}
                  disabled={respond.isPending}
                  onClick={() => void answer(a.value)}
                >
                  <Icon name={a.icon} data-icon="inline-start" fill={invite.myStatus === a.value} /> {a.label}
                </Button>
              ))}
              {!invite.eventId && writable.length > 1 && (
                <NativeSelect size="sm" aria-label="Add to calendar" value={target} onChange={(e) => setCalendarId(e.target.value)} className="ml-auto max-w-44">
                  {writable.map((c) => (
                    <NativeSelectOption key={c.id} value={c.id}>
                      {c.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              )}
            </div>
            {invite.myStatus && STATUS_TEXT[invite.myStatus] && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
                <Icon name="event_available" className="size-3.5" /> {STATUS_TEXT[invite.myStatus]}
                {invite.eventId ? " · in your calendar" : ""}
              </p>
            )}
          </>
        ))}

      {invite.method === "cancel" && (
        <div className="flex items-center gap-2">
          <p className="flex-1 text-xs text-muted-foreground">{invite.organizer ? `${displayName(invite.organizer)} canceled this event.` : "This event was canceled."}</p>
          {invite.eventId && (
            <Button size="sm" variant="outline" onClick={() => void runApply()} disabled={apply.isPending}>
              Remove from calendar
            </Button>
          )}
        </div>
      )}

      {invite.method === "reply" && invite.from && (
        <div className="flex items-center gap-2">
          <p className="flex-1 text-xs text-muted-foreground">
            {displayName(invite.from)} {REPLY_TEXT[invite.from.status ?? ""] ?? "replied to"} your invitation.
          </p>
          {invite.eventId && (
            <Button size="sm" variant="outline" onClick={() => void runApply()} disabled={apply.isPending}>
              Update your event
            </Button>
          )}
        </div>
      )}
    </section>
  )
}
