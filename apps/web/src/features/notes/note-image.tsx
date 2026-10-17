import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react"
import { useState } from "react"
import { toast } from "sonner"

import { Icon, Button } from "@unicron/ui"
import { useNoteFile } from "@/core/queries"
import { fromSvg, SVG_MIME } from "@/lib/sketch"
import { cn } from "@/lib/utils"

import { useImageViewer } from "./image-viewer-store"
import { noteFileId } from "./note-src"
import { useSketchSheet } from "./sketch-store"

const frame = "inline-flex max-w-full items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 align-middle text-sm text-muted-foreground"

export function NoteImageView({ node, selected, updateAttributes, editor, getPos }: ReactNodeViewProps) {
  const { src, alt } = node.attrs as { src: string; alt: string }
  const id = noteFileId(src)
  const file = useNoteFile(id)
  const local = file.data?.url ?? null
  // Web images load only when asked: loading one tells its server you read this note.
  const [allowWeb, setAllowWeb] = useState(false)
  const web = !id && /^https:\/\//i.test(src)
  const shown = id ? local : web && allowWeb ? src : null
  const [broken, setBroken] = useState(false)
  // The description being typed; saved on Enter or leaving the field, so one
  // edit is one change in the note's history, not one per letter.
  const [draft, setDraft] = useState<string | null>(null)
  const backToText = () => {
    const at = getPos()
    const chain = editor.chain().focus()
    ;(typeof at === "number" ? chain.setTextSelection(at + node.nodeSize) : chain).run()
  }
  // The text read from the image (ADR-0045), shown on request.
  const found = file.data?.text ?? ""
  const [showText, setShowText] = useState(false)
  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(found)
      toast.success("Copied the text", { duration: 2000 })
    } catch {
      toast.error("Couldn't copy: the browser blocked it")
    }
  }
  // A sketch (ADR-0046) shows on its paper, and opens again to edit.
  const sketch = file.data?.mime === SVG_MIME
  const editSketch = async () => {
    const at = getPos()
    const parsed = file.data ? fromSvg(await (await fetch(file.data.url)).text()) : null
    if (!parsed || typeof at !== "number") return void toast.error("This sketch can't be edited here")
    useSketchSheet.getState().show(parsed, at)
  }
  const insertText = () => {
    const at = getPos()
    if (typeof at !== "number") return
    // Each line its own paragraph, right after the image's.
    const paragraphs = found.split("\n").filter((l) => l.trim()).map((l) => ({ type: "paragraph", content: [{ type: "text", text: l }] }))
    const after = editor.state.doc.resolve(at).after()
    editor.chain().focus().insertContentAt(after, paragraphs).run()
    setShowText(false)
  }
  // Full screen (ADR-0067), with the note's other images to page through.
  const view = () => {
    if (!id) return
    const images: { id: string; alt: string }[] = []
    editor.state.doc.descendants((n) => {
      const other = n.type.name === node.type.name ? noteFileId(String(n.attrs.src ?? "")) : null
      if (other && !images.some((i) => i.id === other)) images.push({ id: other, alt: String(n.attrs.alt ?? "") })
    })
    useImageViewer.getState().show(images, Math.max(0, images.findIndex((i) => i.id === id)))
  }
  const commit = () => {
    if (draft !== null && draft.trim() !== alt) updateAttributes({ alt: draft.trim() })
    setDraft(null)
  }

  let body: React.ReactNode
  if (id && file.isPending) {
    body = <span className="block aspect-video w-72 max-w-full animate-pulse rounded-lg bg-muted" role="img" aria-label={alt || "Image"} aria-busy="true" />
  } else if (id && (file.isError || broken)) {
    const locked = file.error instanceof Error && /passphrase/i.test(file.error.message)
    body = (
      <span className={frame} role="img" aria-label={alt || "Image"}>
        <Icon name={locked ? "lock" : "hide_image"} className="size-5" />
        {locked ? "Unlock notes to see this image" : "This image isn't on this device yet"}
      </span>
    )
  } else if (web && !allowWeb) {
    let host = ""
    try {
      host = new URL(src).host
    } catch {
      // Not a real address: nothing to show, nothing to load.
    }
    body = (
      <span className={frame}>
        <Icon name="image" className="size-5" />
        <span className="min-w-0 truncate">{alt || "Web image"}</span>
        <Button type="button" size="xs" variant="outline" onClick={() => setAllowWeb(true)}>
          Show from {host || "the web"}
        </Button>
      </span>
    )
  } else if (shown) {
    body = (
      <img
        src={shown}
        alt={alt}
        draggable={false}
        onError={() => setBroken(true)}
        onDoubleClick={id ? view : undefined}
        className={cn(
          "block max-h-[70vh] max-w-full rounded-lg border object-contain",
          sketch && "bg-(--c-sketch-paper)",
          selected && "ring-2 ring-ring ring-offset-2 ring-offset-background",
        )}
      />
    )
  } else {
    body = (
      <span className={frame} role="img" aria-label={alt || "Image"}>
        <Icon name="hide_image" className="size-5" />
        {alt || "Image"}
      </span>
    )
  }

  return (
    <NodeViewWrapper as="span" className="my-1 inline-flex max-w-full flex-col gap-1.5 align-bottom" data-drag-handle>
      {body}
      {/* The description is how the image reads aloud, and what search sees. */}
      {(selected || draft !== null || showText) && (id || ((found || sketch) && editor.isEditable)) && (
        <span className="flex flex-wrap items-center gap-1.5" contentEditable={false}>
          {id && local && (
            <Button type="button" size="xs" variant="outline" onClick={view}>
              <Icon name="fullscreen" data-icon="inline-start" /> View
            </Button>
          )}
          {sketch && editor.isEditable && (
            <Button type="button" size="xs" variant="outline" onClick={() => void editSketch()}>
              <Icon name="draw" data-icon="inline-start" /> Edit sketch
            </Button>
          )}
          {found && editor.isEditable && (
            <Button type="button" size="xs" variant="outline" aria-expanded={showText} onClick={() => setShowText((v) => !v)}>
              <Icon name="document_scanner" data-icon="inline-start" /> Text in image
            </Button>
          )}
        </span>
      )}
      {showText && found && (
        <span role="region" aria-label="Text in image" className="flex w-96 max-w-full flex-col gap-2 rounded-lg border bg-popover p-3 text-sm" contentEditable={false}>
          <span className="max-h-48 overflow-y-auto whitespace-pre-wrap select-text">{found}</span>
          <span className="flex flex-wrap justify-end gap-1.5">
            <Button type="button" size="xs" variant="ghost" onClick={() => setShowText(false)}>
              Close
            </Button>
            <Button type="button" size="xs" variant="outline" onClick={() => void copyText()}>
              <Icon name="content_copy" data-icon="inline-start" /> Copy
            </Button>
            <Button type="button" size="xs" variant="secondary" onClick={insertText}>
              <Icon name="text_fields" data-icon="inline-start" /> Add to note
            </Button>
          </span>
        </span>
      )}
      {(selected || draft !== null) && editor.isEditable && (
        <input
          aria-label="Image description"
          placeholder="Describe this image for people who can't see it"
          className="h-8 w-80 max-w-full rounded-md border bg-background px-2 text-sm"
          value={draft ?? alt}
          onFocus={() => setDraft(alt)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            // Enter keeps it, Escape drops it; both go back to writing, after the image.
            if (e.key === "Enter" || e.key === "Escape") {
              e.preventDefault()
              if (e.key === "Enter") commit()
              else setDraft(null)
              backToText()
            }
          }}
        />
      )}
    </NodeViewWrapper>
  )
}

/**
 * A card's thumbnail: the note's first image, edge to edge on top, the way
 * Keep shows photos. Decorative: the card's title already names the note.
 */
export function NoteCover({ id, className }: { id: string; className?: string }) {
  const file = useNoteFile(id)
  const url = file.data?.url
  if (file.isError) return null
  return url ? (
    <img src={url} alt="" draggable={false} className={cn("block max-h-48 w-full object-cover", file.data?.mime === SVG_MIME && "bg-(--c-sketch-paper) object-contain", className)} />
  ) : (
    <span aria-hidden className={cn("block h-24 w-full animate-pulse bg-foreground/5", className)} />
  )
}
