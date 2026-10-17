import { HocuspocusProvider } from "@hocuspocus/provider"
import Collaboration from "@tiptap/extension-collaboration"
import { Placeholder } from "@tiptap/extensions"
import { NodeSelection } from "@tiptap/pm/state"
import { type Editor, EditorContent, useEditor, useEditorState } from "@tiptap/react"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import type * as Y from "yjs"

import { Icon } from "@unicron/ui"
import { getCoreClient } from "@/core/client"
import { queryClient, useMyName, useNotesPrefs } from "@/core/queries"
import type { NoteDetail, NotesPrefs } from "@/core/types"

import { toBase64 } from "@/lib/base64"
import { prepareImage } from "@/lib/image"
import { type Sketch, SVG_MIME, toSvg } from "@/lib/sketch"

import { FormatBar } from "../mail/rich-editor"
import { SortChecked } from "./checklists"
import { noteExtensions } from "./extensions"
import { NOTE_FILE } from "./note-src"
import { ScanSheet } from "./scan-sheet"
import { SealedProvider } from "./sealed"
import { SketchSheet } from "./sketch-sheet"
import { useSketchSheet } from "./sketch-store"
import { guestShares, useLiveShareModes } from "./shared-docs"
import { notesSync, useSyncStatus } from "./sync"
import { type Choice, openWikiLink, pickChoice, useWikiChoices, wikiQueryAt } from "./wiki-links"
import { WikiSuggest } from "./wiki-suggest"
import { linkPlainWikiText } from "./wikilink"
import { isEmpty, loadDoc, markdownOf, seed, stateOf } from "./ydoc"

const SAVE_DELAY = 400

const sortsChecked = () => queryClient.getQueryData<NotesPrefs>(["notes", "prefs"])?.sortChecked ?? true

/** Origins that aren't this person typing: loading, seeding, and other devices. */
const notMine = (origin: unknown) => origin === "load" || origin === "seed" || origin instanceof HocuspocusProvider || origin instanceof SealedProvider

/**
 * The note's text, edited as a Yjs document so other devices' edits merge
 * in live. Every change saves Markdown plus Yjs state to the core (after a
 * short pause, and when the note closes).
 */
export function NoteEditor({ note, autoFocus, onSaved, locked = false }: { note: NoteDetail; autoFocus: boolean; onSaved: (markdown: string) => void; locked?: boolean }) {
  // One document per open note; the parent keys this component by note id.
  const [doc] = useState(() => {
    const d = loadDoc(note.ydoc)
    if (isEmpty(d) && note.share?.role !== "guest") seed(d, note.markdown, note.id)
    return d
  })
  // A note opened for the first time has new Yjs state to save right away.
  // A locked one has none to keep: only its sealed text is saved (ADR-0043).
  // A note shared with you takes its text from the owner's document, never a seed (ADR-0056).
  const guest = note.share?.role === "guest" ? note.share : null
  const liveMode = useLiveShareModes((m) => m[note.id])
  const readOnly = !!guest && (liveMode ?? guest.mode) === "view"
  const [seeded] = useState(() => !locked && !guest && note.ydoc === null && note.markdown.trim() !== "")

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
      editable: !readOnly,
      autofocus: autoFocus && !readOnly ? "end" : false,
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
        // Pasted or dropped images become the note's own (ADR-0044).
        handlePaste: (_view, event) => {
          const files = imagesIn(event.clipboardData)
          if (!files.length) return false
          void addImages(editorRef.current, note.id, files)
          return true
        },
        handleDrop: (view, event) => {
          const files = imagesIn((event as DragEvent).dataTransfer)
          if (!files.length) return false
          event.preventDefault()
          const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
          void addImages(editorRef.current, note.id, files, at)
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
  // A link turned view-only (or back) while the note is open.
  useEffect(() => {
    if (editor.isEditable === readOnly) editor.setEditable(!readOnly)
  }, [editor, readOnly])
  const editorRef = useRef(editor)
  useEffect(() => {
    editorRef.current = editor
  }, [editor])
  const picker = useRef<HTMLInputElement>(null)
  const [scanning, setScanning] = useState(false)

  // Live edits from other devices while this note is open.
  // Which sync is running: a new one (say, encryption turned on) needs the note again.
  const syncing = useSyncStatus((s) => (s.status !== "off" ? s.run : 0))
  // Who the others see here (ADR-0061), read when the connection opens.
  const me = useMyName()
  const meRef = useRef(me)
  useEffect(() => {
    meRef.current = me
  })
  // A note shared with you is live on the owner's relay, yours or not.
  const guestRef = useRef(guest)
  useEffect(() => {
    guestRef.current = guest
  })
  const guestId = guest && !guest.revoked ? guest.id : null
  useEffect(() => {
    if (!guestId || !guestRef.current) return
    return guestShares()?.attach(note.id, guestRef.current, doc, meRef.current)
  }, [guestId, note.id, doc])
  const shareId = note.share?.revoked ? null : (note.share?.id ?? null)
  const shareRef = useRef(note.share)
  useEffect(() => {
    shareRef.current = note.share
  })
  useEffect(() => {
    // A locked note never joins its shared document.
    if (!syncing || locked || guestId) return
    try {
      return notesSync()?.attach(note.id, doc, shareRef.current, meRef.current)
    } catch {
      // Live sync for this note failed to start; it still saves locally and syncs when closed.
      return undefined
    }
    // Sharing (or stopping) moves the note to another document.
  }, [syncing, note.id, doc, locked, guestId, shareId])

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
        {readOnly ? (
          <p className="flex items-center gap-2 px-4 py-2 text-xs text-muted-foreground md:px-8 [&_svg]:size-4" role="status">
            <Icon name="visibility" />
            {guest?.from ? `${guest.from} shared this note for reading` : "Shared with you for reading"}. Their changes show up here.
          </p>
        ) : (
        <FormatBar editor={editor} notes onAddImage={() => picker.current?.click()} onScan={() => setScanning(true)} onSketch={() => useSketchSheet.getState().show(null, null)} />
        )}
        <SketchSheet onDone={(s, pos) => void saveSketch(editor, note.id, s, pos)} />
        <ScanSheet open={scanning} onOpenChange={setScanning} onScanned={(pages) => void addScans(editor, note.id, pages)} />
        <input
          ref={picker}
          type="file"
          accept="image/*"
          multiple
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])]
            e.target.value = ""
            void addImages(editor, note.id, files)
          }}
        />
      </div>
    </div>
  )
}

const imagesIn = (data: DataTransfer | null) => [...(data?.files ?? [])].filter((f) => f.type.startsWith("image/"))

/**
 * Shrinks each image, stores it with the note, and puts it in the text at
 * `at` (or the cursor). A failed one says why; the rest still go in.
 */
/** Scanned pages go in order, each described with its place in the document (ADR-0068). */
async function addScans(editor: Editor, noteId: string, pages: File[]) {
  for (const [i, page] of pages.entries()) await addImages(editor, noteId, [page], undefined, pages.length > 1 ? `Scanned document, page ${i + 1} of ${pages.length}` : "Scanned document")
}

async function addImages(editor: Editor, noteId: string, files: File[], at?: number, alt = "") {
  const core = await getCoreClient()
  for (const f of files) {
    try {
      const img = await prepareImage(f)
      const stored = await core.addNoteFile(noteId, img.mime, img.dataBase64, img.width, img.height)
      const node = { type: "noteImage", attrs: { src: `${NOTE_FILE}${stored.id}`, alt } }
      const chain = editor.chain().focus()
      ;(at === undefined ? chain : chain.setTextSelection(at)).insertContent(node).run()
      at = undefined
    } catch (e) {
      toast.error(`${f.name || "Image"}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

/**
 * Stores a sketch (ADR-0046) and puts it in the note; an edited one takes
 * the old one's place. Each save is a new image: images never change once
 * stored, so other devices and caches never show a stale one.
 */
async function saveSketch(editor: Editor, noteId: string, sketch: Sketch, pos: number | null) {
  try {
    const svg = toSvg(sketch)
    const stored = await (await getCoreClient()).addNoteFile(noteId, SVG_MIME, toBase64(new TextEncoder().encode(svg)), sketch.w, sketch.h)
    const src = `${NOTE_FILE}${stored.id}`
    const node = pos === null ? null : editor.state.doc.nodeAt(pos)
    if (pos !== null && node?.type.name === "noteImage") {
      editor.chain().focus().command(({ tr }) => (tr.setNodeMarkup(pos, undefined, { ...node.attrs, src }), true)).run()
    } else {
      editor.chain().focus().insertContent({ type: "noteImage", attrs: { src, alt: "Sketch" } }).run()
    }
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e))
  }
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
