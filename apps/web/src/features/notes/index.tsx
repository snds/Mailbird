import { type ReactNode, useDeferredValue, useState } from "react"

import { factTime, useRefresh, useScreenFact, useScreenPlace } from "@/app/screen"
import { useSectionSwitcher } from "@/app/places"
import { SectionSwitcher } from "@/app/section-switcher"
import { useUi } from "@/app/ui-store"
import { vertical } from "@/app/verticals"
import { Icon, Button, formatNavCount, DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, IconButton, Toggle, Tooltip, TooltipContent, TooltipTrigger, toast } from "@unicron/ui"
import { EntryRow, ListSearch } from "@/components/list-row"
import { MasterDetail } from "@/components/master-detail"
import { ScreenHead } from "@/components/page"
import { getCoreClient } from "@/core/client"
import { useNoteAction, useNotes, useNotesPrefs } from "@/core/queries"
import type { NoteSummary, NotesPrefs } from "@/core/types"
import { useNowSecs } from "@/hooks/use-now"
import { reminderLabel, shortTime } from "@/lib/time"
import { cn } from "@/lib/utils"

import { ImportDialog } from "./import-dialog"
import { NOTE_COLOR_LABEL, noteEdge, noteFill } from "./note-color"
import { NoteDetailPane } from "./note-detail"
import { NoteFolderEditor } from "./note-folders"
import { NoteGraphView } from "./note-graph"
import { NoteCover } from "./note-image"
import { NotesNav } from "./notes-nav"
import { closeSharedNote, useOpenSharedNote } from "./open-shared-note"
import { closeSyncSetup, openSyncSetup, useSyncSetup } from "./open-sync-setup"
import { RelayDialog } from "./relay-dialog"
import { OpenSharedDialog } from "./share-dialog"
import { useSyncStatus } from "./sync"
import { useNotesPlace } from "./use-notes-place"

const SYNC_LABEL = { off: "Sync is off", connecting: "Connecting to the relay…", synced: "Synced with the relay", error: "Sync problem" } as const

export function NotesView() {
  // In the shared store, so a jump (a new note, or a link from mail,
  // calendar, or contacts) can open a note from anywhere.
  const selected = useUi((s) => s.openNote)
  const setSelected = useUi((s) => s.setOpenNote)
  const [search, setSearch] = useState("")
  // Notes' place (ADR-0084): a folder, narrowed by one tag. A folder or a tag that is gone just stops filtering.
  const { place, folder: activeFolder, name: placeName } = useNotesPlace()
  const tag = place.tag
  const archived = place.folder.kind === "archive"
  const pinnedOnly = place.folder.kind === "pinned"
  // Another folder or tag, picked in the nav: the note that was open stays open, as a link's note does.
  const [importing, setImporting] = useState(false)
  // Opened by their intents, so the folders list and the command menu reach them too.
  const relayOpen = useSyncSetup((s) => s.open)
  const openingShared = useOpenSharedNote((s) => s.open)
  const query = useDeferredValue(search.trim())
  const noteQuery = { search: query || null, tag, archived, folder: archived ? null : (activeFolder?.id ?? null) }
  const { data: found = [], isPending, refetch } = useNotes(noteQuery)
  // Pinned is a place the core has no query for: the same read, narrowed here.
  const notes = pinnedOnly ? found.filter((n) => n.pinned) : found
  const sync = useSyncStatus()
  const { data: prefs } = useNotesPrefs()
  const setPrefs = useNoteAction((c, change: Partial<NotesPrefs>) => c.setNotesPrefs({ sortChecked: true, ...prefs, ...change }))
  const grid = prefs?.grid ?? false
  // The map (ADR-0053): the same notes, laid out by their links.
  const graph = prefs?.graph ?? false

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
    : pinnedOnly && !query && !tag
      ? "Nothing pinned. Pin a note from its menu to keep it here."
    : activeFolder && !query && !tag
      ? "No notes in this folder yet. They join by themselves when they match."
      : query || tag || activeFolder
        ? "No notes match."
        : "No notes yet. Start one, or import from Apple Notes, Keep, or a Markdown folder."

  const open = (n: NoteSummary) => setSelected({ id: n.id, fresh: false })
  const row = (n: NoteSummary) => (
    <div role="listitem" key={n.id}>
      <EntryRow
        selected={n.id === selected?.id}
        onSelect={() => open(n)}
        title={
          <span className="flex items-center gap-1.5">
            {n.pinned && <Icon name="pin--filled" size="sm" label="Pinned" />}
            {(n.locked || isShared(n)) && <Icon name={n.locked ? "locked" : "user--multiple"} tone="muted" size="sm" />}
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
            {isShared(n) && <span className="sr-only">, {sharedLabel(n)}</span>}
          </span>
        }
        meta={shortTime(n.updated)}
        supporting={
          n.locked || n.snippet || n.tags.length || n.links.length || n.remindAt ? (
            <>
              {n.remindAt && (
                <Icon
                  name={isDue(n) ? "notification--filled" : "time"}
                  size={14}
                  className="mr-1 inline align-[-2px]"
                  label={`${isDue(n) ? "Due" : "Reminder"} ${reminderLabel(n.remindAt)}`}
                />
              )}
              {n.links.length > 0 && <Icon name="link" size={14} className="mr-1 inline align-[-2px]" label={`${n.links.length} linked`} />}
              {n.locked ? <span className="italic">Locked</span> : n.snippet || <span className="italic">No more text</span>}
            </>
          ) : undefined
        }
      />
    </div>
  )

  // What the shell says about this screen (ADR-0083): the folder as the place, and when a note here was last edited.
  useScreenPlace(placeName)
  const edited = notes.reduce((latest, n) => Math.max(latest, n.updated), 0)
  useScreenFact(edited ? `Edited ${factTime(edited)}` : null)
  useRefresh(refetch)
  // The page head opens the folders and tags wherever the sidebar does not list them (brief X1).
  const switching = useSectionSwitcher("Change folder or tag.")
  const headName = place.folder.kind === "all" ? "Notes" : placeName

  return (
    <>
      <MasterDetail
        section="Notes"
        pick={vertical("notes").pick}
        listFills={grid || graph}
        detailTint={(() => {
          const c = notes.find((n) => n.id === selected?.id)?.color
          return c ? noteFill(c) : undefined
        })()}
        onBack={() => setSelected(null)}
        header={
          <ScreenHead
            overline={`${[headName, tag ? `#${tag}` : null].filter(Boolean).join(" // ")} // ${isPending ? "" : formatNavCount(notes.length)}`}
            title={headName}
            switcher={switching.switcher}
            actions={
              <>
              <IconButton label="Map of notes" render={<Toggle pressed={graph} onPressedChange={(on) => setPrefs.mutate({ graph: on })} />}>
                <Icon name="chart--relationship" className="size-5" />
              </IconButton>
              {!graph && (
                <IconButton label={grid ? "Show as a list" : "Show as cards"} onClick={() => setPrefs.mutate({ grid: !grid })}>
                  <Icon name={grid ? "show-data--cards" : "grid"} className="size-5" />
                </IconButton>
              )}
              <Tooltip>
                <TooltipTrigger render={<Button variant="ghost" size="icon" aria-label={SYNC_LABEL[sync.status]} onClick={openSyncSetup} />}>
                  <Icon
                    name={sync.status === "error" ? "warning--alt" : sync.status === "off" ? "cloud--offline" : "cloud"}
                    className={cn("size-5", sync.status === "error" && "text-destructive", sync.status === "connecting" && "animate-pulse")}
                  />
                </TooltipTrigger>
                <TooltipContent>{sync.error ?? SYNC_LABEL[sync.status]}</TooltipContent>
              </Tooltip>
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="More" />}>
                  <Icon name="overflow-menu--horizontal" className="size-5" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" width="auto">
                  <DropdownMenuItem onClick={() => setImporting(true)}>
                    <Icon name="document--import" /> Import notes…
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void exportAll()}>
                    <Icon name="download" /> Export all as Markdown
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={openSyncSetup}>
                    <Icon name="renew" /> Sync between devices…
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuCheckboxItem checked={prefs?.sortChecked ?? true} onCheckedChange={(on) => setPrefs.mutate({ sortChecked: on })}>
                    <Icon name="list--checked" /> Move checked items down
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem checked={prefs?.readImageText ?? true} onCheckedChange={(on) => setPrefs.mutate({ readImageText: on })}>
                    <Icon name="scan--alt" /> Find text in images
                  </DropdownMenuCheckboxItem>
                </DropdownMenuContent>
              </DropdownMenu>
              </>
            }
            below={
            <div className="flex flex-col gap-2">
              <SectionSwitcher state={switching} overline={["Notes", place.folder.kind === "all" ? null : placeName, tag ? `#${tag}` : null].filter(Boolean).join(" // ")} title="Folders">
                <NotesNav layer more={switching.sheet} />
              </SectionSwitcher>
              <ListSearch placeholder={place.folder.kind === "all" ? "Search notes" : `Search ${placeName}`} value={search} onChange={setSearch} />
            </div>
            }
          />
        }
        list={
          graph ? (
            <NoteGraphView query={noteQuery} selectedId={selected?.id ?? null} onOpenNote={(id) => setSelected({ id, fresh: false })} />
          ) : (
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
          )
        }
        detail={selected && <NoteDetailPane key={selected.id} id={selected.id} fresh={selected.fresh} onClosed={() => setSelected(null)} />}
      />
      <ImportDialog open={importing} onOpenChange={setImporting} />
      <RelayDialog open={relayOpen} onOpenChange={(o) => !o && closeSyncSetup()} />
      <OpenSharedDialog open={openingShared} onOpenChange={(o) => !o && closeSharedNote()} />
      <NoteFolderEditor />
    </>
  )
}

const isShared = (n: NoteSummary) => !!n.share && !n.share.revoked
const sharedLabel = (n: NoteSummary) => (n.share?.role === "guest" ? `shared by ${n.share.from ?? "someone"}` : "shared")

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
          {(n.locked || isShared(n)) && <Icon name={n.locked ? "locked" : "user--multiple"} size="sm" className="text-foreground/60" label={n.locked ? "Locked" : sharedLabel(n)} />}
          {n.pinned && <Icon name="pin--filled" size="sm" label="Pinned" />}
        </span>
        {n.locked ? (
          <span className="text-sm text-foreground/60 italic">Locked</span>
        ) : (
          n.snippet && <span className="line-clamp-6 text-sm break-words text-foreground/80">{n.snippet}</span>
        )}
        {(n.tags.length > 0 || n.links.length > 0 || n.remindAt) && (
          <span className="flex flex-wrap items-center gap-1 pt-0.5 text-xs text-foreground/70">
            {n.remindAt && (
              <span data-role="note-reminder" className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-foreground/8 px-2 py-0.5", due && "font-medium text-foreground")}>
                <Icon name={due ? "notification--filled" : "time"} size={14} />
                {due ? `Due · ${reminderLabel(n.remindAt)}` : reminderLabel(n.remindAt)}
              </span>
            )}
            {n.links.length > 0 && <Icon name="link" size={14} label={`${n.links.length} linked`} />}
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
