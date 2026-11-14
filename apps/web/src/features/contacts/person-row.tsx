import { Highlight, InitialTile, ListRow } from "@unicron/ui"
import type { ContactSummary } from "@/core/types"

const initialsOf = (name: string) =>
  name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase())
    .slice(0, 2)
    .join("")

export interface PersonRowProps {
  contact: ContactSummary
  onOpen: () => void
  /** The card open beside the list. */
  selected?: boolean
  /** Where the card lives, when more than one address book shows (ADR-0027). */
  source?: string
  /** The words a search matched: marked in the name and the line under it. */
  query?: string
}

/**
 * A person as a row (ADR-0085): the core's `ContactSummary` on unicron's
 * inline row: the photo or initials, the name, then the first email (the
 * company or a phone number when there is none). Search lists with it; the
 * contacts list that adopts it adds what it needs as optional props.
 */
export function PersonRow({ contact: c, onOpen, selected, source, query }: PersonRowProps) {
  const line = c.emails[0]?.value ?? c.org ?? c.phones[0]?.value
  return (
    <ListRow
      size="compact"
      selected={selected}
      onClick={onOpen}
      leading={<InitialTile size="s" initials={initialsOf(c.fullName) || "?"} src={c.photo ?? undefined} />}
      title={query ? <Highlight text={c.fullName} query={query} /> : c.fullName}
      meta={line ? query ? <Highlight text={line} query={query} /> : line : undefined}
      metaStyle="plain"
      status={source}
    />
  )
}
