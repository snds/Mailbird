import { useDeferredValue, useEffect, useState } from "react"

import { pendingJump, useUi } from "@/app/ui-store"

import { Icon } from "@/components/icon"
import { ListRow, SearchField } from "@/components/list-row"
import { MasterDetail, PaneHeader } from "@/components/master-detail"
import { Button } from "@/components/ui/button"
import { useContactLabels, useContacts, useDeletedContacts, useDuplicates } from "@/core/queries"
import type { ContactSummary } from "@/core/types"

import { ContactDetailPane } from "./contact-detail"
import { DuplicatesPane } from "./duplicates"
import { PersonAvatar } from "./person"
import { RecentlyDeletedPane } from "./recently-deleted"

/** Section letter for the A–Z list (accents fold: "Élodie" files under E). */
const letter = (c: ContactSummary) => {
  const words = c.fullName.trim().split(/\s+/)
  const first = (c.fullName === c.org ? words[0] : words.at(-1))?.[0] ?? "#"
  const base = first.normalize("NFD").replace(/\p{M}/gu, "").toUpperCase()
  return /[A-Z]/.test(base) ? base : "#"
}

type Selection = { kind: "contact"; id: string } | { kind: "duplicates" } | { kind: "deleted" } | null

export function ContactsView() {
  const [selected, setSelected] = useState<Selection>(() => {
    const j = pendingJump("contact")
    return j ? { kind: "contact", id: j.id } : null
  })
  useEffect(() => void useUi.getState().takeJump("contact"), [])
  // A jump while Contacts is already open (a birthday, an Undo) selects that card.
  useEffect(
    () =>
      useUi.subscribe((s) => {
        if (s.jump?.kind !== "contact") return
        setSelected({ kind: "contact", id: s.jump.id })
        s.takeJump("contact")
      }),
    [],
  )
  const [search, setSearch] = useState("")
  const [label, setLabel] = useState<string | null>(null)
  const query = useDeferredValue(search.trim())
  const { data: labels = [] } = useContactLabels()
  // A label that's gone (its last contact edited or deleted) stops filtering.
  const active = label && labels.some((l) => l.name === label) ? label : null
  const { data: contacts = [], isPending } = useContacts(query, active)
  const { data: dupes = [] } = useDuplicates()
  const { data: gone = [] } = useDeletedContacts()

  // The core sorts by family name; group consecutive rows by that letter.
  const sections: { letter: string; items: ContactSummary[] }[] = []
  for (const c of contacts) {
    const l = letter(c)
    if (sections.at(-1)?.letter === l) sections.at(-1)!.items.push(c)
    else sections.push({ letter: l, items: [c] })
  }

  return (
    <MasterDetail
      emptyIcon="person"
      emptyLabel="Select a person to see their details and the mail you've exchanged."
      onBack={() => setSelected(null)}
      header={
        <>
          <PaneHeader title="Contacts" />
          <div className="px-4 pb-3">
            <SearchField placeholder="Search people" value={search} onChange={setSearch} />
            {labels.length > 0 && (
              <div role="group" aria-label="Labels" className="-mx-4 no-scrollbar mt-3 flex gap-1.5 overflow-x-auto px-4">
                {[{ name: null, count: 0 } as const, ...labels].map((l) => (
                  <Button key={l.name ?? "all"} size="xs" variant={active === l.name ? "secondary" : "ghost"} aria-pressed={active === l.name} className="shrink-0 rounded-full px-3" onClick={() => setLabel(l.name)}>
                    {l.name ?? "All"}
                    {l.name && <span className="text-muted-foreground tabular-nums">{l.count}</span>}
                  </Button>
                ))}
              </div>
            )}
          </div>
        </>
      }
      list={
        <div role="list" aria-label="Contacts">
          {dupes.length > 0 && !query && !active && (
            <button
              type="button"
              onClick={() => setSelected({ kind: "duplicates" })}
              data-selected={selected?.kind === "duplicates"}
              className="mx-3 mb-2 flex w-[calc(100%-1.5rem)] items-center gap-3 rounded-xl bg-muted/70 px-3 py-2.5 text-left text-sm hover:bg-muted data-[selected=true]:bg-surface-selected"
            >
              <Icon name="group" className="size-5 text-vertical-contacts" />
              <span className="flex-1">
                <span className="font-medium">
                  {dupes.length} possible duplicate{dupes.length === 1 ? "" : "s"}
                </span>
                <span className="block text-xs text-muted-foreground">Review and merge</span>
              </span>
              <Icon name="chevron_right" className="size-4 text-muted-foreground" />
            </button>
          )}
          {!isPending && contacts.length === 0 && (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              {query ? `No one matches “${query}”${active ? ` in ${active}` : ""}.` : active ? `No one has the ${active} label.` : "No contacts yet."}
            </p>
          )}
          {sections.map((s) => (
            <section key={s.letter} aria-label={s.letter}>
              <h3 className="sticky top-0 z-10 bg-surface-chrome/95 px-4 py-1 text-xs font-semibold text-muted-foreground backdrop-blur">{s.letter}</h3>
              {s.items.map((c) => (
                <div role="listitem" key={c.id}>
                  <ListRow
                    selected={selected?.kind === "contact" && selected.id === c.id}
                    onSelect={() => setSelected({ kind: "contact", id: c.id })}
                    leading={<PersonAvatar contact={c} />}
                    title={c.fullName}
                    supporting={c.org ?? c.emails[0]?.value ?? c.phones[0]?.value}
                  />
                </div>
              ))}
            </section>
          ))}
          {gone.length > 0 && !query && !active && (
            <button
              type="button"
              onClick={() => setSelected({ kind: "deleted" })}
              data-selected={selected?.kind === "deleted"}
              className="mx-3 my-3 flex w-[calc(100%-1.5rem)] items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm text-muted-foreground hover:bg-muted data-[selected=true]:bg-surface-selected"
            >
              <Icon name="delete" className="size-5" />
              <span className="flex-1">Recently deleted</span>
              <span className="tabular-nums">{gone.length}</span>
              <Icon name="chevron_right" className="size-4" />
            </button>
          )}
        </div>
      }
      detail={
        selected?.kind === "deleted" ? (
          <RecentlyDeletedPane onRestored={(id) => setSelected({ kind: "contact", id })} />
        ) : selected?.kind === "duplicates" ? (
          <DuplicatesPane />
        ) : selected?.kind === "contact" ? (
          <ContactDetailPane key={selected.id} id={selected.id} onDeleted={() => setSelected(null)} />
        ) : null
      }
    />
  )
}
