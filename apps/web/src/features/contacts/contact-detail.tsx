import { toast } from "sonner"

import { useUi } from "@/app/ui-store"
import { Icon, type IconName, Badge, Button, Item, ItemActions, ItemContent, Skeleton } from "@unicron/ui"
import { getCoreClient } from "@/core/client"
import { useAccounts, useCollections, useContact, useContactActivity, useContactCopies, usePimAction } from "@/core/queries"
import type { ContactActivity, MessageSummary, Occurrence } from "@/core/types"
import { useNowSecs } from "@/hooks/use-now"
import { shortTime } from "@/lib/time"

import { dayLabel, fromSecs, rangeLabel } from "../calendar/dates"
import { JoinButton } from "../calendar/join-button"
import { LinkedNotes } from "../notes/linked-notes"
import { useQuickContext } from "../notes/use-quick-context"
import { PersonAvatar } from "./person"
import { ShareContact } from "./share"

/** "1990-04-02" → "April 2, 1990"; "--04-02" → "April 2". */
function birthdayLabel(b: string) {
  const m = /^(\d{4}|-)-?(\d{2})-(\d{2})$/.exec(b)
  if (!m) return b
  const d = new Date(m[1] === "-" ? 2000 : +m[1]!, +m[2]! - 1, +m[3]!)
  return d.toLocaleDateString(undefined, { month: "long", day: "numeric", ...(m[1] === "-" ? {} : { year: "numeric" }) })
}

const ACTION = "h-auto min-w-18 flex-col gap-1 px-3 py-2 text-xs"

export function Action({ icon, label, href, onClick, disabled }: { icon: IconName; label: string; href?: string; onClick?: () => void; disabled?: boolean }) {
  const cls = ACTION
  if (href && !disabled) {
    return (
      <Button variant="secondary" className={cls} render={<a href={href} />}>
        <Icon name={icon} className="size-5" />
        {label}
      </Button>
    )
  }
  return (
    <Button variant="secondary" className={cls} onClick={onClick} disabled={disabled}>
      <Icon name={icon} className="size-5" />
      {label}
    </Button>
  )
}

export function ContactDetailPane({ id, onDeleted }: { id: string; onDeleted: () => void }) {
  const { data: c, error, isPending } = useContact(id)
  // Quick Note links to the person that's open (ADR-0037).
  useQuickContext(c ? { kind: "contact", id, label: c.fullName } : null)
  const { data: books = [] } = useCollections("contacts")
  const { data: accounts = [] } = useAccounts()
  const openComposer = useUi((s) => s.openComposer)
  const jumpTo = useUi((s) => s.jumpTo)
  const openEditor = useUi((s) => s.openContactEditor)
  const remove = usePimAction((core, cid: string) => core.deleteContact(cid))
  const email = c?.emails[0]?.value ?? ""
  // Cross-vertical context: conversations and meetings with this person.
  const { data: activity } = useContactActivity(id)
  // The same person's cards in other address books (ADR-0027).
  const { data: copies = [] } = useContactCopies(id)

  if (isPending) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col items-center gap-3 p-8">
        <Skeleton className="size-24 rounded-full" />
        <Skeleton className="h-6 w-48" />
      </div>
    )
  }
  if (error || !c) return <p className="p-6 text-sm text-muted-foreground">{error instanceof Error ? error.message : "That contact is gone."}</p>

  const book = books.find((b) => b.id === c.bookId)
  // A book's name with its account, so two "Contacts" books tell apart.
  const bookName = (id: string) => {
    const b = books.find((x) => x.id === id)
    const a = accounts.find((x) => x.id === b?.accountId)
    return a ? (b && b.name !== a.displayName && b.name !== "Contacts" ? `${a.displayName} · ${b.name}` : a.displayName) : (b?.name ?? "On this device")
  }
  const account = accounts.find((a) => a.id === book?.accountId)
  const phone = c.phones[0]?.value
  const del = async () => {
    // Close the card first: the delete refreshes contact queries, and an open
    // card would ask for itself again.
    onDeleted()
    try {
      await remove.mutateAsync(c.id)
      // Undo restores it from Recently deleted (its newest copy there).
      const core = await getCoreClient()
      const kept = (await core.deletedContacts()).find((d) => d.fullName === c.fullName)
      toast.success(`Deleted ${c.fullName}`, {
        duration: 6000,
        action: kept ? { label: "Undo", onClick: () => void core.restoreContact(kept.id).then((back) => jumpTo({ kind: "contact", id: back.id })).catch((e) => toast.error(String(e))) } : undefined,
      })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
      // It's still there: show it again.
      jumpTo({ kind: "contact", id: c.id })
    }
  }

  return (
    <article className="mx-auto flex max-w-2xl flex-col items-center gap-5 px-4 pb-10 text-center md:px-8 md:pt-8" aria-label={c.fullName}>
      <PersonAvatar contact={c} className="size-24 text-2xl" />
      <div>
        <h2 className="text-2xl font-semibold tracking-tight break-words">{c.fullName}</h2>
        {(c.title || c.org) && <p className="text-sm text-muted-foreground">{[c.title, c.org].filter(Boolean).join(" · ")}</p>}
        {c.labels.length > 0 && (
          <ul className="mt-2 flex flex-wrap justify-center gap-1.5" aria-label="Labels">
            {c.labels.map((l) => (
              <li key={l}>
                <Badge variant="secondary">{l}</Badge>
              </li>
            ))}
          </ul>
        )}
      </div>
      {/* Quick actions turn the card into a launcher (Cardhop). */}
      <div className="flex flex-wrap justify-center gap-2">
        <Action icon="mail" label="Email" disabled={!email} onClick={() => openComposer({ to: [{ name: c.fullName, email }] })} />
        <Action icon="call" label="Call" href={phone ? `tel:${phone.replace(/[^\d+]/g, "")}` : undefined} disabled={!phone} />
        <Action icon="chat" label="Message" href={phone ? `sms:${phone.replace(/[^\d+]/g, "")}` : undefined} disabled={!phone} />
        <ShareContact contact={c} className={ACTION} />
      </div>

      <dl className="flex w-full flex-col divide-y rounded-xl border text-left text-sm">
        {c.emails.map((e) => (
          <div key={`e-${e.value}`} className="flex flex-col px-4 py-2.5">
            <dt className="text-xs text-muted-foreground capitalize">{e.label ?? "email"}</dt>
            <dd>
              <Button variant="link" size="inline" onClick={() => openComposer({ to: [{ name: c.fullName, email: e.value }] })}>
                {e.value}
              </Button>
            </dd>
          </div>
        ))}
        {c.phones.map((p) => (
          <div key={`p-${p.value}`} className="flex flex-col px-4 py-2.5">
            <dt className="text-xs text-muted-foreground capitalize">{p.label ?? "phone"}</dt>
            <dd>
              <a href={`tel:${p.value.replace(/[^\d+]/g, "")}`} className="text-primary hover:underline">
                {p.value}
              </a>
            </dd>
          </div>
        ))}
        {c.birthday && (
          <div className="flex flex-col px-4 py-2.5">
            <dt className="text-xs text-muted-foreground">Birthday</dt>
            <dd>{birthdayLabel(c.birthday)}</dd>
          </div>
        )}
        {c.note && (
          <div className="flex flex-col px-4 py-2.5">
            <dt className="text-xs text-muted-foreground">Note</dt>
            <dd className="whitespace-pre-line">{c.note}</dd>
          </div>
        )}
        <div className="flex flex-col px-4 py-2.5">
          <dt className="text-xs text-muted-foreground">Saved in</dt>
          <dd>{account ? `${account.displayName}${book && book.name !== account.displayName ? ` · ${book.name}` : ""}` : "On this device (not synced)"}</dd>
        </div>
        {copies.length > 0 && (
          <div className="flex flex-col px-4 py-2.5">
            <dt className="text-xs text-muted-foreground">Also in</dt>
            <dd className="flex flex-wrap gap-1.5 pt-0.5">
              {copies.map((k) => (
                <Button key={k.id} size="xs" variant="outline" shape="pill" onClick={() => jumpTo({ kind: "contact", id: k.id })} aria-label={`Open ${k.fullName} in ${bookName(k.bookId)}`}>
                  {bookName(k.bookId)}
                  {k.fullName !== c.fullName && <span className="text-muted-foreground">as {k.fullName}</span>}
                </Button>
              ))}
            </dd>
          </div>
        )}
      </dl>

      {c.writable ? (
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() =>
              openEditor({ contactId: c.id, initial: { bookId: c.bookId, fullName: c.fullName, org: c.org, title: c.title, emails: c.emails, phones: c.phones, birthday: c.birthday, note: c.note, labels: c.labels, photo: c.photo } })
            }
          >
            <Icon name="edit" data-icon="inline-start" /> Edit
          </Button>
          <Button variant="outline" onClick={() => void del()} disabled={remove.isPending}>
            <Icon name="delete" data-icon="inline-start" /> Delete
          </Button>
        </div>
      ) : (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Icon name="lock" className="size-4" /> This address book is read-only.
        </p>
      )}

      {activity && <Activity activity={activity} />}
      <LinkedNotes target={{ kind: "contact", id: c.id }} title={c.fullName} />
    </article>
  )
}

/** Recent conversations and meetings, each opening where it lives (Mail, Calendar). */
export function Activity({ activity: { threads, upcoming, past }, onThread }: { activity: ContactActivity; onThread?: (row: MessageSummary) => void }) {
  const jumpTo = useUi((s) => s.jumpTo)
  const now = useNowSecs()
  const meeting = (o: Occurrence) => (
    <li key={`${o.eventId}-${o.start}`} className="flex items-center gap-2 border-b last:border-0">
      <button type="button" className="flex min-w-0 flex-1 flex-col py-2 text-left text-sm hover:text-primary" onClick={() => jumpTo({ kind: "event", id: o.eventId, start: o.start })}>
        <span className="truncate">{o.title || "(no title)"}</span>
        <span className="truncate text-xs text-muted-foreground">
          {dayLabel(fromSecs(o.start))} · {rangeLabel(o.start, o.end, o.allDay)}
        </span>
      </button>
      {o.meetingUrl && o.end > now && <JoinButton url={o.meetingUrl} appUrl={o.meetingAppUrl} variant="outline" className="shrink-0" />}
    </li>
  )
  if (!threads.length && !upcoming.length && !past.length) return null
  return (
    <div className="flex w-full flex-col gap-5 text-left">
      {upcoming.length > 0 && (
        <section aria-label="Upcoming meetings">
          <h3 className="pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Upcoming</h3>
          <ul>{upcoming.map(meeting)}</ul>
        </section>
      )}
      {threads.length > 0 && (
        <section aria-label="Recent mail">
          <h3 className="pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Recent mail</h3>
          <ul>
            {threads.map((t) => (
              <li key={t.threadId}>
                <Item size="xs" render={<button type="button" onClick={() => (onThread ? onThread(t) : jumpTo({ kind: "thread", id: t.threadId, row: t }))} />}>
                  <ItemContent>
                    <span className={t.seen ? "truncate" : "truncate font-semibold"}>{t.subject || "(no subject)"}</span>
                  </ItemContent>
                  <ItemActions>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {t.threadCount > 1 && <span aria-label={`${t.threadCount} messages`}>{t.threadCount} · </span>}
                      {shortTime(t.date)}
                    </span>
                  </ItemActions>
                </Item>
              </li>
            ))}
          </ul>
        </section>
      )}
      {past.length > 0 && (
        <section aria-label="Past meetings">
          <h3 className="pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Met recently</h3>
          <ul>{past.map(meeting)}</ul>
        </section>
      )}
    </div>
  )
}
