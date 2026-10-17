import { type KeyboardEvent, type PointerEvent, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import { Button, Icon, IconButton } from "@unicron/ui"
import { useNoteGraph } from "@/core/queries"
import type { NoteGraph, NoteLinkKind, NoteQuery, NoteSummary } from "@/core/types"
import { cn } from "@/lib/utils"

import { bounds, layout, nearestInDirection, type Pt } from "./graph-layout"
import { NOTE_COLOR_LABEL, noteFill } from "./note-color"
import { LINK_ICON, useOpenLink } from "./use-open-link"

/** The map of notes (ADR-0053): notes, the `[[links]]` between them, and the
 * events, people, and conversations they link to. It shows the notes the
 * list would (search, tag, and folder apply), lays them out once, and holds
 * still. Pan, zoom, and drag to rearrange; a tap opens what it lands on. */

type Kind = "note" | NoteLinkKind
interface GNode {
  id: string
  kind: Kind
  label: string
  note?: NoteSummary
  /** An item's id on this device; `null` when it isn't here. */
  target?: string | null
}

const HUE: Record<NoteLinkKind, string> = {
  event: "var(--vertical-calendar)",
  contact: "var(--vertical-contacts)",
  thread: "var(--vertical-mail)",
}
const KIND_NAME: Record<NoteLinkKind, [string, string]> = {
  event: ["Event", "Events"],
  contact: ["Person", "People"],
  thread: ["Conversation", "Conversations"],
}
const ITEM_KINDS: NoteLinkKind[] = ["event", "contact", "thread"]
const MIN_ZOOM = 0.2
const MAX_ZOOM = 3

const short = (s: string) => (s.length > 28 ? `${s.slice(0, 27).trimEnd()}…` : s)

export function NoteGraphView({ query, selectedId, onOpenNote }: { query: NoteQuery; selectedId: string | null; onOpenNote: (id: string) => void }) {
  const { data, isPending } = useNoteGraph(query, true)
  const openLink = useOpenLink()
  const [hidden, setHidden] = useState<Set<NoteLinkKind>>(new Set())
  const [unlinked, setUnlinked] = useState(true)
  const { nodes, edges, counts } = useMemo(() => build(data, hidden, unlinked), [data, hidden, unlinked])

  // Positions survive refetches and filter changes, so the map only nudges.
  const placed = useRef(new Map<string, Pt>())
  // Nodes you've dragged stay where you left them; the next layout starts from there too.
  const [moved, setMoved] = useState(new Map<string, Pt>())
  const base = useMemo(() => {
    const index = new Map(nodes.map((n, i) => [n.id, i]))
    return layout(
      nodes.map((n) => n.id),
      edges.map(([a, b]) => [index.get(a)!, index.get(b)!] as [number, number]),
      new Map([...placed.current, ...moved]),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a drag moves one node; it doesn't lay the map out again
  }, [nodes, edges])
  const pos = useMemo(() => {
    if (!moved.size) return base
    const out = new Map(base)
    for (const [id, p] of moved) if (out.has(id)) out.set(id, p)
    return out
  }, [base, moved])
  useEffect(() => {
    for (const [id, p] of pos) placed.current.set(id, p)
  }, [pos])

  const neighbors = useMemo(() => {
    const m = new Map<string, Set<string>>(nodes.map((n) => [n.id, new Set()]))
    for (const [a, b] of edges) {
      m.get(a)!.add(b)
      m.get(b)!.add(a)
    }
    return m
  }, [nodes, edges])

  // The view: screen = map × k + (x, y). Fits itself until you pan or zoom.
  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [view, setView] = useState({ x: 0, y: 0, k: 1 })
  const steered = useRef(false)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setSize({ w: e!.contentRect.width, h: e!.contentRect.height }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const fit = () => {
    if (!size.w || !size.h) return
    const b = bounds(pos.values(), 60)
    const k = Math.min(Math.max(Math.min(size.w / (b.x1 - b.x0), size.h / (b.y1 - b.y0)), MIN_ZOOM), 1.4)
    setView({
      k,
      x: size.w / 2 - ((b.x0 + b.x1) / 2) * k,
      y: size.h / 2 - ((b.y0 + b.y1) / 2) * k,
    })
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- refit on new data or size, unless steered
  useEffect(() => void (!steered.current && fit()), [base, size.w, size.h])
  const zoomBy = (f: number, cx = size.w / 2, cy = size.h / 2) => {
    steered.current = true
    setView((v) => {
      const k = Math.min(Math.max(v.k * f, MIN_ZOOM), MAX_ZOOM)
      return {
        k,
        x: cx - ((cx - v.x) * k) / v.k,
        y: cy - ((cy - v.y) * k) / v.k,
      }
    })
  }
  const refit = () => {
    steered.current = false
    fit()
  }

  // Wheel and trackpad pinch zoom around the pointer; React's wheel events are passive, so this one isn't.
  useEffect(() => {
    const el = box.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top)
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  })

  // Pointers: drag the background to pan, two fingers to zoom, a node to move it. A tap opens.
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const grab = useRef<{
    id: string | null
    x: number
    y: number
    travel: number
    pinch?: number
  } | null>(null)
  const down = (e: PointerEvent<SVGSVGElement>) => {
    const id = (e.target as Element).closest("[data-node]")?.getAttribute("data-node") ?? null
    e.currentTarget.setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      grab.current = {
        id: null,
        x: 0,
        y: 0,
        travel: 99,
        pinch: Math.hypot(a!.x - b!.x, a!.y - b!.y),
      }
    } else grab.current = { id, x: e.clientX, y: e.clientY, travel: 0 }
  }
  const move = (e: PointerEvent<SVGSVGElement>) => {
    const g = grab.current
    if (!g || !pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (g.pinch && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      const d = Math.hypot(a!.x - b!.x, a!.y - b!.y)
      const r = box.current!.getBoundingClientRect()
      zoomBy(d / g.pinch, (a!.x + b!.x) / 2 - r.left, (a!.y + b!.y) / 2 - r.top)
      g.pinch = d
      return
    }
    const dx = e.clientX - g.x
    const dy = e.clientY - g.y
    g.travel += Math.abs(dx) + Math.abs(dy)
    g.x = e.clientX
    g.y = e.clientY
    if (g.travel < 5) return
    if (g.id) {
      const p = pos.get(g.id)
      if (p) setMoved((m) => new Map(m).set(g.id!, { x: p.x + dx / view.k, y: p.y + dy / view.k }))
    } else {
      steered.current = true
      setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }))
    }
  }
  const up = (e: PointerEvent<SVGSVGElement>) => {
    const g = grab.current
    pointers.current.delete(e.pointerId)
    if (pointers.current.size === 0) grab.current = null
    if (g && !g.pinch && g.id && g.travel < 5) activate(g.id)
  }

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])
  const activate = (id: string) => {
    const n = byId.get(id)
    if (!n) return
    setActive(id)
    if (n.kind === "note") onOpenNote(id)
    else if (n.target) void openLink(n.kind, n.target)
    else toast(`${n.label} isn't on this device`)
  }

  // Keyboard: one node takes Tab; arrows walk to the nearest node that way (linked ones first).
  const [active, setActive] = useState<string | null>(null)
  const [focusVisible, setFocusVisible] = useState(false)
  const [hover, setHover] = useState<string | null>(null)
  const nodeEls = useRef(new Map<string, SVGGElement>())
  const tabStop = active && byId.has(active) ? active : selectedId && byId.has(selectedId) ? selectedId : nodes[0]?.id
  const keyDown = (e: KeyboardEvent<SVGGElement>, id: string) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      activate(id)
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault()
      const from = pos.get(id)!
      const near = (ids: Iterable<string>) =>
        nearestInDirection(
          from,
          e.key as "ArrowUp",
          [...ids].filter((o) => o !== id).map((o) => [o, pos.get(o)!] as [string, Pt]),
        )
      const next = near(neighbors.get(id) ?? []) ?? near(pos.keys())
      if (next) {
        setActive(next)
        nodeEls.current.get(next)?.focus()
        keepInView(next)
      }
    } else if (e.key === "+" || e.key === "=") zoomBy(1.25)
    else if (e.key === "-") zoomBy(0.8)
    else if (e.key === "0") refit()
  }
  const keepInView = (id: string) => {
    const p = pos.get(id)
    if (!p) return
    const sx = p.x * view.k + view.x
    const sy = p.y * view.k + view.y
    if (sx < 40 || sy < 40 || sx > size.w - 40 || sy > size.h - 40) {
      steered.current = true
      setView((v) => ({
        ...v,
        x: size.w / 2 - p.x * v.k,
        y: size.h / 2 - p.y * v.k,
      }))
    }
  }

  // What's lit: the hovered or focused node and its neighbors; the rest fades.
  const lit = hover ?? (focusVisible ? active : null)
  const litSet = lit ? new Set([lit, ...(neighbors.get(lit) ?? [])]) : null
  const scale = Math.min(Math.max(view.k, 0.6), 1.4)
  const showAllLabels = view.k >= 0.75 || nodes.length <= 40
  const at = (id: string) => {
    const p = pos.get(id) ?? { x: 0, y: 0 }
    return { x: p.x * view.k + view.x, y: p.y * view.k + view.y }
  }
  const radius = (n: GNode) => (n.kind === "note" ? 7 + 1.8 * Math.sqrt(neighbors.get(n.id)?.size ?? 0) : 12) * scale

  const noteCount = nodes.filter((n) => n.kind === "note").length
  const summary = `${noteCount} ${noteCount === 1 ? "note" : "notes"} and ${nodes.length - noteCount} linked ${nodes.length - noteCount === 1 ? "item" : "items"}, with ${edges.length} ${edges.length === 1 ? "connection" : "connections"}.`

  return (
    <div ref={box} data-slot="note-graph" className="relative h-full min-h-80 touch-none overflow-hidden select-none">
      <div className="absolute top-0 left-0 z-10 flex max-w-full gap-1.5 overflow-x-auto px-4 pb-2" role="group" aria-label="Show on the map">
        {ITEM_KINDS.filter((k) => counts[k] > 0).map((k) => (
          <Button
            key={k}
            size="xs"
            shape="pill"
            variant={hidden.has(k) ? "ghost" : "secondary"}
            aria-pressed={!hidden.has(k)}
            onClick={() => setHidden((h) => (h.has(k) ? new Set([...h].filter((x) => x !== k)) : new Set([...h, k])))}
          >
            {/* The kind's hue, so the chips read as the map's legend. */}
            <span className="contents" style={{ color: HUE[k] }}>
              <Icon name={LINK_ICON[k]} />
            </span>
            {KIND_NAME[k][1]} {counts[k]}
          </Button>
        ))}
        {counts.unlinked > 0 && (
          <Button size="xs" shape="pill" variant={unlinked ? "secondary" : "ghost"} aria-pressed={unlinked} onClick={() => setUnlinked(!unlinked)}>
            Unlinked notes {counts.unlinked}
          </Button>
        )}
      </div>

      {!isPending && nodes.length === 0 ? (
        <p className="absolute inset-x-0 top-1/3 px-6 text-center text-sm text-muted-foreground">
          {data?.notes.length ? "Nothing to show. Turn on unlinked notes to see the rest." : "No notes to map."}
        </p>
      ) : (
        <svg
          className="block size-full cursor-grab active:cursor-grabbing"
          role="group"
          aria-label="Map of notes"
          aria-describedby="note-graph-summary"
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
        >
          <g aria-hidden>
            {edges.map(([a, b]) => {
              const pa = at(a)
              const pb = at(b)
              const item = byId.get(b)!.kind !== "note" ? (byId.get(b)!.kind as NoteLinkKind) : null
              const on = !litSet || (litSet.has(a) && litSet.has(b) && (a === lit || b === lit))
              return (
                <line
                  key={`${a} ${b}`}
                  x1={pa.x}
                  y1={pa.y}
                  x2={pb.x}
                  y2={pb.y}
                  stroke={item ? HUE[item] : "var(--muted-foreground)"}
                  strokeWidth={litSet && on ? 1.75 : 1.1}
                  strokeDasharray={item ? "3 3" : undefined}
                  strokeOpacity={litSet ? (on ? 0.95 : 0.12) : item ? 0.6 : 0.5}
                />
              )
            })}
          </g>
          {nodes.map((n) => {
            const p = at(n.id)
            const r = radius(n)
            const dim = litSet && !litSet.has(n.id)
            const selected = n.id === selectedId
            const label = n.kind === "note" ? n.label || "New note" : n.label
            const showLabel = showAllLabels || selected || (litSet?.has(n.id) ?? false) || (neighbors.get(n.id)?.size ?? 0) >= 4
            const links = neighbors.get(n.id)?.size ?? 0
            const name =
              n.kind === "note"
                ? `${label}${n.note?.color ? `, ${NOTE_COLOR_LABEL[n.note.color]}` : ""}${n.note?.locked ? ", locked" : ""}, ${links} ${links === 1 ? "link" : "links"}`
                : `${KIND_NAME[n.kind][0]}: ${label}, ${links} ${links === 1 ? "note" : "notes"}${n.target ? "" : ", not on this device"}`
            return (
              <g
                key={n.id}
                ref={(el) => void (el ? nodeEls.current.set(n.id, el) : nodeEls.current.delete(n.id))}
                data-node={n.id}
                data-kind={n.kind}
                role="button"
                tabIndex={n.id === tabStop ? 0 : -1}
                aria-label={name}
                aria-current={selected || undefined}
                className="cursor-pointer outline-none"
                style={{
                  opacity: dim ? 0.25 : 1,
                  transition: "opacity var(--g-duration-base) var(--g-ease-standard)",
                }}
                onPointerEnter={(e) => e.pointerType === "mouse" && setHover(n.id)}
                onPointerLeave={() => setHover((h) => (h === n.id ? null : h))}
                onFocus={(e) => (setActive(n.id), setFocusVisible(e.currentTarget.matches(":focus-visible")))}
                onBlur={() => setFocusVisible(false)}
                onKeyDown={(e) => keyDown(e, n.id)}
              >
                {(selected || (focusVisible && active === n.id)) && (
                  <circle cx={p.x} cy={p.y} r={r + 4} fill="none" stroke={selected ? "var(--foreground)" : "var(--ring)"} strokeWidth={2} />
                )}
                {n.kind === "note" ? (
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={r}
                    fill={n.note?.color ? noteFill(n.note.color) : "var(--vertical-notes)"}
                    stroke={n.note?.color ? `color-mix(in oklab, ${noteFill(n.note.color)} 45%, var(--foreground))` : "var(--surface-chrome)"}
                    strokeWidth={1.5}
                  />
                ) : (
                  <>
                    <circle
                      cx={p.x}
                      cy={p.y}
                      r={r}
                      fill={`color-mix(in oklab, ${HUE[n.kind]} 16%, var(--surface-chrome))`}
                      stroke={HUE[n.kind]}
                      strokeWidth={1.5}
                      strokeDasharray={n.target ? undefined : "2 2"}
                    />
                    <g style={{ color: HUE[n.kind] }}>
                      <Icon name={LINK_ICON[n.kind]} x={p.x - r * 0.65} y={p.y - r * 0.65} width={r * 1.3} height={r * 1.3} />
                    </g>
                  </>
                )}
                {/* A bigger, invisible hit area, so small nodes are easy to tap. */}
                <circle cx={p.x} cy={p.y} r={Math.max(r, 16)} fill="transparent" />
                {showLabel && (
                  <text
                    x={p.x}
                    y={p.y + r + 13}
                    textAnchor="middle"
                    className={cn("text-[11px]", selected || lit === n.id ? "font-semibold" : "font-medium")}
                    fill="var(--foreground)"
                    stroke="var(--surface-chrome)"
                    strokeWidth={3}
                    strokeLinejoin="round"
                    paintOrder="stroke"
                    aria-hidden
                  >
                    {short(label)}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
      )}

      <p id="note-graph-summary" className="sr-only">
        {summary} Use the arrow keys to move between them, Enter to open one, and plus or minus to zoom.
      </p>
      <div className="absolute bottom-3 left-3 z-10 flex flex-col gap-1 rounded-full border bg-background/80 p-1 shadow-sm backdrop-blur">
        <IconButton label="Zoom in" icon="add" size="icon-sm" shortcut="+" onClick={() => zoomBy(1.25)} />
        <IconButton label="Zoom out" icon="remove" size="icon-sm" shortcut="−" onClick={() => zoomBy(0.8)} />
        <IconButton label="Fit the map" icon="fit_screen" size="icon-sm" shortcut="0" onClick={refit} />
      </div>
    </div>
  )
}

/** Nodes and edges to draw: notes first (in list order), then what they link to. */
function build(g: NoteGraph | undefined, hidden: Set<NoteLinkKind>, unlinked: boolean) {
  const counts = { event: 0, contact: 0, thread: 0, unlinked: 0 }
  if (!g) return { nodes: [] as GNode[], edges: [] as [string, string][], counts }
  const edges: [string, string][] = g.links.map((l) => [l.from, l.to])
  const items: GNode[] = []
  for (const i of g.items) {
    counts[i.kind]++
    if (hidden.has(i.kind)) continue
    const id = `${i.kind}:${i.key}`
    items.push({ id, kind: i.kind, label: i.label, target: i.target ?? null })
    for (const n of i.notes) edges.push([n, id])
  }
  const linked = new Set(edges.flat())
  const notes: GNode[] = []
  for (const n of g.notes) {
    if (!linked.has(n.id)) {
      counts.unlinked++
      if (!unlinked) continue
    }
    notes.push({ id: n.id, kind: "note", label: n.title, note: n })
  }
  return { nodes: [...notes, ...items], edges, counts }
}
