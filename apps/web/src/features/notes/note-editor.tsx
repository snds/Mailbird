import { HocuspocusProvider } from "@hocuspocus/provider"
import Collaboration from "@tiptap/extension-collaboration"
import { Placeholder } from "@tiptap/extensions"
import { NodeSelection } from "@tiptap/pm/state"
import { EditorContent, useEditor, useEditorState } from "@tiptap/react"
import { useEffect, useRef, useState } from "react"
import type * as Y from "yjs"

import { getCoreClient } from "@/core/client"
import { queryClient, useNotesPrefs } from "@/core/queries"
import type { NoteDetail, NotesPrefs } from "@/core/types"

import { FormatBar } from "../mail/rich-editor"
import { SortChecked } from "./checklists"
import { noteExtensions } from "./extensions"
import { notesSync, useSyncStatus } from "./sync"
import { type Choice, openWikiLink, pickChoice, useWikiChoices, wikiQueryAt } from "./wiki-links"
import { WikiSuggest } from "./wiki-suggest"
import { linkPlainWikiText } from "./wikilink"
import { isEmpty, loadDoc, markdownOf, seed, stateOf } from "./ydoc"

const SAVE_DELAY = 400

const sortsChecked = () => queryClient.getQueryData<NotesPrefs>(["notes", "prefs"])?.sortChecked ?? true

/** Origins that aren't this person typing: loading, seeding, and other devices. */
const notMine = (origin: unknown) => origin === "load" || origin === "seed" || origin instanceof HocuspocusProvider

/**
 * The note's text, edited as a Yjs document so other devices' edits merge
 * in live. Every change saves Markdown plus Yjs state to the core (after a
 * short pause, and when the note closes).
 */
export function NoteEditor({ note, autoFocus, onSaved, locked = false }: { note: NoteDetail; autoFocus: boolean; onSaved: (markdown: string) => void; locked?: boolean }) {
  // One document per open note; the parent keys this component by note id.
  const [doc] = useState(() => {
    const d = loadDoc(note.ydoc)
    if (isEmpty(d)) seed(d, note.markdown, note.id)
    return d
  })
  // A note opened for the first time has new Yjs state to save right away.
  // A locked one has none to keep: only its sealed text is saved (ADR-0043).
  const [seeded] = useState(() => !locked && note.ydoc === null && note.markdown.trim() !== "")

  const savedRef = useRef(onSaved)
  useEffect(() => {
    savedRef.current = onSaved
  }, [onSaved])
  useEffect(() => {
    const saver = new NoteSaver(note.id, doc, seeded, (md) => savedRef.current(md), locked)
    return () => saver.close()
  }, [note.id, doc, seeded, locked])

  // Loaded here; the editor reads the cached value on each check, so
  // turning it off applies to the open note too.
  useNotesPrefs()

  // The [[ suggestions: read by the editor's key handler through a ref.
  const suggest = useRef<{ open: boolean; move: (d: number) => void; pick: () => boolean; close: () => void }>({ open: false, move: () => {}, pick: () => false, close: () => {} })

  const editor = useEditor(
    {
      extensions: [
        ...noteExtensions,
        Collaboration.configure({ document: doc }),
        SortChecked.configure({ enabled: sortsChecked }),
        Placeholder.configure({ placeholder: ({ pos }) => (pos === 0 ? "Title" : "Write something…") }),
      ],
      immediatelyRender: true,
      autofocus: autoFocus ? "end" : false,
      // `[[Title]]` still in plain text (older notes, other devices) becomes a link.
      onCreate: ({ editor: e }) => {
        const tr = linkPlainWikiText(e.state)
        if (tr) e.view.dispatch(tr)
      },
      editorProps: {
        handleClickOn: (_view, _pos, node) => {
          if (node.type.name !== "wikiLink") return false
          void openWikiLink(node.attrs.target as string)
          return true
        },
        handleKeyDown: (view, event) => {
          const s = suggest.current
          if (s.open) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") return s.move(event.key === "ArrowDown" ? 1 : -1), true
            if (event.key === "Enter" || event.key === "Tab") return s.pick()
            if (event.key === "Escape") return s.close(), true
          }
          // Enter on a selected link opens it, so keyboards can follow links too.
          const sel = view.state.selection
          if (event.key === "Enter" && sel instanceof NodeSelection && sel.node.type.name === "wikiLink") {
            void openWikiLink(sel.node.attrs.target as string)
            return true
          }
          return false
        },
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
    // A locked note never joins its shared document.
    if (!syncing || locked) return
    try {
      return notesSync()?.attach(note.id, doc)
    } catch {
      // Live sync for this note failed to start; it still saves locally and syncs when closed.
      return undefined
    }
  }, [syncing, note.id, doc, locked])

  // What's typed after [[, and the choices for it.
  const q = useEditorState({ editor, selector: ({ editor: e }) => wikiQueryAt(e), equalityFn: (a, b) => a?.from === b?.from && a?.query === b?.query })
  const [dismissed, setDismissed] = useState<number | null>(null)
  // The highlighted choice, reset whenever the query changes.
  const [picked, setActive] = useState({ query: "", i: 0 })
  const live = q && q.from !== dismissed ? q : null
  const active = picked.query === live?.query ? picked.i : 0
  const choices = useWikiChoices(live, note.id)
  const choose = (c: Choice) => live && pickChoice(editor, live, c.title)
  useEffect(() => {
    suggest.current = {
      open: !!live && choices.length > 0,
      move: (d) => setActive({ query: live?.query ?? "", i: (active + d + choices.length) % choices.length }),
      pick: () => {
        const c = choices[Math.min(active, choices.length - 1)]
        if (!c) return false
        choose(c)
        return true
      },
      close: () => setDismissed(live?.from ?? null),
    }
  })

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <EditorContent editor={editor} className="min-h-0 flex-1 overflow-y-auto [&>div]:min-h-full" />
      {live && <WikiSuggest editor={editor} q={live} choices={choices} active={active} onPick={choose} />}
      <div className="sticky bottom-0 bg-(--note-surface,var(--background)) transition-colors">
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
  private locked: boolean
  /** The text as the editor writes it when the note opened. Opening alone
   *  can re-shape it (a trailing paragraph, list markers), which isn't an edit. */
  private last: string

  constructor(id: string, doc: Y.Doc, seeded: boolean, onSaved: (markdown: string) => void, locked: boolean) {
    this.id = id
    this.doc = doc
    this.locked = locked
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
      .then((c) => (this.locked ? c.saveLockedNote(this.id, md, touch) : c.saveNoteBody(this.id, md, stateOf(this.doc), touch)))
      .then(() => this.onSaved(md))
      // Locked again (by the timer or another window) mid-edit: it reopens behind the passphrase.
      .catch(() => queryClient.invalidateQueries({ queryKey: ["notes"] }))
  }

  close() {
    this.doc.off("update", this.onUpdate)
    this.run()
  }
}
