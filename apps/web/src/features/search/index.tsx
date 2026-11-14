import { useDeferredValue, useEffect, type ReactNode } from "react"

import type { SearchScope } from "@/app/places"
import { useScreenFact, useScreenPlace } from "@/app/screen"
import { useUi } from "@/app/ui-store"
import { AppFrameInset, Button, EmptyState, FilterChip, FilterChipGroup, SearchField, SectionHeader, Skeleton, formatNavCount } from "@unicron/ui"
import { MasterDetail } from "@/components/master-detail"
import { isMember } from "@/core/client"
import { useAccounts, useCollections, useMe } from "@/core/queries"
import type { ContactSummary, MessageSummary, NoteSummary, Occurrence } from "@/core/types"
import { OccurrenceCard } from "@/features/calendar/occurrence-card"
import { calendarSwatches, eventSwatch } from "@/features/calendar/swatches"
import { PersonRow } from "@/features/contacts/person-row"
import { LANES } from "@/features/mail/lanes"
import { MessageRow } from "@/features/mail/message-row"
import { NoteRow } from "@/features/notes/note-row"
import { useNowSecs } from "@/hooks/use-now"

import { setSearchField } from "./field"
import { leaveSearch } from "./open"
import { EVENT_DAYS, useContactResults, useEventResults, useLaneResults, useMailResults, useNoteResults, type Results } from "./use-results"

type Kind = "mail" | "calendar" | "contacts" | "notes"

/** Each kind as its chip, its section header and its empty line name it. */
const KINDS: { id: Kind; chip: string; header: string; none: (q: string) => string }[] = [
  { id: "mail", chip: "Mail", header: "Mail // newest first", none: (q) => `No mail has “${q}”.` },
  { id: "calendar", chip: "Calendar", header: `Events // ${EVENT_DAYS.back} days back, ${EVENT_DAYS.ahead} ahead`, none: (q) => `No event from ${EVENT_DAYS.back} days back to ${EVENT_DAYS.ahead} ahead has “${q}”.` },
  { id: "contacts", chip: "Contacts", header: "People", none: (q) => `No one matches “${q}”.` },
  { id: "notes", chip: "Notes", header: "Notes", none: (q) => `No note has “${q}”.` },
]
/** How many rows of each kind All shows before "Show all". */
const PEEK = 3

/**
 * Search, as a place of its own (ADR-0085; the base of brief X2): one field,
 * and chips that say what it looks through. It stands in the list column in
 * place of the open section, which stays as it was behind it. A result opens
 * where it lives, in its own section; the browser's Back returns here with
 * the words kept. Esc clears the field, and with nothing in it leaves for
 * where you came from.
 */
export function SearchView() {
  const place = useUi((s) => s.search)
  const setQuery = useUi((s) => s.setSearchQuery)
  const setScope = useUi((s) => s.setSearchScope)
  // A team member works the mail and nothing else (ADR-0063): no chips, and never more than mail.
  const member = isMember()
  const asked = place?.scope ?? "all"
  const lane = place?.lane ?? null
  const scope: SearchScope = asked === "lane" ? (lane ? "lane" : "mail") : member ? "mail" : asked
  const typed = place?.query ?? ""
  const query = useDeferredValue(typed.trim())
  const on = query !== ""

  // Mail's account choice narrows mail here as it does there (brief X2).
  const accountId = useUi((s) => s.mailAccount)
  const { data: accounts = [] } = useAccounts()
  const account = accounts.find((a) => a.id === accountId)?.id ?? null
  const me = useMe()
  const now = useNowSecs()
  const { data: calendars = [] } = useCollections("calendar")
  const swatches = calendarSwatches(calendars)

  const inLane = useLaneResults(lane, account, me.id, query, on && scope === "lane")
  const mail = useMailResults(account, query, on && (scope === "mail" || scope === "all"))
  const events = useEventResults(query, now, on && (scope === "calendar" || scope === "all"))
  const people = useContactResults(query, on && (scope === "contacts" || scope === "all"))
  const notes = useNoteResults(query, on && (scope === "notes" || scope === "all"))

  const jumpTo = useUi((s) => s.jumpTo)
  const accountOf = (m: MessageSummary) => (accounts.length > 1 && !account ? accounts.find((a) => a.id === m.accountId)?.displayName : undefined)
  const rows: { [K in Kind]: (limit?: number) => ReactNode } = {
    mail: (limit) =>
      (scope === "lane" ? inLane : mail).rows.slice(0, limit).map((m) => (
        <MessageRow key={m.threadId} message={m} now={now} account={accountOf(m)} query={query} onOpen={() => jumpTo({ kind: "thread", id: m.threadId, row: m })} />
      )),
    calendar: (limit) =>
      events.rows.slice(0, limit).map((o) => (
        <OccurrenceCard
          key={`${o.eventId}/${o.start}`}
          occurrence={o}
          date
          swatch={eventSwatch(swatches.get(o.calendarId))}
          query={query}
          // A birthday is its person's, as on the calendar.
          onOpen={() => jumpTo(o.contactId ? { kind: "contact", id: o.contactId } : { kind: "event", id: o.eventId, start: o.start })}
        />
      )),
    contacts: (limit) => people.rows.slice(0, limit).map((c) => <PersonRow key={c.id} contact={c} query={query} onOpen={() => jumpTo({ kind: "contact", id: c.id })} />),
    notes: (limit) => notes.rows.slice(0, limit).map((n) => <NoteRow key={n.id} note={n} query={query} onOpen={() => jumpTo({ kind: "note", id: n.id })} />),
  }
  const found: { [K in Kind]: Results<MessageSummary | Occurrence | ContactSummary | NoteSummary> } = { mail: scope === "lane" ? inLane : mail, calendar: events, contacts: people, notes }
  const shown: Kind[] = scope === "all" ? ["mail", "calendar", "contacts", "notes"] : [scope === "lane" ? "mail" : scope]
  const pending = shown.some((k) => found[k].pending)
  const failed = shown.filter((k) => found[k].failed)
  const total = shown.reduce((n, k) => n + found[k].rows.length, 0)
  const complete = shown.every((k) => found[k].complete)

  const laneName = lane ? LANES.find((l) => l.id === lane)!.label : null
  const name = scope === "lane" ? laneName! : scope === "all" ? "Everything" : KINDS.find((k) => k.id === scope)!.chip
  // What the shell says (brief X2): SEARCH // MAIL, and the count once every row is in.
  useScreenPlace(name)
  useScreenFact(on && !pending && complete ? `${formatNavCount(total)} ${total === 1 ? "result" : "results"}` : null)

  // Esc from anywhere on the screen but the field: clear the words first, then leave. The field does the same itself.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return
      const t = e.target as HTMLElement
      if (t.closest("input, textarea, select, [contenteditable=true], [role=dialog], [role=menu]")) return
      const ui = useUi.getState()
      if (!ui.search || ui.settings || ui.composer || ui.paletteOpen || ui.shortcutsOpen) return
      e.preventDefault()
      if (ui.search.query) ui.setSearchQuery("")
      else leaveSearch()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const none = scope === "lane" ? `Nothing in ${laneName} has “${query}”.` : scope === "all" ? `Nothing in Vale has “${query}”.` : KINDS.find((k) => k.id === scope)!.none(query)

  return (
    <MasterDetail
      section="Search"
      pick="Pick a result to open it where it lives."
      onBack={leaveSearch}
      onRoot={() => setQuery("")}
      detail={null}
      header={
        <AppFrameInset>
          <div className="flex flex-col gap-3 pb-4">
            <SearchField
              ref={setSearchField}
              autoFocus
              label={`Search ${name}`}
              value={typed}
              onValueChange={setQuery}
              // With words in it, Esc clears them (the field's own rule); with none, it leaves Search.
              onKeyDown={(e) => {
                if (e.key !== "Escape" || typed) return
                e.preventDefault()
                leaveSearch()
              }}
            />
            {!member && (
              <FilterChipGroup label="Search in" scroll value={scope} onValueChange={(v) => setScope(v as SearchScope)}>
                {laneName && <FilterChip value="lane">{laneName}</FilterChip>}
                <FilterChip value="all">All</FilterChip>
                {KINDS.map((k) => (
                  <FilterChip key={k.id} value={k.id}>
                    {k.chip}
                  </FilterChip>
                ))}
              </FilterChipGroup>
            )}
          </div>
        </AppFrameInset>
      }
      list={
        !on ? null : (
          <div role="region" aria-label="Results" aria-busy={pending || undefined} className="flex flex-col gap-4 pb-4">
            {failed.length > 0 && failed.length === shown.length ? (
              <EmptyState tone="critical" overline="Search" title="Couldn't search." body="Vale couldn't read the results." actionLabel="Try again" onAction={() => failed.forEach((k) => found[k].again())} />
            ) : pending && total === 0 ? (
              <AppFrameInset>
                <div className="flex flex-col gap-5">
                  <Skeleton variant="row" />
                  <Skeleton variant="row" />
                  <Skeleton variant="row" />
                </div>
              </AppFrameInset>
            ) : total === 0 ? (
              <EmptyState
                overline="Search // 00"
                title="Nothing matches."
                body={none}
                // The way wider, where there is one: not in All, and not for a team member, who has mail alone.
                actionLabel={scope === "all" || member ? undefined : "Search everything"}
                onAction={scope === "all" || member ? undefined : () => setScope("all")}
              />
            ) : scope === "all" ? (
              KINDS.filter((k) => found[k.id].rows.length > 0).map((k) => {
                const all = found[k.id]
                return (
                  <section key={k.id} aria-label={k.chip} className="flex flex-col">
                    <AppFrameInset>
                      <SectionHeader
                        title={k.header}
                        count={all.complete ? all.rows.length : undefined}
                        action={
                          all.rows.length > PEEK ? (
                            <Button variant="ghost" size="sm" onClick={() => setScope(k.id)}>
                              Show all
                            </Button>
                          ) : undefined
                        }
                      />
                    </AppFrameInset>
                    <Rows kind={k.id}>{rows[k.id](PEEK)}</Rows>
                  </section>
                )
              })
            ) : (
              <section aria-label={name} className="flex flex-col">
                <AppFrameInset>
                  <SectionHeader title={shown[0] === "mail" ? "Results // newest first" : shown[0] === "calendar" ? KINDS[1]!.header : "Results"} count={complete ? total : undefined} />
                </AppFrameInset>
                <Rows kind={shown[0]!}>{rows[shown[0]!]()}</Rows>
                {found[shown[0]!].more && (
                  <AppFrameInset>
                    <div className="pt-4">
                      <Button variant="secondary" onClick={found[shown[0]!].more}>
                        Show more
                      </Button>
                    </div>
                  </AppFrameInset>
                )}
              </section>
            )}
            {/* Said once the count has settled, politely (brief X2). */}
            <p role="status" className="sr-only">
              {!pending && complete ? `${total} ${total === 1 ? "result" : "results"}` : ""}
            </p>
          </div>
        )
      }
    />
  )
}

/** A kind's rows. Rows run edge to edge; events are cards, so they keep the column's inset and a gap between them. */
function Rows({ kind, children }: { kind: Kind; children: ReactNode }) {
  if (kind !== "calendar") return <div className="flex flex-col">{children}</div>
  return (
    <AppFrameInset>
      <div className="flex flex-col gap-2 pt-2">{children}</div>
    </AppFrameInset>
  )
}
