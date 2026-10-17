import { useEffect, useState } from "react"

import { Button, IconButton, Sheet, SheetContent, SheetDescription, SheetTitle, Spinner } from "@unicron/ui"
import { isTauri } from "@/core/client"
import { useNoteFile } from "@/core/queries"
import { SVG_MIME } from "@/lib/sketch"
import { cn } from "@/lib/utils"

import { type ViewerImage, useImageViewer } from "./image-viewer-store"

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", [SVG_MIME]: "svg" }

export function ImageViewer() {
  const { images, at, close } = useImageViewer()
  const open = images.length > 0
  return (
    <Sheet open={open} onOpenChange={(o) => !o && close()}>
      <SheetContent side="bottom" fullscreen showCloseButton={false}>
        {open && <Viewer images={images} at={Math.min(at, images.length - 1)} />}
      </SheetContent>
    </Sheet>
  )
}

function Viewer({ images, at }: { images: ViewerImage[]; at: number }) {
  const go = (to: number) => useImageViewer.setState({ at: (to + images.length) % images.length })
  const image = images[at]
  const file = useNoteFile(image.id)
  // Fit to the screen, or the image at its own size to look closely. Each image opens fitted.
  const [actualFor, setActualFor] = useState<string | null>(null)
  const actual = actualFor === image.id
  useEffect(() => {
    if (images.length < 2) return
    const key = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") go(at + 1)
      if (e.key === "ArrowLeft") go(at - 1)
    }
    // Capture: the sheet's own key handling would otherwise see the arrows first.
    window.addEventListener("keydown", key, true)
    return () => window.removeEventListener("keydown", key, true)
  })
  // A swipe across moves to the next or previous image.
  const [touch, setTouch] = useState<number | null>(null)
  const save = () => {
    if (!file.data) return
    const a = document.createElement("a")
    a.href = file.data.url
    a.download = `${(image.alt || "Image").replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 60) || "Image"}.${EXT[file.data.mime] ?? "png"}`
    a.click()
  }
  const label = image.alt || "Image"

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <div className="min-w-0 flex-1 [&>[data-slot=sheet-title]]:truncate">
          <SheetTitle>{label}</SheetTitle>
          <SheetDescription>{images.length > 1 ? `${at + 1} of ${images.length}` : image.alt ? "Image in this note" : "This image has no description yet"}</SheetDescription>
        </div>
        <Button variant="ghost" size="sm" aria-pressed={actual} onClick={() => setActualFor(actual ? null : image.id)} disabled={!file.data}>
          {actual ? "Fit to screen" : "Actual size"}
        </Button>
        {/* The desktop and phone apps can't download from the page; the web can. */}
        {!isTauri() && <IconButton icon="download" label="Save image" variant="ghost" onClick={save} disabled={!file.data} />}
        <IconButton icon="close" label="Close" variant="ghost" onClick={() => useImageViewer.getState().close()} />
      </div>
      <div
        className={cn("relative flex min-h-0 flex-1 bg-muted", actual ? "overflow-auto" : "items-center justify-center overflow-hidden p-4")}
        onTouchStart={(e) => setTouch(e.touches[0]?.clientX ?? null)}
        onTouchEnd={(e) => {
          const end = e.changedTouches[0]?.clientX
          if (touch !== null && end !== undefined && Math.abs(end - touch) > 60 && images.length > 1) go(at + (end < touch ? 1 : -1))
          setTouch(null)
        }}
      >
        {file.isPending ? (
          <Spinner />
        ) : file.data ? (
          <img
            src={file.data.url}
            alt={image.alt}
            draggable={false}
            data-role="viewer-image"
            className={cn(actual ? "m-auto max-w-none" : "max-h-full max-w-full object-contain", file.data.mime === SVG_MIME && "bg-(--c-sketch-paper)")}
          />
        ) : (
          <p className="m-auto text-sm text-muted-foreground">{file.error instanceof Error ? file.error.message : "This image isn't on this device yet"}</p>
        )}
        {images.length > 1 && (
          <>
            <span className="absolute top-1/2 left-2 -translate-y-1/2">
              <IconButton icon="chevron_left" label="Previous image" variant="secondary" onClick={() => go(at - 1)} />
            </span>
            <span className="absolute top-1/2 right-2 -translate-y-1/2">
              <IconButton icon="chevron_right" label="Next image" variant="secondary" onClick={() => go(at + 1)} />
            </span>
          </>
        )}
      </div>
    </div>
  )
}
