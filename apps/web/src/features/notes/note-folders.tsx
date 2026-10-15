import { useState } from "react"
import { toast } from "sonner"

import { Icon, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, NativeSelect, NativeSelectOption, Switch } from "@unicron/ui"
import { useNoteAction, useNoteFolders, useNoteTags } from "@/core/queries"
import { NOTE_COLORS, type NoteColor, type NoteFolder, type NoteFolderInput } from "@/core/types"
import { cn } from "@/lib/utils"

import { NOTE_COLOR_LABEL, noteEdge, noteFill } from "./note-color"

const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e))
const noteCount = (n: number) => `${n} ${n === 1 ? "note" : "notes"}`

/** Smart folders as chips (ADR-0042): saved searches that fill themselves. */
export function NoteFolderChips({ active, onPick }: { active: string | null; onPick: (id: string | null) => void }) {
  const { data: folders = [] } = useNoteFolders()
  const [editing, setEditing] = useState<{ folder?: NoteFolder } | null>(null)
  const current = folders.find((f) => f.id === active)
  return (
    <div role="group" aria-label="Smart folders" className="-mx-4 no-scrollbar flex items-center gap-1.5 overflow-x-auto px-4">
      {folders.map((f) => (
        <Button
          key={f.id}
          size="xs"
          variant={active === f.id ? "secondary" : "ghost"}
          aria-pressed={active === f.id}
          shape="pill"
          onClick={() => onPick(active === f.id ? null : f.id)}
        >
          <Icon name="folder_special" data-icon="inline-start" className="text-vertical-notes" />
          {f.name}
          <span className="text-muted-foreground tabular-nums">{f.count}</span>
        </Button>
      ))}
      {current ? (
        <Button size="icon-xs" variant="ghost" shape="pill" aria-label="Edit smart folder" onClick={() => setEditing({ folder: current })}>
          <Icon name="tune" />
        </Button>
      ) : (
        <Button size="xs" variant="ghost-muted" shape="pill" onClick={() => setEditing({})}>
          <Icon name="add" data-icon="inline-start" /> Smart folder
        </Button>
      )}
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="sm:max-w-md">
          {editing && (
            <NoteFolderForm
              key={editing.folder?.id ?? "new"}
              folder={editing.folder}
              onDone={(id) => {
                setEditing(null)
                if (id !== undefined) onPick(id)
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function NoteFolderForm({ folder, onDone }: { folder?: NoteFolder; onDone: (picked?: string | null) => void }) {
  const { data: tags = [] } = useNoteTags()
  const [name, setName] = useState(folder?.name ?? "")
  const [picked, setPicked] = useState<string[]>(folder?.tags ?? [])
  const [words, setWords] = useState(folder?.words ?? "")
  const [linked, setLinked] = useState<NoteFolderInput["linked"]>(folder?.linked ?? null)
  const [color, setColor] = useState<NoteFolderInput["color"]>(folder?.color ?? null)
  const [hasReminder, setHasReminder] = useState(folder?.hasReminder ?? false)
  const [hasOpenTasks, setHasOpenTasks] = useState(folder?.hasOpenTasks ?? false)
  const save = useNoteAction((c, input: NoteFolderInput) => c.saveNoteFolder(folder?.id ?? null, input))
  const remove = useNoteAction<void>((c) => c.deleteNoteFolder(folder!.id))
  // Tags in use plus any this folder names that no note carries right now.
  const choices = [...new Set([...tags.map((t) => t.tag), ...picked])]
  const toggle = (t: string) => setPicked((p) => (p.includes(t) ? p.filter((x) => x !== t) : [...p, t]))

  const submit = async () => {
    try {
      const f = await save.mutateAsync({ name, tags: picked, words: words.trim() || null, linked, color, hasReminder, hasOpenTasks })
      toast.success(folder ? `Updated “${f.name}”` : `Added “${f.name}”: ${noteCount(f.count)} so far`, { duration: 2500 })
      onDone(f.id)
    } catch (e) {
      fail(e)
    }
  }
  const del = async () => {
    try {
      await remove.mutateAsync()
      toast.success(`Deleted “${folder!.name}”. Its notes are still in Notes.`, { duration: 2500 })
      onDone(null)
    } catch (e) {
      fail(e)
    }
  }
  const field = "h-9 w-full rounded-lg border bg-transparent px-2.5 text-sm dark:bg-input/30"
  const swatch = "size-7 rounded-full border ring-offset-2 ring-offset-popover aria-pressed:ring-2 aria-pressed:ring-foreground"
  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => (e.preventDefault(), void submit())}>
      <DialogHeader>
        <DialogTitle>{folder ? "Edit smart folder" : "New smart folder"}</DialogTitle>
        <DialogDescription>Notes come and go by themselves as you write. Fill in what applies: they must match all of it.</DialogDescription>
      </DialogHeader>
      <label className="flex flex-col gap-1 text-sm">
        Name
        <input id="folder-name" className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="To do, This week, Recipes…" autoFocus />
      </label>
      {choices.length > 0 && (
        <div role="group" aria-label="Has any of these tags" className="flex flex-col gap-1.5 text-sm">
          Has any of these tags
          <div className="flex flex-wrap gap-1.5">
            {choices.map((t) => (
              <Button key={t} type="button" size="xs" variant={picked.includes(t) ? "secondary" : "outline"} aria-pressed={picked.includes(t)} shape="pill" onClick={() => toggle(t)}>
                #{t}
              </Button>
            ))}
          </div>
        </div>
      )}
      <label className="flex flex-col gap-1 text-sm">
        Contains the words
        <input id="folder-words" className={field} value={words} onChange={(e) => setWords(e.target.value)} placeholder="agenda" />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Linked to
        <NativeSelect id="folder-linked" value={linked ?? ""} onChange={(e) => setLinked((e.target.value || null) as NoteFolderInput["linked"])} className="w-full">
          <NativeSelectOption value="">It doesn't matter</NativeSelectOption>
          <NativeSelectOption value="any">Anything</NativeSelectOption>
          <NativeSelectOption value="event">An event</NativeSelectOption>
          <NativeSelectOption value="contact">A person</NativeSelectOption>
          <NativeSelectOption value="thread">A conversation</NativeSelectOption>
        </NativeSelect>
      </label>
      <div role="group" aria-label="Color" className="flex flex-col gap-1.5 text-sm">
        Color
        <div className="flex flex-wrap items-center gap-1.5">
          <Button type="button" size="xs" variant={color === null ? "secondary" : "outline"} aria-pressed={color === null} shape="pill" onClick={() => setColor(null)}>
            Any or none
          </Button>
          <Button type="button" size="xs" variant={color === "any" ? "secondary" : "outline"} aria-pressed={color === "any"} shape="pill" onClick={() => setColor("any")}>
            Any color
          </Button>
          {NOTE_COLORS.map((c: NoteColor) => (
            <button
              key={c}
              type="button"
              aria-label={NOTE_COLOR_LABEL[c]}
              aria-pressed={color === c}
              title={NOTE_COLOR_LABEL[c]}
              className={cn(swatch)}
              style={{ background: noteFill(c), borderColor: noteEdge(c) }}
              onClick={() => setColor(color === c ? null : c)}
            />
          ))}
        </div>
      </div>
      <label className="flex items-center justify-between gap-3 text-sm">
        Has a reminder
        <Switch checked={hasReminder} onCheckedChange={setHasReminder} aria-label="Has a reminder" />
      </label>
      <label className="flex items-center justify-between gap-3 text-sm">
        Has to-dos left
        <Switch checked={hasOpenTasks} onCheckedChange={setHasOpenTasks} aria-label="Has to-dos left" />
      </label>
      <DialogFooter className="flex-row items-center">
        {folder && (
          <Button type="button" variant="ghost-destructive" className="mr-auto" onClick={() => void del()}>
            Delete folder
          </Button>
        )}
        <Button type="button" variant="outline" onClick={() => onDone()}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {folder ? "Save" : "Add folder"}
        </Button>
      </DialogFooter>
    </form>
  )
}
