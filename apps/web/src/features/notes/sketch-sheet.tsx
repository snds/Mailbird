import { useEffect, useRef, useState } from "react"

import { Icon, Button, AdaptiveSheetContent, Sheet, SheetDescription, SheetTitle, ToggleGroup, ToggleGroupItem, Tooltip, TooltipContent, TooltipTrigger } from "@unicron/ui"
import { hits, MARKER_COLORS, MAX_H, PEN_COLORS, SIZES, type Sketch, SKETCH_H, SKETCH_W, type Stroke, strokePath, strokeStyle } from "@/lib/sketch"
import { cn } from "@/lib/utils"

import { useSketchSheet } from "./sketch-store"

type Mode = "pen" | "marker" | "eraser"
const ERASER = 14
const ROOM = 350

const blank = (): Sketch => ({ v: 1, w: SKETCH_W, h: SKETCH_H, strokes: [] })

/**
 * Drawing in a note (ADR-0046), with a mouse, a finger, or a pen (its
 * pressure shapes the line). A bottom sheet on phones, a wide side panel
 * above. Done saves the sketch into the note; editing one replaces it.
 */
export function SketchSheet({ onDone }: { onDone: (sketch: Sketch, pos: number | null) => void }) {
  const state = useSketchSheet((s) => s.open)
  const close = useSketchSheet((s) => s.close)
  return (
    <Sheet open={!!state} onOpenChange={(o) => !o && close()}>
      <AdaptiveSheetContent wide className="flex flex-col gap-3 px-5 pb-5 sm:pt-5">
        {state && <Drawing start={state.sketch ?? blank()} editing={!!state.sketch} onCancel={close} onDone={(s) => (onDone(s, state.pos), close())} />}
      </AdaptiveSheetContent>
    </Sheet>
  )
}

function Drawing({ start, editing, onCancel, onDone }: { start: Sketch; editing: boolean; onCancel: () => void; onDone: (s: Sketch) => void }) {
  const [sketch, setSketch] = useState(start)
  // Undo and redo: whole sketches, so erasing several strokes undoes as one.
  const [past, setPast] = useState<Sketch[]>([])
  const [future, setFuture] = useState<Sketch[]>([])
  const [mode, setMode] = useState<Mode>("pen")
  const [penColor, setPenColor] = useState<string>(PEN_COLORS[0].value)
  const [markerColor, setMarkerColor] = useState<string>(MARKER_COLORS[0].value)
  const [size, setSize] = useState(1)
  // The stroke being drawn: a ref, so every sample lands even when several
  // arrive before React draws again; the state copy is what's on screen.
  const liveRef = useRef<Stroke | null>(null)
  const [live, setLiveState] = useState<Stroke | null>(null)
  const setLive = (s: Stroke | null) => ((liveRef.current = s), setLiveState(s))
  const svg = useRef<SVGSVGElement>(null)
  const erasing = useRef<Sketch | null>(null)

  const commit = (next: Sketch, from = sketch) => {
    setPast((p) => [...p, from].slice(-100))
    setFuture([])
    setSketch(next)
  }
  const undo = () => {
    const prev = past.at(-1)
    if (!prev) return
    setPast((p) => p.slice(0, -1))
    setFuture((f) => [sketch, ...f])
    setSketch(prev)
  }
  const redo = () => {
    const next = future[0]
    if (!next) return
    setFuture((f) => f.slice(1))
    setPast((p) => [...p, sketch])
    setSketch(next)
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  const at = (e: React.PointerEvent): [number, number, number] => {
    const r = svg.current!.getBoundingClientRect()
    const x = ((e.clientX - r.left) / r.width) * sketch.w
    const y = ((e.clientY - r.top) / r.height) * sketch.h
    return [x, y, e.pointerType === "pen" ? e.pressure || 0.5 : 0.5]
  }
  const erase = (e: React.PointerEvent) => {
    const [x, y] = at(e)
    setSketch((s) => ({ ...s, strokes: s.strokes.filter((st) => !hits(st, x, y, ERASER)) }))
  }
  const down = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // Not a live pointer (some synthetic input): drawing still works, just without capture.
    }
    if (mode === "eraser") {
      erasing.current = sketch
      erase(e)
      return
    }
    const marker = mode === "marker"
    setLive({ tool: mode, color: marker ? markerColor : penColor, size: marker ? SIZES[size]!.marker : SIZES[size]!.pen, points: [at(e)], pressure: e.pointerType === "pen" })
  }
  const move = (e: React.PointerEvent) => {
    if (erasing.current) return erase(e)
    const live = liveRef.current
    if (!live) return
    // Coalesced events: every sample the pen made, not just one per frame.
    const samples = e.nativeEvent.getCoalescedEvents?.() ?? []
    const pts = (samples.length ? samples : [e.nativeEvent]).map((ev) => at({ clientX: ev.clientX, clientY: ev.clientY, pointerType: e.pointerType, pressure: ev.pressure } as React.PointerEvent))
    setLive({ ...live, points: [...live.points, ...pts] })
  }
  const up = () => {
    if (erasing.current) {
      const before = erasing.current
      erasing.current = null
      if (before.strokes.length !== sketch.strokes.length) commit(sketch, before)
      return
    }
    const done = liveRef.current
    if (!done) return
    setLive(null)
    commit({ ...sketch, strokes: [...sketch.strokes, done] })
  }

  const colors = mode === "marker" ? MARKER_COLORS : PEN_COLORS
  const color = mode === "marker" ? markerColor : penColor
  const empty = sketch.strokes.length === 0
  return (
    <>
      <div className="flex flex-col gap-1">
        <SheetTitle>{editing ? "Edit sketch" : "Sketch"}</SheetTitle>
        <SheetDescription>Draw with a mouse, a finger, or a pen. A pen's pressure shapes the line.</SheetDescription>
      </div>
      <div role="toolbar" aria-label="Drawing tools" className="flex flex-wrap items-center gap-2">
        <ToggleGroup value={[mode]} onValueChange={(v) => v[0] && setMode(v[0] as Mode)} variant="outline" size="sm" aria-label="Tool">
          <ToggleGroupItem value="pen" aria-label="Pen">
            <Icon name="edit" />
          </ToggleGroupItem>
          <ToggleGroupItem value="marker" aria-label="Marker">
            <Icon name="ink_highlighter" />
          </ToggleGroupItem>
          <ToggleGroupItem value="eraser" aria-label="Eraser">
            <Icon name="ink_eraser" />
          </ToggleGroupItem>
        </ToggleGroup>
        {mode !== "eraser" && (
          <>
            <div role="radiogroup" aria-label="Color" className="flex items-center gap-1">
              {colors.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  role="radio"
                  aria-checked={color === c.value}
                  aria-label={c.name}
                  title={c.name}
                  onClick={() => (mode === "marker" ? setMarkerColor(c.value) : setPenColor(c.value))}
                  className="grid size-8 place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span
                    className={cn("size-5 rounded-full border border-foreground/15 ring-offset-2 ring-offset-popover", color === c.value && "ring-2 ring-foreground")}
                    style={{ background: c.value }}
                  />
                </button>
              ))}
            </div>
            <ToggleGroup value={[String(size)]} onValueChange={(v) => v[0] && setSize(Number(v[0]))} variant="outline" size="sm" aria-label="Thickness">
              {SIZES.map((s, i) => (
                <ToggleGroupItem key={s.name} value={String(i)} aria-label={s.name}>
                  <span className="rounded-full bg-foreground" style={{ width: 4 + i * 4, height: 4 + i * 4 }} />
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </>
        )}
        <span className="ml-auto flex items-center gap-0.5">
          <ToolButton icon="undo" label="Undo" disabled={!past.length} onClick={undo} />
          <ToolButton icon="redo" label="Redo" disabled={!future.length} onClick={redo} />
          <ToolButton icon="delete_sweep" label="Clear" disabled={empty} onClick={() => commit({ ...sketch, strokes: [] })} />
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border bg-(--c-sketch-paper)">
        <svg
          ref={svg}
          role="img"
          aria-label={empty ? "Empty sketch" : `Sketch with ${sketch.strokes.length} ${sketch.strokes.length === 1 ? "stroke" : "strokes"}`}
          viewBox={`0 0 ${sketch.w} ${sketch.h}`}
          className={cn("block w-full touch-none", mode === "eraser" ? "cursor-cell" : "cursor-crosshair")}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
        >
          {[...sketch.strokes, ...(live ? [live] : [])].map((s, i) => (
            <path key={i} d={strokePath(s)} {...strokeStyle(s)} />
          ))}
        </svg>
      </div>
      <div className="flex flex-wrap items-center gap-2 max-sm:pr-14">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" variant="outline" disabled={sketch.h >= MAX_H} onClick={() => setSketch((s) => ({ ...s, h: Math.min(MAX_H, s.h + ROOM) }))}>
          <Icon name="expand" data-icon="inline-start" /> More room
        </Button>
        <Button type="button" className="ml-auto" disabled={empty} onClick={() => onDone(sketch)}>
          {editing ? "Save sketch" : "Add to note"}
        </Button>
      </div>
    </>
  )
}

function ToolButton({ icon, label, disabled, onClick }: { icon: "undo" | "redo" | "delete_sweep"; label: string; disabled: boolean; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label={label} disabled={disabled} onClick={onClick} />}>
        <Icon name={icon} />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
