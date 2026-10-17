import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { Icon, Button, AdaptiveSheetContent, Sheet, SheetDescription, SheetTitle, ToggleGroup, ToggleGroupItem } from "@unicron/ui"
import { findPage, FULL, loadPhoto, type Pt, type Quad, type ScanLook, straighten, toJpeg } from "@/lib/scan"
import { IMAGE_SIDE } from "@/lib/image"

const CORNERS = ["Top-left corner", "Top-right corner", "Bottom-right corner", "Bottom-left corner"] as const
const PREVIEW_SIDE = 1200
const clamp = (v: number) => Math.min(1, Math.max(0, v))

/**
 * Scan a page into a note (ADR-0045): take a photo (or pick one), set the
 * page's corners, choose how it looks, and add it. The text in it is read
 * on this device afterwards, like any image's.
 */
export function ScanSheet({ open, onOpenChange, onScanned }: { open: boolean; onOpenChange: (o: boolean) => void; onScanned: (scan: File) => void }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <AdaptiveSheetContent wide className="flex flex-col gap-3 px-5 pb-5 sm:pt-5">
        {open && <Scanner onDone={(f) => (onScanned(f), onOpenChange(false))} />}
      </AdaptiveSheetContent>
    </Sheet>
  )
}

function Scanner({ onDone }: { onDone: (f: File) => void }) {
  const [photo, setPhoto] = useState<HTMLCanvasElement | null>(null)
  const [quad, setQuad] = useState<Quad>(FULL)
  const [step, setStep] = useState<"pick" | "corners" | "look">("pick")
  const [look, setLook] = useState<ScanLook>("document")
  const [busy, setBusy] = useState(false)

  const pick = async (f: File | undefined) => {
    if (!f) return
    try {
      const c = await loadPhoto(f)
      setPhoto(c)
      setQuad(findPage(c))
      setStep("corners")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }
  const add = async () => {
    if (!photo) return
    setBusy(true)
    try {
      const blob = await toJpeg(straighten(photo, quad, IMAGE_SIDE, look))
      onDone(new File([blob], "Scan.jpg", { type: "image/jpeg" }))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <>
      <div className="flex flex-col gap-1">
        <SheetTitle>Scan a document</SheetTitle>
        <SheetDescription>
          {step === "pick" && "Take a photo of a page, or choose one. The text in it becomes searchable, read on this device."}
          {step === "corners" && "Drag the corners to the page's edges."}
          {step === "look" && "Choose how the page looks."}
        </SheetDescription>
      </div>
      {step === "pick" && <PickPhoto onPick={(f) => void pick(f)} />}
      {step === "corners" && photo && <Corners photo={photo} quad={quad} onChange={setQuad} />}
      {step === "look" && photo && <Preview photo={photo} quad={quad} look={look} onLook={setLook} />}
      {step !== "pick" && (
        <div className="mt-auto flex flex-wrap items-center gap-2 pt-1 max-sm:pr-14">
          <Button type="button" variant="ghost" onClick={() => (step === "look" ? setStep("corners") : (setPhoto(null), setStep("pick")))}>
            {step === "look" ? "Back" : "Retake"}
          </Button>
          {step === "corners" ? (
            <>
              <Button type="button" variant="outline" className="ml-auto" onClick={() => setQuad(FULL)}>
                Whole photo
              </Button>
              <Button type="button" onClick={() => setStep("look")}>
                Next
              </Button>
            </>
          ) : (
            <Button type="button" className="ml-auto" disabled={busy} onClick={() => void add()}>
              <Icon name="add_photo_alternate" data-icon="inline-start" /> Add to note
            </Button>
          )}
        </div>
      )}
    </>
  )
}

function PickPhoto({ onPick }: { onPick: (f: File | undefined) => void }) {
  const tile = "flex flex-1 flex-col items-center gap-2 rounded-xl border p-5 text-sm font-medium hover:bg-muted focus-within:ring-2 focus-within:ring-ring"
  return (
    <div className="flex gap-3">
      {/* On phones, `capture` opens the back camera; elsewhere it's an ordinary file picker. */}
      <label className={tile}>
        <Icon name="photo_camera" className="size-7 text-vertical-notes-text" />
        Take a photo
        <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => onPick(e.target.files?.[0])} />
      </label>
      <label className={tile}>
        <Icon name="image" className="size-7 text-vertical-notes-text" />
        Choose an image
        <input type="file" accept="image/*" className="sr-only" onChange={(e) => onPick(e.target.files?.[0])} />
      </label>
    </div>
  )
}

/** The photo with the page's outline and four corner handles: drag them, or select one and use the arrow keys. */
function Corners({ photo, quad, onChange }: { photo: HTMLCanvasElement; quad: Quad; onChange: (q: Quad) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const [url] = useState(() => photo.toDataURL("image/jpeg", 0.8))
  const drag = useRef<number | null>(null)
  const move = (i: number, p: Pt) => onChange(quad.map((q, k) => (k === i ? { x: clamp(p.x), y: clamp(p.y) } : q)) as Quad)
  const at = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect()
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }
  }
  const points = quad.map((p) => `${p.x * 100},${p.y * 100}`).join(" ")
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center">
      {/* As wide as fits, and never taller than about half the screen, keeping the photo's shape. */}
      <div
        ref={box}
        className="relative touch-none select-none"
        style={{ aspectRatio: `${photo.width} / ${photo.height}`, width: `min(100%, calc(52dvh * ${photo.width / photo.height}))` }}
      >
        <img src={url} alt="The photo to scan" className="block size-full rounded-md" draggable={false} />
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 size-full" aria-hidden>
          <polygon points={points} className="fill-(--c-scan-fill) stroke-(--c-scan-edge)" strokeWidth={0.6} vectorEffect="non-scaling-stroke" />
        </svg>
        {quad.map((p, i) => (
          <button
            key={CORNERS[i]}
            type="button"
            aria-label={`${CORNERS[i]}: ${Math.round(p.x * 100)}% across, ${Math.round(p.y * 100)}% down`}
            className="absolute grid size-11 -translate-1/2 cursor-grab place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
            style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
            onPointerDown={(e) => ((drag.current = i), e.currentTarget.setPointerCapture(e.pointerId))}
            onPointerMove={(e) => drag.current === i && move(i, at(e))}
            onPointerUp={() => (drag.current = null)}
            onKeyDown={(e) => {
              const step = e.shiftKey ? 0.05 : 0.01
              const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key]
              if (!d) return
              e.preventDefault()
              move(i, { x: p.x + d[0]!, y: p.y + d[1]! })
            }}
          >
            <span className="size-5 rounded-full border-2 border-(--c-scan-edge) bg-background shadow" />
          </button>
        ))}
      </div>
    </div>
  )
}

function Preview({ photo, quad, look, onLook }: { photo: HTMLCanvasElement; quad: Quad; look: ScanLook; onLook: (l: ScanLook) => void }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    // Off the click that changed it, so the toggle responds first.
    const t = setTimeout(() => setUrl(straighten(photo, quad, PREVIEW_SIDE, look).toDataURL("image/jpeg", 0.85)), 0)
    return () => clearTimeout(t)
  }, [photo, quad, look])
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center gap-3">
      <ToggleGroup value={[look]} onValueChange={(v) => v[0] && onLook(v[0] as ScanLook)} variant="outline" size="sm" aria-label="Look">
        <ToggleGroupItem value="document">Document</ToggleGroupItem>
        <ToggleGroupItem value="gray">Grayscale</ToggleGroupItem>
        <ToggleGroupItem value="color">Color</ToggleGroupItem>
      </ToggleGroup>
      {url ? (
        <img src={url} alt="The scanned page" className="max-h-[46dvh] max-w-full rounded-md border object-contain" />
      ) : (
        <span className="block aspect-[3/4] h-[46dvh] max-w-full animate-pulse rounded-md bg-muted" aria-hidden />
      )}
    </div>
  )
}
