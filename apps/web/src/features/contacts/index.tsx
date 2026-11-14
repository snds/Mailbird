import { useDeferredValue, useEffect, useState } from "react"

import { useRefresh, useScreenFact, useScreenPlace } from "@/app/screen"
import { pendingJump, useUi } from "@/app/ui-store"
import { vertical } from "@/app/verticals"

import { Icon, Button, formatNavCount, Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@unicron/ui"
import { EntryRow, ListSearch } from "@/components/list-row"
import { MasterDetail } from "@/components/master-detail"
import { ScreenHead } from "@/components/page"
import { useAccounts, useCollections, useContactLabels, useContacts, useDeletedContacts, useDuplicates, useSmartGroups } from "@/core/queries"
import type { ContactSummary } from "@/core/types"

import { ContactDetailPane } from "./contact-detail"
import { DuplicatesPane } from "./duplicates"
import { PersonAvatar } from "./person"
import { RecentlyDeletedPane } from "./recently-deleted"
import { RestoreContactsDialog } from "./restore"
import { SmartGroupChips } from "./smart-groups"

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
  const [group, setGroup] = useState<string | null>(null)
  const { data: groups = [] } = useSmartGroups()
  const activeGroup = groups.find((g) => g.id === group) ?? null
  const [restoring, setRestoring] = useState<number | null>(null)
  const { data: contacts = [], isPending, refetch } = useContacts(query, active, activeGroup?.id ?? null)
  const { data: dupes = [] } = useDuplicates()
  // Source badges (ADR-0027): with more than one address book showing, each
  // row says where that card lives, so you edit the copy you mean.
  const { data: books = [] } = useCollections("contacts")
  const { data: accounts = [] } = useAccounts()
  const shown = books.filter((b) => !b.hidden && b.id !== "birthdays")
  const sourceOf = (bookId: string) => {
    if (shown.length < 2) return null
    const b = books.find((x) => x.id === bookId)
    return accounts.find((a) => a.id === b?.accountId)?.displayName ?? b?.name ?? null
  }
  const { data: gone = [] } = useDeletedContacts()

  // The core sorts by family name; group consecutive rows by that letter.
  const sections: { letter: string; items: ContactSummary[] }[] = []
  for (const c of contacts) {
    const l = letter(c)
    if (sections.at(-1)?.letter === l) sections.at(-1)!.items.push(c)
    else sections.push({ letter: l, items: [c] })
  }

  // What the shell says about this screen (ADR-0083): the group as the place, and how many people it lists.
  const place = active ?? activeGroup?.name ?? "All contacts"
  useScreenPlace(place)
  useScreenFact(isPending ? null : `${formatNavCount(contacts.length)} people`)
  useRefresh(refetch)

  return (
    <MasterDetail
      section="Contacts"
      pick={vertical("contacts").pick}
      onBack={() => setSelected(null)}
      header={
        <>
          <ScreenHead
            overline={`${active ?? activeGroup?.name ?? "Contacts"} // ${isPending ? "" : formatNavCount(contacts.length)}`}
            title={active ?? activeGroup?.name ?? "People"}
            actions={
              <Button size="icon" variant="ghost" aria-label="Restore contacts" onClick={() => setRestoring(Math.floor(Date.now() / 1000))}>
                <Icon name="recently-viewed" />
              </Button>
            }
            below={
              <>
            <ListSearch placeholder="Search people" value={search} onChange={setSearch} />
            {labels.length > 0 && (
              <div role="group" aria-label="Labels" className="no-scrollbar mt-3 flex gap-1.5 overflow-x-auto">
                {[{ name: null, count: 0 } as const, ...labels].map((l) => (
                  <Button key={l.name ?? "all"} size="xs" variant={active === l.name ? "secondary" : "ghost"} aria-pressed={active === l.name} shape="pill" onClick={() => setLabel(l.name)}>
                    {l.name ?? "All"}
                    {l.name && <span className="text-muted-foreground tabular-nums">{l.count}</span>}
                  </Button>
                ))}
              </div>
            )}
            <SmartGroupChips active={activeGroup?.id ?? null} onPick={(id) => (setGroup(id), setSelected(null))} />
              </>
            }
          />
          <RestoreContactsDialog openedAt={restoring} onClose={() => setRestoring(null)} />
        </>
      }
      list={
        <div role="list" aria-label="Contacts">
          {dupes.length > 0 && !query && !active && !activeGroup && (
            <div className="px-3 pb-2">
              <Item variant="muted" render={<button type="button" data-selected={selected?.kind === "duplicates"} onClick={() => setSelected({ kind: "duplicates" })} />}>
                <ItemMedia>
                  <Icon name="user--multiple" />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>
                    {dupes.length} possible duplicate{dupes.length === 1 ? "" : "s"}
                  </ItemTitle>
                  <ItemDescription>Review and merge</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Icon name="chevron--right" tone="muted" />
                </ItemActions>
              </Item>
            </div>
          )}
          {!isPending && contacts.length === 0 && (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              {query
                ? `No one matches “${query}”${active ? ` in ${active}` : activeGroup ? ` in ${activeGroup.name}` : ""}.`
                : active
                  ? `No one has the ${active} label${activeGroup ? ` in ${activeGroup.name}` : ""}.`
                  : activeGroup
                    ? `No one fits ${activeGroup.name} right now. People join as their cards change.`
                    : "No contacts yet."}
            </p>
          )}
          {sections.map((s) => (
            <section key={s.letter} aria-label={s.letter}>
              <h3 className="sticky top-0 z-10 bg-surface-ground/95 px-4 py-1 text-xs font-semibold text-muted-foreground backdrop-blur">{s.letter}</h3>
              {s.items.map((c) => (
                <div role="listitem" key={c.id}>
                  <EntryRow
                    selected={selected?.kind === "contact" && selected.id === c.id}
                    onSelect={() => setSelected({ kind: "contact", id: c.id })}
                    leading={<PersonAvatar contact={c} />}
                    title={c.fullName}
                    supporting={c.org ?? c.emails[0]?.value ?? c.phones[0]?.value}
                    trailing={sourceOf(c.bookId) && <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{sourceOf(c.bookId)}</span>}
                  />
                </div>
              ))}
            </section>
          ))}
          {gone.length > 0 && !query && !active && !activeGroup && (
            <div className="p-3 text-muted-foreground">
              <Item render={<button type="button" data-selected={selected?.kind === "deleted"} onClick={() => setSelected({ kind: "deleted" })} />}>
                <ItemMedia>
                  <Icon name="trash-can" />
                </ItemMedia>
                <ItemContent>Recently deleted</ItemContent>
                <ItemActions>
                  <span className="tabular-nums">{gone.length}</span>
                  <Icon name="chevron--right" />
                </ItemActions>
              </Item>
            </div>
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
