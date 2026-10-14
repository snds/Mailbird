import { HocuspocusProvider } from "@hocuspocus/provider"
import Collaboration from "@tiptap/extension-collaboration"
import { Placeholder } from "@tiptap/extensions"
import { EditorContent, useEditor } from "@tiptap/react"
import { useEffect, useRef, useState } from "react"
import type * as Y from "yjs"

import { getCoreClient } from "@/core/client"
import type { NoteDetail } from "@/core/types"

import { FormatBar } from "../mail/rich-editor"
import { noteExtensions } from "./extensions"
import { notesSync, useSyncStatus } from "./sync"
import { isEmpty, loadDoc, markdownOf, seed, stateOf } from "./ydoc"

const SAVE_DELAY = 400

/** Origins that aren't this person typing: loading, seeding, and other devices. */
const notMine = (origin: unknown) => origin === "load" || origin === "seed" || origin instanceof HocuspocusProvider

/**
 * The note's text, edited as a Yjs document so other devices' edits merge
 * in live. Every change saves Markdown plus Yjs state to the core (after a
 * short pause, and when the note closes).
 */
export function NoteEditor({ note, autoFocus, onSaved }: { note: NoteDetail; autoFocus: boolean; onSaved: (markdown: string) => void }) {
  // One document per open note; the parent keys this component by note id.
  const [doc] = useState(() => {
    const d = loadDoc(note.ydoc)
    if (isEmpty(d)) seed(d, note.markdown, note.id)
    return d
  })
  // A note opened for the first time has new Yjs state to save right away.
  const [seeded] = useState(() => note.ydoc === null && note.markdown.trim() !== "")

  const savedRef = useRef(onSaved)
  useEffect(() => {
    savedRef.current = onSaved
  }, [onSaved])
  useEffect(() => {
    const saver = new NoteSaver(note.id, doc, seeded, (md) => savedRef.current(md))
    return () => saver.close()
  }, [note.id, doc, seeded])

  const editor = useEditor(
    {
      extensions: [
        ...noteExtensions,
        Collaboration.configure({ document: doc }),
        Placeholder.configure({ placeholder: ({ pos }) => (pos === 0 ? "Title" : "Write something…") }),
      ],
      immediatelyRender: true,
      autofocus: autoFocus ? "end" : false,
      editorProps: {
        attributes: {
          role: "textbox",
          "aria-label": "Note",
          "aria-multiline": "true",
          class: "note-body min-h-full px-4 py-4 text-[15px] leading-relaxed outline-none md:px-8",
        },
      },
    },
    [doc],
  )

  // Live edits from other devices while this note is open.
  const syncing = useSyncStatus((s) => s.status !== "off")
  useEffect(() => {
    if (!syncing) return
    try {
      return notesSync()?.attach(note.id, doc)
    } catch {
      // Live sync for this note failed to start; it still saves locally and syncs when closed.
      return undefined
    }
  }, [syncing, note.id, doc])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <EditorContent editor={editor} className="min-h-0 flex-1 overflow-y-auto [&>div]:min-h-full" />
      <div className="sticky bottom-0 bg-background">
        <FormatBar editor={editor} notes />
      </div>
    </div>
  )
}

/** Debounced save of Markdown + Yjs state; marks the note edited only for this person's changes. */
class NoteSaver {
  private timer: ReturnType<typeof setTimeout> | undefined
  private dirty: boolean
  private touch = false
  private id: string
  private doc: Y.Doc
  private onSaved: (markdown: string) => void
  /** The text as the editor writes it when the note opened. Opening alone
   *  can re-shape it (a trailing paragraph, list markers), which isn't an edit. */
  private last: string

  constructor(id: string, doc: Y.Doc, seeded: boolean, onSaved: (markdown: string) => void) {
    this.id = id
    this.doc = doc
    this.last = markdownOf(doc)
    this.onSaved = onSaved
    this.dirty = seeded
    doc.on("update", this.onUpdate)
    if (seeded) this.timer = setTimeout(this.run, 0)
  }

  private onUpdate = (_u: Uint8Array, origin: unknown) => {
    this.dirty = true
    if (!notMine(origin)) this.touch = true
    clearTimeout(this.timer)
    this.timer = setTimeout(this.run, SAVE_DELAY)
  }

  private run = () => {
    clearTimeout(this.timer)
    if (!this.dirty) return
    const md = markdownOf(this.doc)
    const touch = this.touch && md !== this.last
    this.last = md
    this.dirty = this.touch = false
    void getCoreClient()
      .then((c) => c.saveNoteBody(this.id, md, stateOf(this.doc), touch))
      .then(() => this.onSaved(md))
  }

  close() {
    this.doc.off("update", this.onUpdate)
    this.run()
  }
}
