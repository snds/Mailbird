import { useState } from "react"

import { useUi } from "@/app/ui-store"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, NativeSelect, NativeSelectOption, Switch, DialogAction, DialogActions, Toggle, toast } from "@unicron/ui"
import { useNoteAction, useNoteTags } from "@/core/queries"
import { NOTE_COLORS, type NoteColor, type NoteFolder, type NoteFolderInput } from "@/core/types"
import { cn } from "@/lib/utils"

import { NOTE_COLOR_LABEL, noteEdge, noteFill } from "./note-color"
import { useNoteFolderEditor } from "./open-note-folder"

const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e))
const noteCount = (n: number) => `${n} ${n === 1 ? "note" : "notes"}`

/**
 * Smart folders are saved searches that fill themselves (ADR-0042). Notes
 * mounts this; a saved folder becomes the place, a deleted one gives way to
 * all notes.
 */
export function NoteFolderEditor() {
  const editing = useNoteFolderEditor((s) => s.editing)
  const close = () => useNoteFolderEditor.setState({ editing: null })
  return (
    <Dialog open={editing !== null} onOpenChange={(o) => !o && close()}>
      <DialogContent size="md">
        {editing && (
          <NoteFolderForm
            key={editing.folder?.id ?? "new"}
            folder={editing.folder}
            onDone={(id) => {
              close()
              if (id !== undefined) useUi.getState().setNotesFolder(id ? { kind: "folder", id } : { kind: "all" })
            }}
          />
        )}
      </DialogContent>
    </Dialog>
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
              <Toggle key={t} type="button" size="sm" variant="outline" pressed={picked.includes(t)} onPressedChange={() => toggle(t)}>
                #{t}
              </Toggle>
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
          <Toggle type="button" size="sm" variant="outline" pressed={color === null} onPressedChange={() => setColor(null)}>
            Any or none
          </Toggle>
          <Toggle type="button" size="sm" variant="outline" pressed={color === "any"} onPressedChange={() => setColor("any")}>
            Any color
          </Toggle>
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
      <DialogActions>
        {folder && (
          <DialogAction kind="destructive" type="button" onClick={() => void del()}>
            Delete folder
          </DialogAction>
        )}
        <DialogAction kind="cancel" type="button" onClick={() => onDone()}>
          Cancel
        </DialogAction>
        <DialogAction type="submit" disabled={save.isPending}>
          {folder ? "Save" : "Add folder"}
        </DialogAction>
      </DialogActions>
    </form>
  )
}
