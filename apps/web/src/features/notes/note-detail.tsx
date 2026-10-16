import { useQueryClient } from "@tanstack/react-query"
import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { useUi } from "@/app/ui-store"
import { Icon, Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, Skeleton, Toggle, Tooltip, TooltipContent, TooltipTrigger, IconButton } from "@unicron/ui"
import { getCoreClient } from "@/core/client"
import { useLockedNote, useNote, useNoteAction, useNoteBacklinks, useNotesLock, useNoteTags } from "@/core/queries"
import type { NoteLink, NoteMeta } from "@/core/types"
import { useNowSecs } from "@/hooks/use-now"
import { longTime, reminderLabel } from "@/lib/time"

import { titleAndSnippet } from "@/core/demo-notes"

import { LinkPicker } from "./link-picker"
import { LockedPanel, PassphraseDialog } from "./lock"
import { notesSync } from "./sync"
import { noteFill } from "./note-color"
import { NoteColorMenu } from "./note-color-menu"
import { RemindMenu } from "./remind-menu"
import { NoteEditor } from "./note-editor"
import { renameLinks } from "./rename-links"
import { LINK_ICON, useOpenLink } from "./use-open-link"


export function NoteDetailPane({ id, fresh, onClosed }: { id: string; fresh: boolean; onClosed: () => void }) {
  const { data: note, error, isPending } = useNote(id)
  const qc = useQueryClient()
  const setMeta = useNoteAction((c, meta: NoteMeta) => c.setNoteMeta(id, meta))
  const remove = useNoteAction<void>((c) => c.deleteNote(id))
  const restore = useNoteAction<void>((c) => c.restoreNote(id))
  const open = useOpenLink()
  const [meta, setLocal] = useState<NoteMeta | null>(null)
  const [picking, setPicking] = useState(false)
  const markdownRef = useRef<string | null>(null)
  // Locked notes (ADR-0043): the text comes from the core only while unlocked.
  const { data: lockInfo } = useNotesLock()
  const unlocked = !!lockInfo?.unlocked
  const { data: openLocked, error: lockedError } = useLockedNote(id, !!note?.locked && unlocked)
  const [askPassphrase, setAskPassphrase] = useState(false)
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
      if (fresh && !note?.locked && markdownRef.current !== null && !markdownRef.current.trim())
        void getCoreClient()
          .then((c) => c.deleteNote(id))
          .then(() => qc.invalidateQueries({ queryKey: ["notes"], predicate: (q) => q.queryKey[1] !== "note" }))
    },
    [fresh, id, qc, note?.locked],
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
  // Local changes say "" (or 0) for none; the note says null.
  const color = (meta?.color ?? note.color) || null
  const remindAt = (meta?.remindAt ?? note.remindAt) || null
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
  // Lock it now, or after the passphrase step: set one, or unlock with it.
  const lockIt = async () => {
    try {
      await (await getCoreClient()).lockNote(id)
      // Its shared copy on the relay is emptied, so only the sealed text remains.
      void notesSync()?.blank(id)
      refresh()
      void qc.invalidateQueries({ queryKey: ["notes", "note", id] })
      toast.success("Locked. Only its title shows until you unlock it.", { duration: 3000 })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }
  const lock = () => (unlocked ? void lockIt() : setAskPassphrase(true))
  const unlockForGood = async () => {
    try {
      await (await getCoreClient()).removeNoteLock(id)
      void qc.invalidateQueries({ queryKey: ["notes"] })
      toast.success("Lock removed", { duration: 2500 })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }
  const lockNow = async () => {
    await (await getCoreClient()).lockNotesNow()
    void qc.invalidateQueries({ queryKey: ["notes"] })
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdownRef.current ?? openLocked?.markdown ?? note.markdown)
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
            {note.locked && <Icon name="lock" className="mr-1 inline size-3.5 align-[-2px]" label="Locked" />}
            {current.archived ? "Archived · " : ""}Edited {longTime(note.updated)}
          </span>
          {note.locked && unlocked && (
            <IconButton label="Lock now" tooltip="Lock now (locked notes close)" onClick={() => void lockNow()}>
              <Icon name="lock_open" className="size-5" />
            </IconButton>
          )}
          <IconButton
            label="Pin"
            tooltip={current.pinned ? "Unpin" : "Pin to the top"}
            render={<Toggle size="sm" pressed={current.pinned} onPressedChange={(pinned) => void update({ pinned })} />}
          >
            <Icon name="keep" fill={current.pinned} className={current.pinned ? "text-vertical-notes" : undefined} />
          </IconButton>
          <RemindMenu
          value={remindAt}
          onPick={(at) => void update({ remindAt: at ?? 0 }).then(() => toast.success(at ? `Reminder set for ${reminderLabel(at)}` : "Reminder removed", { duration: 2500 }))}
        />
        <NoteColorMenu value={color} onChange={(c) => void update({ color: c ?? "" })} />
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="Note actions" />}>
              <Icon name="more_horiz" className="size-5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => void archive()}>
                <Icon name={current.archived ? "unarchive" : "archive"} /> {current.archived ? "Unarchive" : "Archive"}
              </DropdownMenuItem>
              {(!note.locked || unlocked) && (
                <DropdownMenuItem onClick={() => void copy()}>
                  <Icon name="content_copy" /> Copy as Markdown
                </DropdownMenuItem>
              )}
              {!note.locked ? (
                <DropdownMenuItem onClick={lock}>
                  <Icon name="lock" /> Lock note
                </DropdownMenuItem>
              ) : (
                unlocked && (
                  <DropdownMenuItem onClick={() => void unlockForGood()}>
                    <Icon name="lock_open_right" /> Remove lock
                  </DropdownMenuItem>
                )
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => void del()}>
                <Icon name="delete" /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-4 pt-1 md:px-8">
          {remindAt && <ReminderChip at={remindAt} onDone={() => void update({ remindAt: 0 })} />}
          {current.links.map((l) => (
            <LinkChip key={`${l.kind}:${l.key}`} link={l} onOpen={(target) => void open(l.kind, target)} onRemove={() => void update({ links: current.links.filter((x) => x !== l) })} />
          ))}
          <TagEditor tags={current.tags} onChange={(tags) => void update({ tags })} />
          <Button variant="ghost-muted" size="sm" shape="pill" className="h-7" aria-label="Link to an event, person, or conversation" onClick={() => setPicking(true)}>
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
        <PassphraseDialog
          open={askPassphrase}
          onOpenChange={setAskPassphrase}
          onDone={() => {
            setAskPassphrase(false)
            void lockIt()
          }}
        />
        <LinkedFrom id={id} />

        {note.locked && !unlocked ? (
          <LockedPanel title={note.title} />
        ) : note.locked && !openLocked ? (
          lockedError ? <LockedPanel title={note.title} /> : <Skeleton className="mx-8 mt-4 h-24" />
        ) : (
        <NoteEditor
          key={note.locked ? `${id}-locked` : id}
          note={note.locked && openLocked ? openLocked : note}
          locked={note.locked}
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
        )}
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
        <Button variant="ghost-muted" size="sm" shape="pill" className="h-7" onClick={() => setAdding("")}>
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

/** The note's reminder: when it comes back, or, once that's passed, that it's
 * due, with Done to put it away (ADR-0039). */
function ReminderChip({ at, onDone }: { at: number; onDone: () => void }) {
  const now = useNowSecs(30_000)
  const due = at <= now
  return (
    <span
      data-slot="note-reminder"
      data-due={due || undefined}
      className="inline-flex h-7 items-center overflow-hidden rounded-full border bg-muted/50 text-xs data-due:border-vertical-notes data-due:bg-vertical-notes/15"
    >
      <span className="inline-flex items-center gap-1 pr-1 pl-2.5">
        <Icon name={due ? "notifications_active" : "schedule"} fill={due} className="size-3.5" />
        {due ? `Due · ${reminderLabel(at)}` : reminderLabel(at)}
      </span>
      <button
        type="button"
        className="inline-flex h-full items-center gap-1 px-2 hover:bg-muted"
        aria-label={due ? "Done with this reminder" : "Remove reminder"}
        onClick={onDone}
      >
        <Icon name={due ? "check" : "close"} className="size-3.5" />
        {due && "Done"}
      </button>
    </span>
  )
}
