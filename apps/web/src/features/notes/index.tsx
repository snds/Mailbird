import { useDeferredValue, useState } from "react"

import { useUi } from "@/app/ui-store"
import { Icon } from "@/components/icon"
import { ListRow, SearchField } from "@/components/list-row"
import { MasterDetail, PaneHeader } from "@/components/master-detail"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useNoteAction, useNotes, useNotesPrefs, useNoteTags } from "@/core/queries"
import { shortTime } from "@/lib/time"
import { cn } from "@/lib/utils"

import { ImportDialog } from "./import-dialog"
import { NoteDetailPane } from "./note-detail"
import { RelayDialog } from "./relay-dialog"
import { useSyncStatus } from "./sync"

const SYNC_LABEL = { off: "Sync is off", connecting: "Connecting to the relay…", synced: "Synced with the relay", error: "Sync problem" } as const

export function NotesView() {
  // In the shared store, so a jump (a new note, or a link from mail,
  // calendar, or contacts) can open a note from anywhere.
  const selected = useUi((s) => s.openNote)
  const setSelected = useUi((s) => s.setOpenNote)
  const [search, setSearch] = useState("")
  const [tag, setTag] = useState<string | null>(null)
  const [archived, setArchived] = useState(false)
  const [importing, setImporting] = useState(false)
  const [relayOpen, setRelayOpen] = useState(false)
  const query = useDeferredValue(search.trim())
  const { data: notes = [], isPending } = useNotes({ search: query || null, tag, archived })
  const { data: tags = [] } = useNoteTags()
  const sync = useSyncStatus()
  const { data: prefs } = useNotesPrefs()
  const setPrefs = useNoteAction((c, sortChecked: boolean) => c.setNotesPrefs({ sortChecked }))

  const pinned = notes.filter((n) => n.pinned)
  const rest = notes.filter((n) => !n.pinned)
  const empty = archived ? "Archived notes show up here." : query || tag ? "No notes match." : "No notes yet. Start one, or import from Apple Notes, Keep, or a Markdown folder."

  const row = (n: (typeof notes)[number]) => (
    <div role="listitem" key={n.id}>
      <ListRow
        selected={n.id === selected?.id}
        onSelect={() => setSelected({ id: n.id, fresh: false })}
        title={
          <span className="flex items-center gap-1.5">
            {n.pinned && <Icon name="keep" fill className="size-4 shrink-0 text-vertical-notes" label="Pinned" />}
            <span className="truncate">{n.title || "New note"}</span>
          </span>
        }
        meta={shortTime(n.updated)}
        supporting={
          n.snippet || n.tags.length || n.links.length ? (
            <>
              {n.links.length > 0 && <Icon name="link" className="mr-1 inline size-3.5 align-[-2px]" label={`${n.links.length} linked`} />}
              {n.snippet || <span className="italic">No more text</span>}
            </>
          ) : undefined
        }
      />
    </div>
  )

  return (
    <>
      <MasterDetail
        emptyIcon="stylus_note"
        emptyLabel="Open a note, or start a new one."
        onBack={() => setSelected(null)}
        header={
          <>
            <PaneHeader title={archived ? "Archive" : "Notes"}>
              <Tooltip>
                <TooltipTrigger render={<Button variant="ghost" size="icon" aria-label={SYNC_LABEL[sync.status]} onClick={() => setRelayOpen(true)} />}>
                  <Icon
                    name={sync.status === "error" ? "sync_problem" : sync.status === "off" ? "cloud_off" : "cloud_done"}
                    className={cn("size-5", sync.status === "error" && "text-destructive", sync.status === "connecting" && "animate-pulse")}
                  />
                </TooltipTrigger>
                <TooltipContent>{sync.error ?? SYNC_LABEL[sync.status]}</TooltipContent>
              </Tooltip>
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="More" />}>
                  <Icon name="more_vert" className="size-5" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => (setArchived(!archived), setSelected(null))}>
                    <Icon name={archived ? "stylus_note" : "archive"} /> {archived ? "Back to notes" : "Archived notes"}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setImporting(true)}>
                    <Icon name="upload_file" /> Import notes…
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setRelayOpen(true)}>
                    <Icon name="sync" /> Sync between devices…
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuCheckboxItem checked={prefs?.sortChecked ?? true} onCheckedChange={(on) => setPrefs.mutate(on)}>
                    <Icon name="checklist" /> Move checked items down
                  </DropdownMenuCheckboxItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </PaneHeader>
            <div className="flex flex-col gap-2 px-4 pb-3">
              <SearchField placeholder="Search notes" value={search} onChange={setSearch} />
              {tags.length > 0 && !archived && (
                <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4" role="group" aria-label="Filter by tag">
                  {tags.map((t) => (
                    <Button
                      key={t.tag}
                      size="sm"
                      variant={tag === t.tag ? "default" : "secondary"}
                      aria-pressed={tag === t.tag}
                      className="shrink-0 rounded-full"
                      onClick={() => setTag(tag === t.tag ? null : t.tag)}
                    >
                      #{t.tag}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          </>
        }
        list={
          <div role="list" aria-label="Notes">
            {!isPending && notes.length === 0 && <p className="px-6 py-8 text-center text-sm text-muted-foreground">{empty}</p>}
            {pinned.length > 0 && (
              <section aria-label="Pinned">
                <h3 className="px-4 py-1 text-xs font-semibold text-muted-foreground">Pinned</h3>
                {pinned.map(row)}
              </section>
            )}
            {rest.length > 0 && (
              <section aria-label={pinned.length ? "Others" : "All notes"}>
                {pinned.length > 0 && <h3 className="px-4 pt-3 pb-1 text-xs font-semibold text-muted-foreground">Others</h3>}
                {rest.map(row)}
              </section>
            )}
          </div>
        }
        detail={selected && <NoteDetailPane key={selected.id} id={selected.id} fresh={selected.fresh} onClosed={() => setSelected(null)} />}
      />
      <ImportDialog open={importing} onOpenChange={setImporting} />
      <RelayDialog open={relayOpen} onOpenChange={setRelayOpen} />
    </>
  )
}
