import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react"
import { useState } from "react"

import { Icon } from "@/components/icon"
import { Button } from "@/components/ui/button"
import { useNoteFile } from "@/core/queries"
import { cn } from "@/lib/utils"

import { noteFileId } from "./note-src"

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
        <Icon name={locked ? "lock" : "hide_image"} className="size-5 shrink-0" />
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
        <Icon name="image" className="size-5 shrink-0" />
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
        className={cn("block max-h-[70vh] max-w-full rounded-lg border object-contain", selected && "ring-2 ring-ring ring-offset-2 ring-offset-background")}
      />
    )
  } else {
    body = (
      <span className={frame} role="img" aria-label={alt || "Image"}>
        <Icon name="hide_image" className="size-5 shrink-0" />
        {alt || "Image"}
      </span>
    )
  }

  return (
    <NodeViewWrapper as="span" className="my-1 inline-flex max-w-full flex-col gap-1.5 align-bottom" data-drag-handle>
      {body}
      {/* The description is how the image reads aloud, and what search sees. */}
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
    <img src={url} alt="" draggable={false} className={cn("block max-h-48 w-full object-cover", className)} />
  ) : (
    <span aria-hidden className={cn("block h-24 w-full animate-pulse bg-foreground/5", className)} />
  )
}
