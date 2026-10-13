import { useState } from "react"

import { Icon } from "@/components/icon"
import { ListRow, SearchField } from "@/components/list-row"
import { MasterDetail, PaneHeader } from "@/components/master-detail"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useMessages } from "@/core/queries"
import { contacts } from "@/data/mock"

const initials = (name: string) => name.split(" ").map((p) => p[0]).slice(0, 2).join("")

export function ContactsView() {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = contacts.find((c) => c.id === selectedId) ?? null
  // Cross-vertical context: the contact card shows mail you've exchanged.
  const { data: found = [] } = useMessages({ lane: "inbox", search: selected?.email ?? "", limit: 5 })
  const threads = selected ? found.filter((m) => m.from.email === selected.email) : []

  return (
    <MasterDetail
      emptyIcon="person"
      emptyLabel="Select a person to see their details and shared history."
      onBack={() => setSelectedId(null)}
      header={
        <>
          <PaneHeader title="Contacts" />
          <div className="px-4 pb-3">
            <SearchField placeholder="Search people" />
          </div>
        </>
      }
      list={contacts.map((c) => (
        <ListRow
          key={c.id}
          selected={c.id === selectedId}
          onSelect={() => setSelectedId(c.id)}
          leading={
            <Avatar>
              <AvatarFallback>{initials(c.name)}</AvatarFallback>
            </Avatar>
          }
          title={c.name}
          meta={c.source}
          supporting={c.company ?? c.email}
        />
      ))}
      detail={
        selected && (
          <div className="mx-auto flex max-w-2xl flex-col items-center gap-4 px-4 pb-8 text-center md:px-8 md:pt-8">
            <Avatar className="size-24 text-2xl">
              <AvatarFallback>{initials(selected.name)}</AvatarFallback>
            </Avatar>
            <div>
              <h2 className="text-xl font-semibold tracking-tight">{selected.name}</h2>
              {selected.company && <p className="text-sm text-muted-foreground">{selected.company}</p>}
            </div>
            {/* Quick actions turn the card into a launcher (Cardhop). */}
            <div className="flex gap-2">
              {(
                [
                  ["mail", "Mail"],
                  ["call", "Call"],
                  ["chat", "Message"],
                  ["videocam", "Video"],
                ] as const
              ).map(([icon, label]) => (
                <Button key={icon} variant="secondary" className="h-auto flex-col gap-1 px-4 py-2 text-xs">
                  <Icon name={icon} className="size-5" />
                  {label}
                </Button>
              ))}
            </div>
            <dl className="grid w-full grid-cols-[auto_1fr] gap-x-3 gap-y-2 rounded-xl border p-4 text-left text-sm">
              <Icon name="alternate_email" className="text-muted-foreground" />
              <dd>{selected.email}</dd>
              {selected.phone && (
                <>
                  <Icon name="call" className="text-muted-foreground" />
                  <dd>{selected.phone}</dd>
                </>
              )}
              <Icon name="cloud" className="text-muted-foreground" />
              <dd>
                <Badge variant="outline">{selected.source}</Badge>
              </dd>
            </dl>
            {threads.length > 0 && (
              <section className="w-full text-left">
                <h3 className="pb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Recent mail</h3>
                {threads.map((t) => (
                  <p key={t.id} className="truncate border-b py-2 text-sm last:border-0">
                    {t.subject}
                  </p>
                ))}
              </section>
            )}
          </div>
        )
      }
    />
  )
}
