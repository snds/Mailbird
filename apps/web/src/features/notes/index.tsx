import { type ReactNode, useDeferredValue, useState } from "react"
import { toast } from "sonner"

import { useUi } from "@/app/ui-store"
import { Icon } from "@/components/icon"
import { ListRow, SearchField } from "@/components/list-row"
import { MasterDetail, PaneHeader } from "@/components/master-detail"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { getCoreClient } from "@/core/client"
import { useNoteAction, useNoteFolders, useNotes, useNotesPrefs, useNoteTags } from "@/core/queries"
import type { NoteSummary, NotesPrefs } from "@/core/types"
import { useNowSecs } from "@/hooks/use-now"
import { reminderLabel, shortTime } from "@/lib/time"
import { cn } from "@/lib/utils"

import { ImportDialog } from "./import-dialog"
import { NOTE_COLOR_LABEL, noteEdge, noteFill } from "./note-color"
import { NoteDetailPane } from "./note-detail"
import { NoteFolderChips } from "./note-folders"
import { NoteCover } from "./note-image"
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
  const [folder, setFolder] = useState<string | null>(null)
  const { data: folders = [] } = useNoteFolders()
  // A folder deleted elsewhere just stops filtering.
  const activeFolder = folders.find((f) => f.id === folder) ?? null
  const [archived, setArchived] = useState(false)
  const [importing, setImporting] = useState(false)
  const [relayOpen, setRelayOpen] = useState(false)
  const query = useDeferredValue(search.trim())
  const { data: notes = [], isPending } = useNotes({ search: query || null, tag, archived, folder: archived ? null : (activeFolder?.id ?? null) })
  const { data: tags = [] } = useNoteTags()
  const sync = useSyncStatus()
  const { data: prefs } = useNotesPrefs()
  const setPrefs = useNoteAction((c, change: Partial<NotesPrefs>) => c.setNotesPrefs({ sortChecked: true, ...prefs, ...change }))
  const grid = prefs?.grid ?? false

  // Every note as a Markdown file with front matter, as Obsidian reads them (ADR-0034).
  const exportAll = async () => {
    try {
      toast.success(`Notes saved to ${await (await getCoreClient()).exportNotes()}`, { duration: 4000 })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  // A reminder that has come due lifts its note above everything, pinned
  // included, until it's marked done (ADR-0039).
  const now = useNowSecs(30_000)
  const isDue = (n: NoteSummary) => !!n.remindAt && n.remindAt <= now
  const due = archived ? [] : notes.filter(isDue).sort((a, b) => a.remindAt! - b.remindAt!)
  const pinned = notes.filter((n) => n.pinned && !due.includes(n))
  const rest = notes.filter((n) => !n.pinned && !due.includes(n))
  const empty = archived
    ? "Archived notes show up here."
    : activeFolder && !query && !tag
      ? "No notes in this folder yet. They join by themselves when they match."
      : query || tag || activeFolder
        ? "No notes match."
        : "No notes yet. Start one, or import from Apple Notes, Keep, or a Markdown folder."

  const open = (n: NoteSummary) => setSelected({ id: n.id, fresh: false })
  const row = (n: NoteSummary) => (
    <div role="listitem" key={n.id}>
      <ListRow
        selected={n.id === selected?.id}
        onSelect={() => open(n)}
        title={
          <span className="flex items-center gap-1.5">
            {n.pinned && <Icon name="keep" fill className="size-4 shrink-0 text-vertical-notes" label="Pinned" />}
            {n.locked && <Icon name="lock" className="size-4 shrink-0 text-muted-foreground" />}
            {n.color && (
              <span
                aria-hidden
                data-slot="note-color-dot"
                className="size-2.5 shrink-0 rounded-full border"
                style={{ background: noteFill(n.color), borderColor: noteEdge(n.color) }}
              />
            )}
            <span className="truncate">{n.title || "New note"}</span>
            {/* After the title, so a row is read by its name first. */}
            {n.color && <span className="sr-only">, {NOTE_COLOR_LABEL[n.color]}</span>}
            {n.locked && <span className="sr-only">, locked</span>}
          </span>
        }
        meta={shortTime(n.updated)}
        supporting={
          n.locked || n.snippet || n.tags.length || n.links.length || n.remindAt ? (
            <>
              {n.remindAt && (
                <Icon
                  name={isDue(n) ? "notifications_active" : "schedule"}
                  fill={isDue(n)}
                  className={cn("mr-1 inline size-3.5 align-[-2px]", isDue(n) && "text-vertical-notes")}
                  label={`${isDue(n) ? "Due" : "Reminder"} ${reminderLabel(n.remindAt)}`}
                />
              )}
              {n.links.length > 0 && <Icon name="link" className="mr-1 inline size-3.5 align-[-2px]" label={`${n.links.length} linked`} />}
              {n.locked ? <span className="italic">Locked</span> : n.snippet || <span className="italic">No more text</span>}
            </>
          ) : undefined
        }
      />
    </div>
  )

  return (
    <>
      <MasterDetail
        listFills={grid}
        detailTint={(() => {
          const c = notes.find((n) => n.id === selected?.id)?.color
          return c ? noteFill(c) : undefined
        })()}
        emptyIcon="stylus_note"
        emptyLabel="Open a note, or start a new one."
        onBack={() => setSelected(null)}
        header={
          <>
            <PaneHeader title={archived ? "Archive" : (activeFolder?.name ?? "Notes")}>
              <Tooltip>
                <TooltipTrigger
                  render={<Button variant="ghost" size="icon" aria-label={grid ? "Show as a list" : "Show as cards"} onClick={() => setPrefs.mutate({ grid: !grid })} />}
                >
                  <Icon name={grid ? "view_agenda" : "grid_view"} className="size-5" />
                </TooltipTrigger>
                <TooltipContent>{grid ? "Show as a list" : "Show as cards"}</TooltipContent>
              </Tooltip>
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
                  <DropdownMenuItem onClick={() => void exportAll()}>
                    <Icon name="download" /> Export all as Markdown
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setRelayOpen(true)}>
                    <Icon name="sync" /> Sync between devices…
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuCheckboxItem checked={prefs?.sortChecked ?? true} onCheckedChange={(on) => setPrefs.mutate({ sortChecked: on })}>
                    <Icon name="checklist" /> Move checked items down
                  </DropdownMenuCheckboxItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </PaneHeader>
            <div className="flex flex-col gap-2 px-4 pb-3">
              <SearchField placeholder={activeFolder ? `Search ${activeFolder.name}` : "Search notes"} value={search} onChange={setSearch} />
              {!archived && <NoteFolderChips active={activeFolder?.id ?? null} onPick={(id) => (setFolder(id), setSelected(null))} />}
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
          <div role="list" aria-label="Notes" className={cn(grid && "px-3 pb-4")}>
            {!isPending && notes.length === 0 && <p className="px-6 py-8 text-center text-sm text-muted-foreground">{empty}</p>}
            {[
              { label: "Due", notes: due, heading: true },
              { label: "Pinned", notes: pinned, heading: true },
              { label: due.length || pinned.length ? "Others" : "All notes", notes: rest, heading: due.length + pinned.length > 0 },
            ]
              .filter((s) => s.notes.length > 0)
              .map((s, i) => (
                <section key={s.label} aria-label={s.label}>
                  {s.heading && <h3 className={cn("pb-1 text-xs font-semibold text-muted-foreground", i > 0 ? "pt-3" : "pt-1", grid ? "px-1" : "px-4")}>{s.label}</h3>}
                  <Group grid={grid}>
                    {s.notes.map((n) => (grid ? <NoteCard key={n.id} note={n} due={isDue(n)} selected={n.id === selected?.id} onOpen={() => open(n)} /> : row(n)))}
                  </Group>
                </section>
              ))}
          </div>
        }
        detail={selected && <NoteDetailPane key={selected.id} id={selected.id} fresh={selected.fresh} onClosed={() => setSelected(null)} />}
      />
      <ImportDialog open={importing} onOpenChange={setImporting} />
      <RelayDialog open={relayOpen} onOpenChange={setRelayOpen} />
    </>
  )
}

/** A list of rows, or Keep's cards: columns at least a card wide, as many as
 * the pane holds: Keep's width across a window, and a narrower card where
 * the pane itself is narrow (a phone, or beside an open note) so two fit. Cards flow down each column
 * (CSS columns), so a short note never leaves a hole beside a long one. */
function Group({ grid, children }: { grid: boolean; children: ReactNode }) {
  if (!grid) return <>{children}</>
  return (
    <div className="@container">
      <div className="gap-3 [column-width:var(--c-note-card-min)] @max-lg:[column-width:var(--c-note-card-min-compact)]">{children}</div>
    </div>
  )
}

function NoteCard({ note: n, due, selected, onOpen }: { note: NoteSummary; due: boolean; selected: boolean; onOpen: () => void }) {
  return (
    <div role="listitem" className="mb-3 break-inside-avoid">
      <button
        type="button"
        onClick={onOpen}
        aria-current={selected || undefined}
        className={cn(
          "flex w-full flex-col gap-1.5 rounded-(--c-note-card-radius) border p-3 text-left outline-none transition-shadow hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring",
          selected && "ring-2 ring-foreground"
        )}
        style={{ background: noteFill(n.color), borderColor: noteEdge(n.color) }}
      >
        {n.cover && !n.locked && <NoteCover id={n.cover} className="-mx-3 -mt-3 mb-1 w-[calc(100%+1.5rem)] max-w-none rounded-t-[calc(var(--c-note-card-radius)-1px)]" />}
        <span className="flex items-start gap-1.5">
          <span className={cn("min-w-0 flex-1 font-semibold break-words", !n.title && "text-muted-foreground")}>{n.title || "New note"}</span>
          {n.locked && <Icon name="lock" className="size-4 shrink-0 text-foreground/60" label="Locked" />}
          {n.pinned && <Icon name="keep" fill className="size-4 shrink-0 text-vertical-notes" label="Pinned" />}
        </span>
        {n.locked ? (
          <span className="text-sm text-foreground/60 italic">Locked</span>
        ) : (
          n.snippet && <span className="line-clamp-6 text-sm break-words text-foreground/80">{n.snippet}</span>
        )}
        {(n.tags.length > 0 || n.links.length > 0 || n.remindAt) && (
          <span className="flex flex-wrap items-center gap-1 pt-0.5 text-xs text-foreground/70">
            {n.remindAt && (
              <span data-slot="note-reminder" className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-foreground/8 px-2 py-0.5", due && "font-medium text-foreground")}>
                <Icon name={due ? "notifications_active" : "schedule"} fill={due} className="size-3.5" />
                {due ? `Due · ${reminderLabel(n.remindAt)}` : reminderLabel(n.remindAt)}
              </span>
            )}
            {n.links.length > 0 && <Icon name="link" className="size-3.5" label={`${n.links.length} linked`} />}
            {n.tags.map((t) => (
              <span key={t} className="rounded-full bg-foreground/8 px-2 py-0.5">
                #{t}
              </span>
            ))}
          </span>
        )}
        {n.color && <span className="sr-only">{NOTE_COLOR_LABEL[n.color]}</span>}
        <span className="text-[11px] text-foreground/60">{shortTime(n.updated)}</span>
      </button>
    </div>
  )
}
