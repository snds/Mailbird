import { useDeferredValue, useEffect, useState } from "react"

import { useRefresh, useScreenFact, useScreenPlace } from "@/app/screen"
import { useSectionSwitcher } from "@/app/places"
import { SectionSwitcher } from "@/app/section-switcher"
import { pendingJump, useUi } from "@/app/ui-store"
import { vertical } from "@/app/verticals"

import { Icon, formatNavCount, Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@unicron/ui"
import { EntryRow, ListSearch } from "@/components/list-row"
import { MasterDetail } from "@/components/master-detail"
import { ScreenHead } from "@/components/page"
import { useAccounts, useCollections, useContacts, useDeletedContacts, useDuplicates } from "@/core/queries"
import type { ContactSummary } from "@/core/types"

import { ContactDetailPane } from "./contact-detail"
import { ContactsNav } from "./contacts-nav"
import { DuplicatesPane } from "./duplicates"
import { PersonAvatar } from "./person"
import { RecentlyDeletedPane } from "./recently-deleted"
import { closeRestoreContacts, useRestoreContacts } from "./open-restore"
import { RestoreContactsDialog } from "./restore"
import { SmartGroupEditor } from "./smart-groups"
import { contactsPlaceName, useContactsPlace } from "./use-contacts-place"

/** Section letter for the A–Z list (accents fold: "Élodie" files under E). */
const letter = (c: ContactSummary) => {
  const words = c.fullName.trim().split(/\s+/)
  const first = (c.fullName === c.org ? words[0] : words.at(-1))?.[0] ?? "#"
  const base = first.normalize("NFD").replace(/\p{M}/gu, "").toUpperCase()
  return /[A-Z]/.test(base) ? base : "#"
}

export function ContactsView() {
  // The open card. Which list it is picked from is the place (ADR-0084): everyone, a label, a smart group;
  // Duplicates and Recently deleted are places too, and take the list's room.
  // `keep`: opened by a jump that also changed the place, so that change of place leaves it open.
  const [open, setOpen] = useState<{ id: string; keep?: boolean } | null>(() => {
    const id = pendingJump("contact")?.id
    return id ? { id } : null
  })
  const selected = open?.id ?? null
  const setSelected = (id: string | null) => setOpen(id ? { id } : null)
  useEffect(() => void useUi.getState().takeJump("contact"), [])
  // A jump while Contacts is already open (a birthday, an Undo) selects that card.
  useEffect(
    () =>
      useUi.subscribe((s, before) => {
        if (s.jump?.kind !== "contact") return
        setOpen({ id: s.jump.id, keep: s.contactsPlace !== before.contactsPlace })
        s.takeJump("contact")
      }),
    [],
  )
  const [search, setSearch] = useState("")
  const query = useDeferredValue(search.trim())
  // A label or a smart group that's gone (its last contact edited, the group deleted) gives way to everyone.
  const at = useContactsPlace()
  const { place } = at
  const setPlace = useUi((s) => s.setContactsPlace)
  const active = place.kind === "label" ? place.name : null
  const activeGroup = place.kind === "group" ? at.group : null
  const tool = place.kind === "duplicates" || place.kind === "deleted"
  // Another place, picked in the nav: the card that was open belongs to the one left behind.
  const placeKey = JSON.stringify(place)
  const [placeSeen, setPlaceSeen] = useState(placeKey)
  if (placeSeen !== placeKey) {
    setPlaceSeen(placeKey)
    setOpen(open?.keep ? { id: open.id } : null)
  }
  const restoring = useRestoreContacts((s) => s.openedAt)
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
  const placeName = contactsPlaceName(at)
  useScreenPlace(placeName)
  useScreenFact(isPending || tool ? null : `${formatNavCount(contacts.length)} people`)
  useRefresh(refetch)
  // The page head opens the groups wherever the sidebar does not list them (brief X1).
  const switching = useSectionSwitcher("Change group.")
  const switcher = (
    <SectionSwitcher state={switching} overline={`Contacts // ${placeName}`} title="Groups">
      <ContactsNav layer />
    </SectionSwitcher>
  )

  if (tool) {
    // A clean-up tool has the list's room and no detail beside it; a card it restores opens among everyone.
    return (
      <>
        <MasterDetail
          section="Contacts"
          pick={vertical("contacts").pick}
          listFills
          onBack={() => setPlace({ kind: "all" })}
          header={
            <ScreenHead
              overline={place.kind === "duplicates" ? `Duplicates // ${formatNavCount(dupes.length)} ${dupes.length === 1 ? "set" : "sets"}` : "Recently deleted // 30 days"}
              title={placeName}
              switcher={switching.switcher}
              below={switcher}
            />
          }
          list={
            place.kind === "duplicates" ? (
              <DuplicatesPane />
            ) : (
              <RecentlyDeletedPane
                onRestored={(id) => {
                  useUi.getState().jumpTo({ kind: "contact", id })
                }}
              />
            )
          }
          detail={null}
        />
        <Layers restoring={restoring} />
      </>
    )
  }

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
            switcher={switching.switcher}
            below={
              <>
            {switcher}
            <ListSearch placeholder="Search people" value={search} onChange={setSearch} />
              </>
            }
          />
          <Layers restoring={restoring} />
        </>
      }
      list={
        <div role="list" aria-label="Contacts">
          {dupes.length > 0 && !query && !active && !activeGroup && (
            <div className="px-3 pb-2">
              <Item variant="muted" render={<button type="button" onClick={() => setPlace({ kind: "duplicates" })} />}>
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
                    selected={selected === c.id}
                    onSelect={() => setSelected(c.id)}
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
              <Item render={<button type="button" onClick={() => setPlace({ kind: "deleted" })} />}>
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
      detail={selected ? <ContactDetailPane key={selected} id={selected} onDeleted={() => setSelected(null)} /> : null}
    />
  )
}

/** What the groups list opens over Contacts (brief X1): Restore contacts by its intent, and the smart group form. */
function Layers({ restoring }: { restoring: number | null }) {
  return (
    <>
      <RestoreContactsDialog openedAt={restoring} onClose={closeRestoreContacts} />
      <SmartGroupEditor />
    </>
  )
}
