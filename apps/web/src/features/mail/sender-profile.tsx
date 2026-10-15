import { useUi } from "@/app/ui-store"
import { Icon } from "@/components/icon"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { useSenderProfile } from "@/core/queries"
import type { Address, MessageSummary } from "@/core/types"
import { Action, Activity } from "@/features/contacts/contact-detail"
import { LinkedNotes } from "@/features/notes/linked-notes"

const monthYear = (secs: number) => new Date(secs * 1000).toLocaleDateString(undefined, { month: "short", year: "numeric" })

const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?"

/**
 * Who sent this, beside the message (Superhuman): their card if they're a
 * contact, or what their mail says if not; how to reach them; and what
 * you've done together, so you can answer in context (ADR-0036).
 * `threadId` is the open conversation, left out of "Recent mail".
 */
export function SenderProfile({ from, threadId, onOpenThread }: { from: Address; threadId: string; onOpenThread?: (row: MessageSummary) => void }) {
  const { data: p, isPending } = useSenderProfile(from.email)
  const openComposer = useUi((s) => s.openComposer)
  const openContactEditor = useUi((s) => s.openContactEditor)
  const jumpTo = useUi((s) => s.jumpTo)
  if (isPending || !p) {
    return (
      <div className="flex flex-col items-center gap-3 p-4">
        <Skeleton className="size-16 rounded-full" />
        <Skeleton className="h-5 w-32" />
      </div>
    )
  }
  const c = p.contact
  const name = c?.fullName || p.name || from.name || p.email
  const phone = c?.phones[0]?.value
  const dial = phone?.replace(/[^\d+]/g, "")
  const activity = { ...p.activity, threads: p.activity.threads.filter((t) => t.threadId !== threadId) }

  return (
    <div className="flex flex-col items-center gap-4 text-center" aria-label={`About ${name}`} role="region">
      <div className="flex flex-col items-center gap-1.5">
        <Avatar className="size-16 text-lg">
          {c?.photo && <AvatarImage src={c.photo} alt="" />}
          <AvatarFallback>{initialsOf(name)}</AvatarFallback>
        </Avatar>
        <h3 className="text-base font-semibold break-words">{name}</h3>
        {c && (c.title || c.org) && <p className="text-sm text-muted-foreground">{[c.title, c.org].filter(Boolean).join(" · ")}</p>}
        <p className="text-xs break-all text-muted-foreground">{p.email}</p>
        {!c && <Badge variant="outline">Not in your contacts</Badge>}
      </div>

      {/* One row of equal buttons, however many apply (a narrow column fits four). */}
      <div className="grid w-full grid-cols-[repeat(auto-fit,minmax(0,1fr))] gap-1.5 [&>*]:min-w-0 [&>*]:px-1">
        <Action icon="mail" label="Email" onClick={() => openComposer({ to: [{ name, email: p.email }] })} />
        {dial && <Action icon="call" label="Call" href={`tel:${dial}`} />}
        {dial && <Action icon="chat" label="Message" href={`sms:${dial}`} />}
        {c ? (
          <Action icon="contact_page" label="Card" onClick={() => jumpTo({ kind: "contact", id: c.id })} />
        ) : (
          <Action icon="person_add" label="Add" onClick={() => openContactEditor({ initial: { fullName: p.name ?? from.name ?? "", emails: [{ value: p.email, label: null }] } })} />
        )}
      </div>

      {p.received > 0 && (
        <p className="text-xs text-muted-foreground">
          <Icon name="history" className="mr-1 inline size-3.5 align-[-2px]" />
          {p.received === 1 ? "1 message" : `${p.received} messages`} from them{p.firstSeen ? ` since ${monthYear(p.firstSeen)}` : ""}
        </p>
      )}

      <Activity activity={activity} onThread={onOpenThread} />
      {c && <LinkedNotes target={{ kind: "contact", id: c.id }} title={c.fullName} />}
    </div>
  )
}
