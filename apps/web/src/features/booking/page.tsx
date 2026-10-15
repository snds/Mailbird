import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { Icon } from "@/components/icon"
import { Button } from "@/components/ui/button"
import { visitorBook, visitorBooking } from "@/core/client"
import type { Booked, TimeSlot } from "@/core/types"

const DAY = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" })
const TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone

/** Slots grouped by the visitor's own local day. */
function byDay(slots: TimeSlot[]) {
  const days: { label: string; slots: TimeSlot[] }[] = []
  for (const s of slots) {
    const label = DAY.format(s.start * 1000)
    if (days.at(-1)?.label === label) days.at(-1)!.slots.push(s)
    else days.push({ label, slots: [s] })
  }
  return days
}

/**
 * A scheduling link's public page (ADR-0026): pick a time, say who you are,
 * book. Times show in the visitor's own zone. It only ever reads the link's
 * free times and writes one booking.
 */
export function BookingPage({ token, preview = false }: { token: string; preview?: boolean }) {
  const { data, error, isPending, refetch } = useQuery({ queryKey: ["pim", "booking-page", token], queryFn: () => visitorBooking(token), retry: false, refetchOnMount: "always" })
  const [pick, setPick] = useState<TimeSlot | null>(null)
  const [done, setDone] = useState<Booked | null>(null)

  if (done) return <Confirmed booked={done} />
  if (isPending) return <Frame><p className="text-sm text-muted-foreground">Loading free times…</p></Frame>
  if (error || !data)
    return (
      <Frame>
        <h1 className="text-xl font-semibold">This link isn't active</h1>
        <p className="text-sm text-muted-foreground">It may have been turned off. Ask whoever sent it for a new one.</p>
      </Frame>
    )
  const days = byDay(data.slots)
  return (
    <Frame>
      <header className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">{data.host}</p>
        <h1 className="text-2xl font-semibold tracking-tight">{data.title}</h1>
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Icon name="schedule" className="size-4" /> {data.minutes} minutes
        </p>
        {data.note && <p className="mt-1 text-sm whitespace-pre-line">{data.note}</p>}
      </header>
      {pick ? (
        <BookForm
          token={token}
          slot={pick}
          preview={preview}
          onBack={() => setPick(null)}
          onBooked={setDone}
          onTaken={() => (setPick(null), void refetch())}
        />
      ) : days.length === 0 ? (
        <p className="rounded-xl bg-muted/60 p-4 text-sm">No free times right now. Check back later, or reply to whoever sent the link.</p>
      ) : (
        <section aria-label="Free times" className="flex flex-col gap-4">
          <p className="text-xs text-muted-foreground">Times are in your time zone ({zone.replace(/_/g, " ")}).</p>
          {days.map((d) => (
            <div key={d.label} role="group" aria-label={d.label} className="flex flex-col gap-2">
              <h2 className="text-sm font-medium">{d.label}</h2>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {d.slots.map((s) => (
                  <Button key={s.start} variant="outline" size="sm" className="tabular-nums" onClick={() => setPick(s)}>
                    {TIME.format(s.start * 1000)}
                  </Button>
                ))}
              </div>
            </div>
          ))}
        </section>
      )}
    </Frame>
  )
}

function BookForm({ token, slot, preview, onBack, onBooked, onTaken }: { token: string; slot: TimeSlot; preview: boolean; onBack: () => void; onBooked: (b: Booked) => void; onTaken: () => void }) {
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const submit = async () => {
    setBusy(true)
    setProblem(null)
    try {
      onBooked(await visitorBook(token, { start: slot.start, name, email, note: note || null }))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes("just taken")) onTaken()
      setProblem(msg.replace(/^./, (c) => c.toUpperCase()))
    } finally {
      setBusy(false)
    }
  }
  const field = "h-10 w-full rounded-lg border bg-transparent px-3 text-sm dark:bg-input/30"
  return (
    <form className="flex flex-col gap-4" aria-label="Your details" onSubmit={(e) => (e.preventDefault(), void submit())}>
      <div className="flex items-center justify-between gap-3 rounded-xl bg-muted/60 px-3 py-2.5 text-sm">
        <span className="font-medium">
          {DAY.format(slot.start * 1000)}, {TIME.format(slot.start * 1000)}–{TIME.format(slot.end * 1000)}
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          Change
        </Button>
      </div>
      <label className="flex flex-col gap-1 text-sm">
        Your name
        <input className={field} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required autoFocus />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Your email
        <input className={field} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Anything to share? <span className="text-xs text-muted-foreground">Optional</span>
        <textarea className="min-h-20 w-full rounded-lg border bg-transparent px-3 py-2 text-sm dark:bg-input/30" value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      {problem && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
      <Button type="submit" disabled={busy}>
        {preview ? "Book (preview)" : "Book"}
      </Button>
    </form>
  )
}

function Confirmed({ booked }: { booked: Booked }) {
  return (
    <Frame>
      <div role="status" className="flex flex-col items-start gap-2">
        <span className="flex size-10 items-center justify-center rounded-full bg-vertical-calendar/15 text-vertical-calendar">
          <Icon name="event_available" className="size-6" />
        </span>
        <h1 className="text-xl font-semibold">You're booked</h1>
        <p className="text-sm">
          {booked.title} with {booked.host}, {DAY.format(booked.start * 1000)}, {TIME.format(booked.start * 1000)}–{TIME.format(booked.end * 1000)}.
        </p>
        <p className="text-sm text-muted-foreground">
          {booked.invited ? "A calendar invitation is on its way to your email." : `It's in ${booked.host}'s calendar. They'll be in touch if anything changes.`}
        </p>
      </div>
    </Frame>
  )
}

function Frame({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto flex w-full max-w-xl flex-col gap-6 px-4 py-8 sm:py-12">{children}</main>
}
