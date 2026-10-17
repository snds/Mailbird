import { useEffect, useState } from "react"

import { Icon, Button, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, Spinner } from "@unicron/ui"
import { getCoreClient } from "@/core/client"
import type { AttachmentInfo } from "@/core/types"

import { isPdf, type PreviewKind } from "./attachment-kind"
import { formatSize } from "./format"

type Loaded = { kind: "image" | "pdf"; url: string } | { kind: "text"; text: string } | { kind: "error"; message: string }

/** Mounted only while the dialog is open, so every open starts from a clean fetch. */
function PreviewBody({ file, kind }: { file: AttachmentInfo; kind: PreviewKind }) {
  const [loaded, setLoaded] = useState<Loaded>()
  useEffect(() => {
    let live = true
    let made: string | undefined
    getCoreClient()
      .then((c) => c.attachmentData(file.id))
      .then((data) => {
        if (!live) return
        const bytes = new Uint8Array(data)
        if (kind === "text") {
          setLoaded({ kind, text: new TextDecoder().decode(bytes) })
        } else if (kind === "pdf" && !isPdf(bytes)) {
          setLoaded({ kind: "error", message: "This file says it's a PDF, but it isn't one." })
        } else {
          made = URL.createObjectURL(new Blob([bytes], { type: kind === "pdf" ? "application/pdf" : file.mimeType }))
          setLoaded({ kind, url: made })
        }
      })
      .catch((e) => live && setLoaded({ kind: "error", message: e instanceof Error ? e.message : String(e) }))
    return () => {
      live = false
      if (made) URL.revokeObjectURL(made)
    }
  }, [kind, file.id, file.mimeType])

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg bg-muted" data-slot="preview-body">
      {!loaded && <Spinner className="size-6" />}
      {loaded?.kind === "image" && <img src={loaded.url} alt={file.filename} className="max-h-full max-w-full object-contain" />}
      {loaded?.kind === "pdf" && <iframe src={loaded.url} title={file.filename} className="size-full border-0 bg-white" />}
      {loaded?.kind === "text" && (
        <pre className="size-full overflow-auto p-4 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">{loaded.text}</pre>
      )}
      {loaded?.kind === "error" && (
        <p className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
          <Icon name="error" className="size-4" /> {loaded.message}
        </p>
      )}
    </div>
  )
}

export function AttachmentPreview({
  file,
  kind,
  open,
  onOpenChange,
  onSave,
}: {
  file: AttachmentInfo
  kind: PreviewKind
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="2xl" className="flex h-[min(85dvh,56rem)] flex-col" aria-describedby={undefined}>
        <DialogHeader className="pr-8">
          <DialogTitle className="truncate">{file.filename}</DialogTitle>
          <p className="text-xs text-muted-foreground">
            {file.mimeType} · {formatSize(file.size)}
          </p>
        </DialogHeader>
        {open && <PreviewBody file={file} kind={kind} />}
        <DialogFooter>
          <Button variant="outline" onClick={onSave}>
            <Icon name="download" data-icon="inline-start" /> Save and open
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
