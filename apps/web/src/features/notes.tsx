import { useState } from "react"

import { Icon } from "@/components/icon"
import { ListRow, SearchField } from "@/components/list-row"
import { MasterDetail, PaneHeader } from "@/components/master-detail"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { notes as seed } from "@/data/mock"

/** Notes are Markdown at rest. The Tiptap (MIT) editor replaces the textarea. */
export function NotesView() {
  const [notes, setNotes] = useState(seed)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = notes.find((n) => n.id === selectedId) ?? null
  const ordered = [...notes].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned))

  return (
    <MasterDetail
      emptyIcon="stylus_note"
      emptyLabel="Open a note, or start a new one."
      onBack={() => setSelectedId(null)}
      header={
        <>
          <PaneHeader title="Notes" />
          <div className="px-4 pb-3">
            <SearchField placeholder="Search notes" />
          </div>
        </>
      }
      list={ordered.map((n) => (
        <ListRow
          key={n.id}
          selected={n.id === selectedId}
          onSelect={() => setSelectedId(n.id)}
          title={
            <span className="flex items-center gap-1.5">
              {n.pinned && <Icon name="keep" fill className="size-4 text-vertical-notes" label="Pinned" />}
              {n.title}
            </span>
          }
          meta={n.updated}
          supporting={n.body.split("\n")[0]}
        />
      ))}
      detail={
        selected && (
          <div className="mx-auto flex h-full max-w-3xl flex-col gap-3 px-4 pb-8 md:px-8 md:pt-6">
            <div className="flex flex-wrap gap-1.5">
              {selected.tags.map((t) => (
                <Badge key={t} variant="secondary">
                  #{t}
                </Badge>
              ))}
            </div>
            <h2 className="text-2xl font-semibold tracking-tight">{selected.title}</h2>
            <Textarea
              aria-label="Note body"
              value={selected.body}
              onChange={(e) =>
                setNotes((all) => all.map((n) => (n.id === selected.id ? { ...n, body: e.target.value } : n)))
              }
              className="min-h-64 flex-1 resize-none border-0 bg-transparent px-0 text-[15px] leading-relaxed shadow-none focus-visible:ring-0 dark:bg-transparent"
            />
          </div>
        )
      }
    />
  )
}
