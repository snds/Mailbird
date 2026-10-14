import { toast } from "sonner"

import { useUi } from "@/app/ui-store"
import { Icon, type IconName } from "@/components/icon"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useAccounts, useCollections, useContact, useMessages, usePimAction } from "@/core/queries"
import { shortTime } from "@/lib/time"

import { PersonAvatar } from "./person"

/** "1990-04-02" → "April 2, 1990"; "--04-02" → "April 2". */
function birthdayLabel(b: string) {
  const m = /^(\d{4}|-)-?(\d{2})-(\d{2})$/.exec(b)
  if (!m) return b
  const d = new Date(m[1] === "-" ? 2000 : +m[1]!, +m[2]! - 1, +m[3]!)
  return d.toLocaleDateString(undefined, { month: "long", day: "numeric", ...(m[1] === "-" ? {} : { year: "numeric" }) })
}

function Action({ icon, label, href, onClick, disabled }: { icon: IconName; label: string; href?: string; onClick?: () => void; disabled?: boolean }) {
  const cls = "h-auto min-w-18 flex-col gap-1 px-3 py-2 text-xs"
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
  const { data: books = [] } = useCollections("contacts")
  const { data: accounts = [] } = useAccounts()
  const openComposer = useUi((s) => s.openComposer)
  const openEditor = useUi((s) => s.openContactEditor)
  const remove = usePimAction((core, cid: string) => core.deleteContact(cid))
  const email = c?.emails[0]?.value ?? ""
  // Cross-vertical context: mail you've exchanged with this person.
  const { data: found = [] } = useMessages({ lane: "inbox", search: email || null, limit: 20 })
  const threads = c ? found.filter((m) => c.emails.some((e) => e.value.toLowerCase() === m.from.email.toLowerCase())).slice(0, 5) : []

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
  const account = accounts.find((a) => a.id === book?.accountId)
  const phone = c.phones[0]?.value
  const del = async () => {
    try {
      await remove.mutateAsync(c.id)
      toast.success(`Deleted ${c.fullName}`, { duration: 2500 })
      onDeleted()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <article className="mx-auto flex max-w-2xl flex-col items-center gap-5 px-4 pb-10 text-center md:px-8 md:pt-8" aria-label={c.fullName}>
      <PersonAvatar contact={c} className="size-24 text-2xl" />
      <div>
        <h2 className="text-2xl font-semibold tracking-tight break-words">{c.fullName}</h2>
        {(c.title || c.org) && <p className="text-sm text-muted-foreground">{[c.title, c.org].filter(Boolean).join(" · ")}</p>}
      </div>
      {/* Quick actions turn the card into a launcher (Cardhop). */}
      <div className="flex flex-wrap justify-center gap-2">
        <Action icon="mail" label="Email" disabled={!email} onClick={() => openComposer({ to: [{ name: c.fullName, email }] })} />
        <Action icon="call" label="Call" href={phone ? `tel:${phone.replace(/[^\d+]/g, "")}` : undefined} disabled={!phone} />
        <Action icon="chat" label="Message" href={phone ? `sms:${phone.replace(/[^\d+]/g, "")}` : undefined} disabled={!phone} />
      </div>

      <dl className="flex w-full flex-col divide-y rounded-xl border text-left text-sm">
        {c.emails.map((e) => (
          <div key={`e-${e.value}`} className="flex flex-col px-4 py-2.5">
            <dt className="text-xs text-muted-foreground capitalize">{e.label ?? "email"}</dt>
            <dd>
              <button type="button" className="text-primary hover:underline" onClick={() => openComposer({ to: [{ name: c.fullName, email: e.value }] })}>
                {e.value}
              </button>
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
      </dl>

      {c.writable ? (
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() =>
              openEditor({ contactId: c.id, initial: { bookId: c.bookId, fullName: c.fullName, org: c.org, title: c.title, emails: c.emails, phones: c.phones, birthday: c.birthday, note: c.note } })
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

      {threads.length > 0 && (
        <section className="w-full text-left" aria-label="Recent mail">
          <h3 className="pb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Recent mail</h3>
          {threads.map((t) => (
            <p key={t.id} className="flex gap-2 border-b py-2 text-sm last:border-0">
              <span className="min-w-0 flex-1 truncate">{t.subject || "(no subject)"}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{shortTime(t.date)}</span>
            </p>
          ))}
        </section>
      )}
    </article>
  )
}
