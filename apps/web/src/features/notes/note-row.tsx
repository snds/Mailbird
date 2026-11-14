import { Highlight, Icon, ListRow } from "@unicron/ui"
import type { NoteSummary } from "@/core/types"
import { shortTime } from "@/lib/time"

export interface NoteRowProps {
  note: NoteSummary
  onOpen: () => void
  /** The note open beside the list. */
  selected?: boolean
  /** The words a search matched: marked in the title and the snippet. */
  query?: string
}

const shared = (n: NoteSummary) => !!n.share && !n.share.revoked

/**
 * A note as a row (ADR-0085): the core's `NoteSummary` on unicron's inline
 * row: the title, when it was last edited, and its snippet. A locked note
 * shows its title only, as everywhere. Search lists with it; the notes list
 * that adopts it adds what it needs (a color, a reminder) as optional props.
 */
export function NoteRow({ note: n, onOpen, selected, query }: NoteRowProps) {
  const title = n.title || "New note"
  const snippet = n.locked ? "Locked" : n.snippet
  return (
    <ListRow
      size="compact"
      selected={selected}
      onClick={onOpen}
      title={query ? <Highlight text={title} query={query} /> : title}
      marks={
        n.pinned || n.locked || shared(n) ? (
          <>
            {n.pinned && <Icon name="pin--filled" size="sm" label="Pinned" />}
            {n.locked && <Icon name="locked" tone="muted" size="sm" label="Locked" />}
            {shared(n) && <Icon name="user--multiple" tone="muted" size="sm" label={n.share?.role === "guest" ? `Shared by ${n.share.from ?? "someone"}` : "Shared"} />}
          </>
        ) : undefined
      }
      meta={shortTime(n.updated)}
      metaStyle="plain"
      status={n.archived ? "Archived" : undefined}
      detail={snippet ? query && !n.locked ? <Highlight text={snippet} query={query} /> : snippet : undefined}
    />
  )
}
