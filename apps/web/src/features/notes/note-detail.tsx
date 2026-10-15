import { useQueryClient } from "@tanstack/react-query"
import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { useUi, type Jump } from "@/app/ui-store"
import { Icon, type IconName } from "@/components/icon"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { Toggle } from "@/components/ui/toggle"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { getCoreClient } from "@/core/client"
import { useNote, useNoteAction, useNoteBacklinks, useNoteTags } from "@/core/queries"
import type { NoteLink, NoteLinkKind, NoteMeta } from "@/core/types"
import { longTime } from "@/lib/time"

import { titleAndSnippet } from "@/core/demo-notes"

import { LinkPicker } from "./link-picker"
import { noteFill } from "./note-color"
import { NoteColorMenu } from "./note-color-menu"
import { NoteEditor } from "./note-editor"
import { renameLinks } from "./rename-links"

const LINK_ICON: Record<NoteLinkKind, IconName> = { event: "event", contact: "person", thread: "mail" }
const LINK_JUMP: Record<NoteLinkKind, Jump["kind"]> = { event: "event", contact: "contact", thread: "thread" }

export function NoteDetailPane({ id, fresh, onClosed }: { id: string; fresh: boolean; onClosed: () => void }) {
  const { data: note, error, isPending } = useNote(id)
  const qc = useQueryClient()
  const setMeta = useNoteAction((c, meta: NoteMeta) => c.setNoteMeta(id, meta))
  const remove = useNoteAction<void>((c) => c.deleteNote(id))
  const restore = useNoteAction<void>((c) => c.restoreNote(id))
  const jumpTo = useUi((s) => s.jumpTo)
  const [meta, setLocal] = useState<NoteMeta | null>(null)
  const [picking, setPicking] = useState(false)
  const markdownRef = useRef<string | null>(null)
  const refresh = () => void qc.invalidateQueries({ queryKey: ["notes"], predicate: (q) => q.queryKey[1] !== "note" })

  // Renames (ADR-0035): the title other notes' links use, and a pending
  // check that runs once the title has stopped changing (or the note closes).
  const linkedTitle = useRef<string | null>(null)
  const renameCheck = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const offerRename = useCallback(() => {
    clearTimeout(renameCheck.current)
    renameCheck.current = undefined
    const old = linkedTitle.current
    const next = markdownRef.current === null ? null : titleAndSnippet(markdownRef.current)[0]
    if (!old?.trim() || !next?.trim() || old === next) return
    void getCoreClient()
      .then((c) => c.notesLinkingTo(old, id))
      .then((linking) => {
        if (linking.length === 0) return void (linkedTitle.current = next)
        const many = linking.length === 1 ? "1 note links" : `${linking.length} notes link`
        toast(`${many} to “${old}”`, {
          id: `rename-${id}`,
          description: `Point ${linking.length === 1 ? "it" : "them"} at “${next}” instead?`,
          duration: 12_000,
          action: {
            label: "Update links",
            onClick: () =>
              void renameLinks(old, next, id).then(
                (n) => {
                  linkedTitle.current = next
                  toast.success(`Updated links in ${n === 1 ? "1 note" : `${n} notes`}`, { duration: 2500 })
                },
                (e: unknown) => toast.error(e instanceof Error ? e.message : String(e)),
              ),
          },
        })
      })
  }, [id])
  useEffect(() => () => void (renameCheck.current !== undefined && offerRename()), [offerRename])

  // A new note left empty is thrown away when you leave it, like Apple Notes.
  useEffect(() => {
    if (note && markdownRef.current === null) markdownRef.current = note.markdown
    if (note && linkedTitle.current === null) linkedTitle.current = note.title
  }, [note])
  useEffect(
    () => () => {
      if (fresh && markdownRef.current !== null && !markdownRef.current.trim())
        void getCoreClient()
          .then((c) => c.deleteNote(id))
          .then(() => qc.invalidateQueries({ queryKey: ["notes"], predicate: (q) => q.queryKey[1] !== "note" }))
    },
    [fresh, id, qc],
  )

  if (isPending) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-3 p-8">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
      </div>
    )
  }
  if (error || !note) return <p className="p-6 text-sm text-muted-foreground">{error instanceof Error ? error.message : "That note is gone."}</p>

  const current = { pinned: note.pinned, archived: note.archived, tags: note.tags, links: note.links, ...meta }
  // Local changes say "" for none; the note says null.
  const color = (meta?.color ?? note.color) || null
  const update = async (change: NoteMeta) => {
    setLocal({ ...meta, ...change })
    try {
      await setMeta.mutateAsync(change)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }
  const archive = async () => {
    await update({ archived: !current.archived })
    toast.success(current.archived ? "Moved back to notes" : "Archived", { duration: 2500 })
    onClosed()
  }
  const del = async () => {
    try {
      await remove.mutateAsync()
      onClosed()
      toast("Note deleted", { duration: 6000, action: { label: "Undo", onClick: () => void restore.mutateAsync() } })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }
  // Events open on their next occurrence's day; conversations bring their row.
  const open = async (kind: NoteLinkKind, target: string) => {
    try {
      const core = await getCoreClient()
      if (kind === "event") jumpTo({ kind: "event", id: target, start: (await core.getEvent(target)).start })
      else if (kind === "thread") jumpTo({ kind: "thread", id: target, row: (await core.getThread(target)).at(-1) })
      else jumpTo({ kind: LINK_JUMP[kind], id: target })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdownRef.current ?? note.markdown)
      toast.success("Copied as Markdown", { duration: 2000 })
    } catch {
      toast.error("Couldn't reach the clipboard")
    }
  }

  return (
    // The note takes its card's tint, as an open Keep note does; the pane
    // around it follows from the list (MasterDetail's detailTint).
    <div
      className="min-h-full transition-colors"
      style={color ? ({ background: noteFill(color), "--note-surface": noteFill(color) } as CSSProperties) : undefined}
      data-note-color={color ?? undefined}
    >
      <article className="mx-auto flex h-full w-full max-w-3xl flex-col" aria-label="Note">
        <div className="flex shrink-0 items-center gap-1 px-3 pt-2 md:px-6 md:pt-4">
          <span className="min-w-0 flex-1 truncate px-1 text-xs text-muted-foreground">
            {current.archived ? "Archived · " : ""}Edited {longTime(note.updated)}
          </span>
          <Tooltip>
            <TooltipTrigger
              render={<Toggle size="sm" aria-label="Pin" pressed={current.pinned} onPressedChange={(pinned) => void update({ pinned })} />}
            >
              <Icon name="keep" fill={current.pinned} className={current.pinned ? "text-vertical-notes" : undefined} />
            </TooltipTrigger>
            <TooltipContent>{current.pinned ? "Unpin" : "Pin to the top"}</TooltipContent>
          </Tooltip>
          <NoteColorMenu value={color} onChange={(c) => void update({ color: c ?? "" })} />
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="Note actions" />}>
              <Icon name="more_horiz" className="size-5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => void archive()}>
                <Icon name={current.archived ? "unarchive" : "archive"} /> {current.archived ? "Unarchive" : "Archive"}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void copy()}>
                <Icon name="content_copy" /> Copy as Markdown
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => void del()}>
                <Icon name="delete" /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-4 pt-1 md:px-8">
          {current.links.map((l) => (
            <LinkChip key={`${l.kind}:${l.key}`} link={l} onOpen={(target) => void open(l.kind, target)} onRemove={() => void update({ links: current.links.filter((x) => x !== l) })} />
          ))}
          <TagEditor tags={current.tags} onChange={(tags) => void update({ tags })} />
          <Button variant="ghost" size="sm" className="h-7 rounded-full text-muted-foreground" aria-label="Link to an event, person, or conversation" onClick={() => setPicking(true)}>
            <Icon name="add_link" data-icon="inline-start" /> Link
          </Button>
        </div>
        <LinkPicker
          open={picking}
          onOpenChange={setPicking}
          linked={current.links}
          onLink={(link) => {
            setPicking(false)
            if (current.links.some((l) => l.kind === link.kind && l.key === link.key)) return
            void update({ links: [...current.links, link] }).then(() => toast.success(`Linked to ${link.label}`, { duration: 2000 }))
          }}
        />
        <LinkedFrom id={id} />

        <NoteEditor
          note={note}
          autoFocus={fresh}
          onSaved={(md) => {
            markdownRef.current = md
            refresh()
            if (linkedTitle.current !== null && titleAndSnippet(md)[0] !== linkedTitle.current) {
              clearTimeout(renameCheck.current)
              renameCheck.current = setTimeout(offerRename, 1500)
            }
          }}
        />
      </article>
    </div>
  )
}

/** Notes that link here with `[[this title]]`, one tap away (ADR-0034). */
function LinkedFrom({ id }: { id: string }) {
  const { data: back = [] } = useNoteBacklinks(id)
  const setOpenNote = useUi((s) => s.setOpenNote)
  if (back.length === 0) return null
  return (
    <section aria-label="Linked from" className="flex shrink-0 flex-wrap items-center gap-1.5 px-4 pt-1.5 text-xs md:px-8">
      <span className="text-muted-foreground">Linked from</span>
      {back.map((n) => (
        <button
          key={n.id}
          type="button"
          className="inline-flex h-7 max-w-56 items-center gap-1 rounded-full border bg-muted/50 px-2.5 hover:bg-muted"
          onClick={() => setOpenNote({ id: n.id, fresh: false })}
        >
          <Icon name="description" className="size-3.5" />
          <span className="truncate">{n.title || "New note"}</span>
        </button>
      ))}
    </section>
  )
}

function LinkChip({ link, onOpen, onRemove }: { link: NoteLink; onOpen: (target: string) => void; onRemove: () => void }) {
  const here = !!link.target
  return (
    <span className="inline-flex h-7 items-center overflow-hidden rounded-full border bg-muted/50 text-xs" data-slot="note-link">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="flex h-full max-w-56 items-center gap-1 pr-1 pl-2.5 hover:bg-muted disabled:opacity-60"
              disabled={!here}
              onClick={() => link.target && onOpen(link.target)}
            />
          }
        >
          <Icon name={LINK_ICON[link.kind]} className="size-3.5" />
          <span className="truncate">{link.label || "(untitled)"}</span>
        </TooltipTrigger>
        <TooltipContent>{here ? `Open ${link.kind === "thread" ? "conversation" : link.kind}` : "Not on this device"}</TooltipContent>
      </Tooltip>
      <button type="button" aria-label={`Unlink ${link.label}`} className="flex h-full items-center px-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={onRemove}>
        <Icon name="close" className="size-3.5" />
      </button>
    </span>
  )
}

function TagEditor({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  const [adding, setAdding] = useState<string | null>(null)
  const { data: known = [] } = useNoteTags()
  const add = () => {
    const t = adding?.trim().replace(/^#+/, "")
    setAdding(null)
    if (t && !tags.some((x) => x.toLowerCase() === t.toLowerCase())) onChange([...tags, t])
  }
  return (
    <>
      {tags.map((t) => (
        <span key={t} className="inline-flex h-7 items-center rounded-full bg-secondary pl-2.5 text-xs text-secondary-foreground">
          #{t}
          <button type="button" aria-label={`Remove tag ${t}`} className="flex h-full items-center px-1.5 opacity-60 hover:opacity-100" onClick={() => onChange(tags.filter((x) => x !== t))}>
            <Icon name="close" className="size-3.5" />
          </button>
        </span>
      ))}
      {adding === null ? (
        <Button variant="ghost" size="sm" className="h-7 rounded-full text-muted-foreground" onClick={() => setAdding("")}>
          <Icon name="sell" data-icon="inline-start" /> Tag
        </Button>
      ) : (
        <>
          <input
            aria-label="New tag"
            autoFocus
            list="note-tags"
            className="h-7 w-32 rounded-full border bg-transparent px-2.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            placeholder="tag name"
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            onBlur={add}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                add()
              } else if (e.key === "Escape") {
                // Close the field, not the pane.
                e.preventDefault()
                e.stopPropagation()
                setAdding(null)
              }
            }}
          />
          <datalist id="note-tags">
            {known.filter((k) => !tags.includes(k.tag)).map((k) => (
              <option key={k.tag} value={k.tag} />
            ))}
          </datalist>
        </>
      )}
    </>
  )
}
