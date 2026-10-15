import { useState } from "react"
import { toast } from "sonner"

import { Icon, Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, NativeSelect, NativeSelectOption, Switch, DialogAction, DialogActions } from "@unicron/ui"
import { useBookingLinks, useCollections, useCore, usePimAction } from "@/core/queries"
import type { BookingLink, BookingLinkInput } from "@/core/types"

import { BookingPage } from "../booking/page"

const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e))
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`
const minutesOf = (v: string) => {
  const [h, m] = v.split(":").map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}
const urlOf = (l: BookingLink) => `${location.origin}/book/${l.token}`

/**
 * Scheduling links (ADR-0026): a page where people pick one of your free
 * times. The web gateway serves the pages, so only there is a link shareable;
 * everywhere, Preview shows exactly what visitors see.
 */
export function BookingLinks() {
  const { data: links = [] } = useBookingLinks()
  const { data: core } = useCore()
  const [editing, setEditing] = useState<{ link?: BookingLink } | null>(null)
  const [preview, setPreview] = useState<BookingLink | null>(null)
  // The desktop and phone apps have no public address to serve a page from.
  const desktop = core?.kind === "native" && !core.remote
  const copy = async (l: BookingLink) => {
    try {
      await navigator.clipboard.writeText(urlOf(l))
      toast.success("Link copied", { description: urlOf(l), duration: 2500 })
    } catch {
      toast(urlOf(l), { duration: 8000 })
    }
  }
  return (
    <section aria-label="Booking links" className="flex flex-col gap-1">
      <h3 className="pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Booking links</h3>
      {desktop ? (
        <p className="text-xs text-muted-foreground">Booking pages are served by the web gateway, which has an address people can reach. Set them up there.</p>
      ) : (
        <>
          {links.map((l) => (
            <div key={l.id} className="flex items-center gap-1 rounded-lg px-1 text-sm">
              <button type="button" className="flex min-w-0 flex-1 flex-col py-1 text-left" onClick={() => setEditing({ link: l })} aria-label={`Edit ${l.title}`}>
                <span className="truncate">{l.title}</span>
                <span className="text-xs text-muted-foreground">
                  {l.minutes} min · {hhmm(l.dayStart)}–{hhmm(l.dayEnd)}
                  {l.weekdaysOnly ? ", weekdays" : ""}
                </span>
              </button>
              <Button size="icon-sm" variant="ghost" aria-label={`Preview ${l.title}`} onClick={() => setPreview(l)}>
                <Icon name="visibility" />
              </Button>
              {core?.remote && (
                <Button size="icon-sm" variant="ghost" aria-label={`Copy link to ${l.title}`} onClick={() => void copy(l)}>
                  <Icon name="link" />
                </Button>
              )}
            </div>
          ))}
          <Button variant="ghost-muted" size="sm" className="justify-start px-1" onClick={() => setEditing({})}>
            <Icon name="add" data-icon="inline-start" /> New booking link
          </Button>
          {core?.kind === "demo" && links.length > 0 && <p className="px-1 text-xs text-muted-foreground">In the demo, Preview shows the page. On a gateway you'd share the link.</p>}
        </>
      )}
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-md">{editing && <LinkForm key={editing.link?.id ?? "new"} link={editing.link} onDone={() => setEditing(null)} />}</DialogContent>
      </Dialog>
      <Dialog open={preview !== null} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto p-0 sm:max-w-xl" aria-label="Booking page preview">
          {preview && (
            <>
              <p className="border-b px-4 py-2 text-xs text-muted-foreground">Preview: what visitors see. Booking here adds a real event.</p>
              <BookingPage token={preview.token} preview />
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  )
}

function LinkForm({ link, onDone }: { link?: BookingLink; onDone: () => void }) {
  const { data: calendars = [] } = useCollections("calendar")
  const writable = calendars.filter((c) => c.writable)
  const [title, setTitle] = useState(link?.title ?? "")
  const [minutes, setMinutes] = useState(link?.minutes ?? 30)
  const [calendarId, setCalendarId] = useState(link?.calendarId ?? writable[0]?.id ?? "")
  const [start, setStart] = useState(hhmm(link?.dayStart ?? 9 * 60))
  const [end, setEnd] = useState(hhmm(link?.dayEnd ?? 17 * 60))
  const [weekdays, setWeekdays] = useState(link?.weekdaysOnly ?? true)
  const [days, setDays] = useState(link?.daysAhead ?? 7)
  const [note, setNote] = useState(link?.note ?? "")
  const save = usePimAction((c, input: BookingLinkInput) => c.saveBookingLink(link?.id ?? null, input))
  const remove = usePimAction((c) => c.deleteBookingLink(link!.id))
  const submit = async () => {
    try {
      const l = await save.mutateAsync({ title, minutes, calendarId: calendarId || writable[0]?.id || "", dayStart: minutesOf(start), dayEnd: minutesOf(end), weekdaysOnly: weekdays, daysAhead: days, note: note || null })
      toast.success(link ? `Updated “${l.title}”` : `Added “${l.title}”`, { duration: 2000 })
      onDone()
    } catch (e) {
      fail(e)
    }
  }
  const del = async () => {
    try {
      await remove.mutateAsync(undefined)
      toast.success(`Deleted “${link!.title}”. Its page stops working now.`, { duration: 2500 })
      onDone()
    } catch (e) {
      fail(e)
    }
  }
  const field = "h-9 w-full rounded-lg border bg-transparent px-2.5 text-sm dark:bg-input/30"
  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => (e.preventDefault(), void submit())}>
      <DialogHeader>
        <DialogTitle>{link ? "Edit booking link" : "New booking link"}</DialogTitle>
        <DialogDescription>People pick one of your free times; it lands in your calendar. Busy times never show, and nothing else about your calendar does either.</DialogDescription>
      </DialogHeader>
      <label className="flex flex-col gap-1 text-sm">
        Title
        <input className={field} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Intro call" autoFocus />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Length
          <NativeSelect value={String(minutes)} onChange={(e) => setMinutes(Number(e.target.value))} className="w-full">
            {[15, 30, 45, 60, 90].map((m) => (
              <NativeSelectOption key={m} value={String(m)}>
                {m} minutes
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Up to
          <NativeSelect value={String(days)} onChange={(e) => setDays(Number(e.target.value))} className="w-full">
            {[3, 7, 14].map((d) => (
              <NativeSelectOption key={d} value={String(d)}>
                {d} days ahead
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-sm">
          From
          <input className={field} type="time" step={1800} value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Until
          <input className={field} type="time" step={1800} value={end} onChange={(e) => setEnd(e.target.value)} />
        </label>
      </div>
      <label className="flex items-center justify-between gap-3 text-sm">
        Weekdays only
        <Switch checked={weekdays} onCheckedChange={setWeekdays} aria-label="Weekdays only" />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Add bookings to
        <NativeSelect value={calendarId} onChange={(e) => setCalendarId(e.target.value)} className="w-full">
          {writable.map((c) => (
            <NativeSelectOption key={c.id} value={c.id}>
              {c.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <span className="text-xs text-muted-foreground">A calendar on a mail account also emails the booker an invitation.</span>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Note on the page
        <textarea className="min-h-16 w-full rounded-lg border bg-transparent px-2.5 py-2 text-sm dark:bg-input/30" value={note} onChange={(e) => setNote(e.target.value)} placeholder="On video; I'll send the link." />
      </label>
      <DialogActions>
        {link && (
          <DialogAction kind="destructive" type="button" onClick={() => void del()}>
            Delete link
          </DialogAction>
        )}
        <DialogAction kind="cancel" type="button" onClick={onDone}>
          Cancel
        </DialogAction>
        <DialogAction type="submit" disabled={save.isPending}>
          {link ? "Save" : "Add link"}
        </DialogAction>
      </DialogActions>
    </form>
  )
}
