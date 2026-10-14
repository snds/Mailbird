import { useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"

import { Icon } from "@/components/icon"
import { Button } from "@/components/ui/button"
import { useMailAction } from "@/core/queries"
import type { Invite } from "@/core/types"

import { dateInput, dayLabel, fmt, fromInputs, fromSecs, rangeLabel, secs, timeInput } from "../calendar/dates"
import { displayName } from "./format"

const when = (start: number, end: number) => `${dayLabel(fromSecs(start))} · ${rangeLabel(start, end, false)}`
const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e))

/** What else is on your calendar then. Silence would read as "you're free", so say so either way. */
export function Conflicts({ invite }: { invite: Invite }) {
  const list = invite.conflicts ?? []
  if (invite.start == null || invite.allDay) return null
  if (!list.length) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground" data-slot="conflicts">
        <Icon name="event_available" className="size-3.5" /> Nothing else on your calendar then
      </p>
    )
  }
  const [first, ...rest] = list
  return (
    <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400" role="note" data-slot="conflicts">
      <Icon name="warning" className="mt-px size-3.5 shrink-0" />
      <span>
        Clashes with <span className="font-medium">{first!.title || "(no title)"}</span> ({fmt.time(first!.start)}–{fmt.time(first!.end)})
        {rest.length > 0 && ` and ${rest.length} more`}
      </span>
    </p>
  )
}

/** A guest's way to ask for another time (iTIP COUNTER). Your answer stays as it is. */
export function ProposeTime({ invite, messageId }: { invite: Invite; messageId: string }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  // Starts from your last proposal, else the invitation's own time.
  const start = fromSecs(invite.proposed?.start ?? invite.start ?? 0)
  const length = (invite.end ?? 0) - (invite.start ?? 0) || 3600
  const [date, setDate] = useState(dateInput(start))
  const [from, setFrom] = useState(timeInput(start))
  const [to, setTo] = useState(timeInput(fromSecs(secs(start) + length)))
  const [note, setNote] = useState("")
  const propose = useMailAction((c, a: { start: number; end: number; note: string }) => c.proposeTime(messageId, a.start, a.end, a.note || null))
  if (invite.recurring || invite.start == null) return null
  const send = async () => {
    const s = secs(fromInputs(date, from))
    const e = secs(fromInputs(date, to))
    if (e <= s) return void toast.error("The new time ends before it starts")
    try {
      await propose.mutateAsync({ start: s, end: e, note: note.trim() })
      void qc.invalidateQueries({ queryKey: ["pim"] })
      toast.success(`Asked ${invite.organizer ? displayName(invite.organizer) : "the organizer"} about ${when(s, e)}`, { duration: 3500 })
      setOpen(false)
    } catch (err) {
      fail(err)
    }
  }
  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {invite.proposed && (
          <p className="flex-1 text-xs text-muted-foreground" aria-live="polite">
            You proposed {when(invite.proposed.start, invite.proposed.end)}
          </p>
        )}
        <Button size="sm" variant="ghost" className={invite.proposed ? "" : "-ml-2"} onClick={() => setOpen(true)}>
          <Icon name="schedule" data-icon="inline-start" /> {invite.proposed ? "Propose another" : "Propose new time"}
        </Button>
      </div>
    )
  }
  const field = "h-8 rounded-lg border bg-background px-2 text-sm dark:bg-input/30"
  return (
    <form className="flex flex-col gap-2 rounded-lg border bg-background p-2.5" aria-label="Propose a new time" onSubmit={(e) => (e.preventDefault(), void send())}>
      <div className="flex flex-wrap items-center gap-2">
        <input type="date" aria-label="New date" className={field} value={date} onChange={(e) => setDate(e.target.value)} />
        <input type="time" aria-label="New start" className={field} value={from} onChange={(e) => setFrom(e.target.value)} />
        <span className="text-xs text-muted-foreground">to</span>
        <input type="time" aria-label="New end" className={field} value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
      <input aria-label="Note to the organizer" placeholder="Add a note (optional)" className={`${field} w-full`} value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={propose.isPending}>
          Send proposal
        </Button>
      </div>
    </form>
  )
}

/** As organizer: a guest asks for another time. Take it (everyone gets the update) or keep yours. */
export function CounterProposal({ invite, messageId }: { invite: Invite; messageId: string }) {
  const qc = useQueryClient()
  const accept = useMailAction((c) => c.acceptCounter(messageId))
  const decline = useMailAction((c) => c.declineCounter(messageId))
  const who = invite.from ? displayName(invite.from) : "A guest"
  const run = async (yes: boolean) => {
    try {
      await (yes ? accept : decline).mutateAsync(undefined)
      void qc.invalidateQueries({ queryKey: ["pim"] })
      toast.success(yes ? `Moved “${invite.title}” and told everyone` : `Kept the time and told ${who}`, { duration: 3000 })
    } catch (e) {
      fail(e)
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        {invite.currentStart != null && invite.currentEnd != null && (
          <>
            <dt className="text-muted-foreground">Now</dt>
            <dd className="text-muted-foreground line-through decoration-1">{when(invite.currentStart, invite.currentEnd)}</dd>
          </>
        )}
        {invite.start != null && invite.end != null && (
          <>
            <dt className="text-muted-foreground">Proposed</dt>
            <dd className="font-medium">{when(invite.start, invite.end)}</dd>
          </>
        )}
      </dl>
      {invite.comment && <blockquote className="border-l-2 pl-2 text-xs text-muted-foreground italic">“{invite.comment}”</blockquote>}
      <Conflicts invite={invite} />
      {invite.answered ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
          <Icon name={invite.answered === "accepted" ? "event_available" : "event_busy"} className="size-3.5" />
          {invite.answered === "accepted" ? "You moved the event to this time" : "You kept the original time"}
        </p>
      ) : !invite.eventId ? (
        <p className="text-xs text-muted-foreground">This event isn't in your calendar anymore.</p>
      ) : (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Your answer">
          <Button size="sm" disabled={accept.isPending || decline.isPending} onClick={() => void run(true)}>
            <Icon name="check_circle" data-icon="inline-start" /> Accept new time
          </Button>
          <Button size="sm" variant="outline" disabled={accept.isPending || decline.isPending} onClick={() => void run(false)}>
            Keep original
          </Button>
        </div>
      )}
    </div>
  )
}
