import { useUi } from "@/app/ui-store"
import { Icon } from "@/components/icon"
import { Button } from "@/components/ui/button"
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
  const newNote = useNewNote()

  const start = async () => {
    const link = await (await getCoreClient()).noteLinkFor(target)
    await newNote({ markdown: `# ${title}\n\n`, links: link ? [link] : [] })
  }

  return (
    <section className="w-full text-left" aria-label="Notes">
      <div className="flex items-center justify-between pb-1">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Notes</h3>
        <Button variant="ghost" size="sm" onClick={() => void start()}>
          <Icon name="note_add" data-icon="inline-start" /> New note
        </Button>
      </div>
      {notes.length === 0 ? (
        <p className="text-sm text-muted-foreground">No notes yet.</p>
      ) : (
        <ul className="flex flex-col">
          {notes.map((n) => (
            <li key={n.id} className="border-b last:border-0">
              <button type="button" className="flex w-full items-center gap-2 py-2 text-left text-sm hover:text-foreground" onClick={() => jumpTo({ kind: "note", id: n.id })}>
                <Icon name="stylus_note" className="size-4 shrink-0 text-vertical-notes" />
                <span className="min-w-0 flex-1 truncate">{n.title || "New note"}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{shortTime(n.updated)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
