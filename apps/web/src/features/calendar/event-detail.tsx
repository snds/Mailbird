import { toast } from "sonner"

import { useUi } from "@/app/ui-store"
import { Icon, type IconName } from "@/components/icon"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { getCoreClient } from "@/core/client"
import { useAccounts, useEvent, usePimAction } from "@/core/queries"
import type { Collection, EditScope, EventDetail as Detail, Repeat } from "@/core/types"

import { displayName, initials } from "../mail/format"
import { LinkedNotes } from "../notes/linked-notes"
import { calendarColor } from "./colors"
import { dayLabel, fmt, fromSecs, rangeLabel } from "./dates"
import { JoinButton } from "./join-button"
import { placeLabel } from "./meeting"
import { inputFromDetail } from "./quick-add"
import { reminderLabel, travelLabel } from "./reminders"
import { zoneAbbr, zoneCity } from "./zones"

const theirTime = (secs: number, zone: string) => fromSecs(secs).toLocaleTimeString(undefined, { timeZone: zone, hour: "numeric", minute: "2-digit" })

const REPEAT_TEXT: Record<Repeat, string | null> = {
  none: null,
  daily: "Every day",
  weekly: "Every week",
  monthly: "Every month",
  yearly: "Every year",
  custom: "Repeats (custom rule)",
}

const STATUS: Record<string, { label: string; icon: IconName }> = {
  accepted: { label: "Going", icon: "check_circle" },
  declined: { label: "Not going", icon: "cancel" },
  tentative: { label: "Maybe", icon: "help" },
  "needs-action": { label: "No reply", icon: "schedule" },
}

function Row({ icon, children }: { icon: IconName; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 text-sm">
      <Icon name={icon} className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

/** Only web links become links; anything else in URL stays text. */
const safeUrl = (u: string | null) => (u && /^https?:\/\//i.test(u) ? u : null)

export function EventDetailPane({ eventId, start, calendars, onDeleted }: { eventId: string; start: number; calendars: Map<string, Collection>; onDeleted: () => void }) {
  const { data: e, error, isPending } = useEvent(eventId, start)
  const { data: accounts = [] } = useAccounts()
  const openEditor = useUi((s) => s.openEventEditor)
  const remove = usePimAction((c, { occurrence, scope }: { occurrence: number | null; scope: EditScope }) => c.deleteEvent(eventId, occurrence, scope))

  if (isPending) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-3 p-6">
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="mt-4 h-20" />
      </div>
    )
  }
  if (error || !e) return <p className="p-6 text-sm text-muted-foreground">{error instanceof Error ? error.message : "That event is gone."}</p>

  const cal = calendars.get(e.calendarId)
  const account = accounts.find((a) => a.id === cal?.accountId)
  const repeat = REPEAT_TEXT[e.repeat]

  // Invited: the organizer owns the guest list (and the real copy of the event).
  const organizerIsMe = !e.organizer || accounts.some((a) => a.address.toLowerCase() === e.organizer!.email.toLowerCase())
  const guests = e.attendees.filter((a) => !e.organizer || a.email.toLowerCase() !== e.organizer.email.toLowerCase()).map(({ name, email }) => ({ name, email }))
  const edit = async (scope: EditScope) => {
    // The whole series is edited from its first occurrence, so the dates apply
    // to all; one occurrence (or the rest of the series) from the one picked.
    const base: Detail = e.recurring && scope === "all" ? await (await getCoreClient()).getEvent(e.eventId) : e
    openEditor({
      eventId: e.eventId,
      initial: { ...inputFromDetail(base), reminders: base.reminders, attendees: organizerIsMe ? guests : undefined },
      scope: e.recurring ? scope : "all",
      occurrence: e.originalStart,
      guestOf: organizerIsMe ? undefined : displayName(e.organizer!),
    })
  }
  const del = async (scope: EditScope) => {
    try {
      await remove.mutateAsync({ occurrence: e.recurring ? e.originalStart : null, scope })
      toast.success(scope === "this" ? "This event was removed from the series" : scope === "following" ? "This and following events were deleted" : "Event deleted", { duration: 2500 })
      onDeleted()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <article className="mx-auto flex max-w-2xl flex-col gap-5 px-4 pb-10 md:px-8 md:pt-6" aria-label={e.title}>
      <header className="flex flex-col gap-1.5">
        <div className="flex items-start gap-3">
          <span className="mt-2 size-3 shrink-0 rounded-full" style={{ background: calendarColor(cal) }} aria-hidden />
          <h2 className="min-w-0 flex-1 text-2xl font-semibold tracking-tight break-words">{e.title || "(no title)"}</h2>
        </div>
        <p className="pl-6 text-sm text-muted-foreground">
          {dayLabel(fromSecs(e.start))} · {rangeLabel(e.start, e.end, e.allDay)}
        </p>
        {e.meetingUrl && (
          <div className="pt-2 pl-6">
            <JoinButton url={e.meetingUrl} size="default" long />
          </div>
        )}
      </header>

      {e.writable ? (
        <div className="flex flex-wrap gap-2 pl-6">
          {e.recurring ? (
            // Apple Calendar's grammar: pick the scope first, then act.
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="outline" />}>
                <Icon name="edit" data-icon="inline-start" /> Edit
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onClick={() => void edit("this")}>This event only</DropdownMenuItem>
                <DropdownMenuItem onClick={() => void edit("following")}>This and following events</DropdownMenuItem>
                <DropdownMenuItem onClick={() => void edit("all")}>All events in the series</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Button variant="outline" onClick={() => void edit("all")}>
              <Icon name="edit" data-icon="inline-start" /> Edit
            </Button>
          )}
          {e.recurring ? (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="outline" disabled={remove.isPending} />}>
                <Icon name="delete" data-icon="inline-start" /> Delete
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onClick={() => void del("this")}>Delete this event only</DropdownMenuItem>
                <DropdownMenuItem onClick={() => void del("following")}>Delete this and following events</DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onClick={() => void del("all")}>
                  Delete every event in the series
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Button variant="outline" onClick={() => void del("all")} disabled={remove.isPending}>
              <Icon name="delete" data-icon="inline-start" /> Delete
            </Button>
          )}
        </div>
      ) : (
        <p className="flex items-center gap-2 pl-6 text-xs text-muted-foreground">
          <Icon name="lock" className="size-4" /> “{cal?.name ?? "This calendar"}” is read-only.
        </p>
      )}

      <div className="flex flex-col gap-4">
        {repeat && <Row icon="repeat">{repeat}</Row>}
        {e.reminders.length > 0 && (
          <Row icon="notifications">
            <span aria-label="Reminders">{e.reminders.map((m) => reminderLabel(m, e.allDay)).join(", ")}</span>
          </Row>
        )}
        {e.location && (
          <Row icon="location_on">
            <span className="break-words">{placeLabel(e)}</span>
          </Row>
        )}
        {e.travel && !e.allDay ? (
          <Row icon="directions_car">
            <span data-slot="travel">
              {travelLabel(e.travel)} travel · leave by {fmt.time(e.start - e.travel * 60)}
            </span>
          </Row>
        ) : null}
        {e.timeZone && e.timeZone !== Intl.DateTimeFormat().resolvedOptions().timeZone && (
          <Row icon="public">
            <span data-slot="zone">
              Scheduled in {zoneCity(e.timeZone)} time: {theirTime(e.start, e.timeZone)}–{theirTime(e.end, e.timeZone)} {zoneAbbr(e.timeZone, fromSecs(e.start))}
            </span>
          </Row>
        )}
        <Row icon="calendar_month">
          {cal?.name ?? "Calendar"}
          {account && account.displayName !== cal?.name && <span className="text-muted-foreground"> · {account.displayName}</span>}
          {!cal?.accountId && <span className="text-muted-foreground"> · not synced</span>}
        </Row>
        {safeUrl(e.url) && (
          <Row icon="link">
            <a href={safeUrl(e.url)!} target="_blank" rel="noreferrer noopener" className="break-all text-primary hover:underline">
              {e.url}
            </a>
          </Row>
        )}
        {e.notes && (
          <Row icon="notes">
            <p className="leading-relaxed break-words whitespace-pre-line">{e.notes}</p>
          </Row>
        )}
        {(e.attendees.length > 0 || e.organizer) && (
          <Row icon="group">
            <ul className="flex flex-col gap-2" aria-label="People">
              {e.organizer && !e.attendees.some((a) => a.email === e.organizer!.email) && (
                <li className="flex items-center gap-2">
                  <Avatar size="sm">
                    <AvatarFallback>{initials(e.organizer)}</AvatarFallback>
                  </Avatar>
                  <span className="truncate">{displayName(e.organizer)}</span>
                  <Badge variant="outline">Organizer</Badge>
                </li>
              )}
              {e.attendees.map((a) => {
                const st = STATUS[a.status ?? ""] ?? null
                return (
                  <li key={a.email} className="flex items-center gap-2">
                    <Avatar size="sm">
                      <AvatarFallback>{initials(a)}</AvatarFallback>
                    </Avatar>
                    <span className="min-w-0 flex-1 truncate">
                      {displayName(a)}
                      {e.organizer?.email === a.email && <span className="text-muted-foreground"> · organizer</span>}
                    </span>
                    {st && (
                      <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                        <Icon name={st.icon} className="size-3.5" /> {st.label}
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
          </Row>
        )}
      </div>
      <LinkedNotes target={{ kind: "event", id: eventId }} title={`${e.title} · ${fromSecs(e.start).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`} />
    </article>
  )
}
