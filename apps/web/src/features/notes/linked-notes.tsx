import { useUi } from "@/app/ui-store"
import { Icon, Button, Item, ItemActions, ItemContent, ItemMedia } from "@unicron/ui"
import { getCoreClient } from "@/core/client"
import { useLinkedNotes } from "@/core/queries"
import type { NoteTarget } from "@/core/types"
import { shortTime } from "@/lib/time"

import { useNewNote } from "./use-new-note"

/**
 * Notes attached to an event, a person, or a conversation, with a way to
 * start one. Shown in their detail panes: meeting notes sit with the meeting.
 */
export function LinkedNotes({ target, title }: { target: NoteTarget; title: string }) {
  const { data: notes = [] } = useLinkedNotes(target)
  const jumpTo = useUi((s) => s.jumpTo)
  const openQuickNote = useUi((s) => s.openQuickNote)
  const newNote = useNewNote()

  const start = async () => {
    const link = await (await getCoreClient()).noteLinkFor(target)
    await newNote({ markdown: `# ${title}\n\n`, links: link ? [link] : [] })
  }

  return (
    <section className="w-full text-left" aria-label="Notes">
      <div className="flex items-center justify-between pb-1">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Notes</h3>
        <span className="flex items-center">
          {/* Stays here: a sheet, saved on close (ADR-0037). New note opens the full editor in Notes. */}
          <Button variant="ghost" size="icon-sm" aria-label="Quick note" onClick={() => openQuickNote({ ...target, label: title })}>
            <Icon name="edit_note" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void start()}>
            <Icon name="note_add" data-icon="inline-start" /> New note
          </Button>
        </span>
      </div>
      {notes.length === 0 ? (
        <p className="text-sm text-muted-foreground">No notes yet.</p>
      ) : (
        <ul className="flex flex-col">
          {notes.map((n) => (
            <li key={n.id}>
              <Item size="xs" render={<button type="button" onClick={() => jumpTo({ kind: "note", id: n.id })} />}>
                <ItemMedia>
                  <Icon name="stylus_note" className="text-vertical-notes" />
                </ItemMedia>
                <ItemContent>
                  <span className="truncate">{n.title || "New note"}</span>
                </ItemContent>
                <ItemActions>
                  <span className="text-xs text-muted-foreground">{shortTime(n.updated)}</span>
                </ItemActions>
              </Item>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
