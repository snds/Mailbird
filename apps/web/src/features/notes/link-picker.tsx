import { useQuery } from "@tanstack/react-query"
import { useDeferredValue, useState } from "react"

import { Icon, type IconName, Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Input } from "@unicron/ui"
import { getCoreClient } from "@/core/client"
import type { NoteLink, NoteLinkKind, NoteTarget } from "@/core/types"
import { shortTime } from "@/lib/time"

const DAY = 86_400

interface Found {
  target: NoteTarget
  label: string
  detail: string
}

const GROUPS: { kind: NoteLinkKind; heading: string; icon: IconName }[] = [
  { kind: "event", heading: "Events", icon: "event" },
  { kind: "contact", heading: "People", icon: "person" },
  { kind: "thread", heading: "Conversations", icon: "mail" },
]

/**
 * Events (a month back, three ahead), people, and conversations matching
 * the search, a few of each. Empty search: what's nearest in time.
 */
async function search(q: string): Promise<Record<NoteLinkKind, Found[]>> {
  const core = await getCoreClient()
  const lower = q.toLowerCase()
  const now = Math.floor(Date.now() / 1000)
  const [occ, people, inbox, archive] = await Promise.all([
    core.listOccurrences(now - 30 * DAY, now + 90 * DAY),
    core.listContacts(q || null),
    core.listMessages({ lane: "inbox", search: q || null, limit: 8 }),
    q ? core.listMessages({ lane: "archive", search: q, limit: 8 }) : Promise.resolve([]),
  ])
  const events = new Map<string, Found & { at: number }>()
  for (const o of occ) {
    // Birthdays and holidays aren't events a note can link to.
    if (o.contactId || o.eventId.startsWith("special:") || !o.title.toLowerCase().includes(lower)) continue
    const at = Math.abs(o.start - now)
    const seen = events.get(o.eventId)
    if (!seen || at < seen.at) events.set(o.eventId, { target: { kind: "event", id: o.eventId }, label: o.title, detail: shortTime(o.start), at })
  }
  const threads = new Map<string, Found>()
  for (const m of [...inbox, ...archive]) {
    if (!threads.has(m.threadId)) threads.set(m.threadId, { target: { kind: "thread", id: m.threadId }, label: m.subject || "(no subject)", detail: m.from.name || m.from.email })
  }
  return {
    event: [...events.values()].sort((a, b) => a.at - b.at).slice(0, 5),
    contact: people.slice(0, 5).map((c) => ({ target: { kind: "contact", id: c.id }, label: c.fullName || c.emails[0]?.value || "(no name)", detail: c.org ?? c.emails[0]?.value ?? "" })),
    thread: [...threads.values()].slice(0, 5),
  }
}

/**
 * Links this note to an event, a person, or a conversation, from the note
 * itself (ADR-0035). Before, links could only start from those items.
 */
export function LinkPicker({ open, onOpenChange, linked, onLink }: { open: boolean; onOpenChange: (o: boolean) => void; linked: NoteLink[]; onLink: (link: NoteLink) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">{open && <Picker linked={linked} onLink={onLink} />}</DialogContent>
    </Dialog>
  )
}

function Picker({ linked, onLink }: { linked: NoteLink[]; onLink: (link: NoteLink) => void }) {
  const [q, setQ] = useState("")
  const query = useDeferredValue(q.trim())
  const { data } = useQuery({ queryKey: ["notes", "link-picker", query], queryFn: () => search(query) })
  const already = (t: NoteTarget) => linked.some((l) => l.kind === t.kind && l.target === t.id)
  const pick = async (f: Found) => {
    const link = await (await getCoreClient()).noteLinkFor(f.target)
    if (link) onLink(link)
  }
  const empty = data && GROUPS.every((g) => data[g.kind].length === 0)
  return (
    <div className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Link this note</DialogTitle>
        <DialogDescription>To an event, a person, or a conversation. The note then shows up with it, and the link opens it from here.</DialogDescription>
      </DialogHeader>
      <Input autoFocus type="search" aria-label="Find something to link" placeholder="Search events, people, and mail" value={q} onChange={(e) => setQ(e.target.value)} />
      {empty && <p className="text-sm text-muted-foreground">Nothing matches “{query}”.</p>}
      {GROUPS.map((g) =>
        data && data[g.kind].length > 0 ? (
          <section key={g.kind} aria-label={g.heading} className="flex flex-col">
            <h3 className="pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{g.heading}</h3>
            {data[g.kind].map((f) => {
              const done = already(f.target)
              return (
                <Button key={f.target.id} variant="ghost" className="h-auto justify-start gap-2 px-2 py-1.5 text-left" disabled={done} onClick={() => void pick(f)}>
                  <Icon name={g.icon} tone="muted" className="size-4" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm">{f.label}</span>
                    <span className="truncate text-xs text-muted-foreground">{done ? "Linked already" : f.detail}</span>
                  </span>
                </Button>
              )
            })}
          </section>
        ) : null,
      )}
    </div>
  )
}
