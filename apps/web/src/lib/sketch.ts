import { getStroke } from "perfect-freehand"

/**
 * A sketch (ADR-0046): strokes as points with pen pressure, drawn as
 * filled outlines (perfect-freehand) and saved as SVG. The SVG carries its
 * strokes as JSON in `<metadata>`, so it can be edited again; any app
 * that shows SVG shows the drawing.
 */

export type Tool = "pen" | "marker"
export interface Stroke {
  tool: Tool
  /** A hex color: the sketch's own content, so it's stored as a value, not a token. */
  color: string
  size: number
  /** x, y in the sketch's units; pressure 0–1. */
  points: [number, number, number][]
  /** Pressure came from a pen; otherwise it's simulated from speed. */
  pressure: boolean
}
export interface Sketch {
  v: 1
  w: number
  h: number
  strokes: Stroke[]
}

export const SKETCH_W = 1000
export const SKETCH_H = 700
export const MAX_H = 2800
export const SVG_MIME = "image/svg+xml"

/** Ink first. The marker's are see-through, so text under them stays readable. */
export const PEN_COLORS = [
  { name: "Ink", value: "#1c1b1f" },
  { name: "Red", value: "#d93a2b" },
  { name: "Blue", value: "#2563eb" },
  { name: "Green", value: "#15803d" },
] as const
export const MARKER_COLORS = [
  { name: "Yellow", value: "#facc15" },
  { name: "Pink", value: "#f472b6" },
  { name: "Green", value: "#4ade80" },
] as const
export const SIZES = [
  { name: "Fine", pen: 4, marker: 18 },
  { name: "Medium", pen: 8, marker: 30 },
  { name: "Bold", pen: 14, marker: 44 },
] as const
const MARKER_OPACITY = 0.38

const r1 = (n: number) => Math.round(n * 10) / 10

/** A stroke's filled outline as SVG path data. */
export function strokePath(s: Stroke): string {
  const outline = getStroke(s.points, {
    size: s.size,
    thinning: s.tool === "pen" ? 0.6 : 0,
    smoothing: 0.5,
    streamline: 0.45,
    simulatePressure: s.tool === "pen" && !s.pressure,
    last: true,
  })
  if (!outline.length) return ""
  const [first, ...rest] = outline
  return `M${r1(first![0])} ${r1(first![1])}${rest.map(([x, y]) => `L${r1(x!)} ${r1(y!)}`).join("")}Z`
}

export const strokeStyle = (s: Stroke) => ({ fill: s.color, opacity: s.tool === "marker" ? MARKER_OPACITY : 1 })

/** The SVG the store keeps. Only what its sketch check allows: svg, metadata, path. */
export function toSvg(sketch: Sketch): string {
  // JSON can't hold `<` or `&` here: the store refuses markup and entities in a sketch.
  const meta = JSON.stringify({ ...sketch, strokes: sketch.strokes.map((s) => ({ ...s, points: s.points.map(([x, y, p]) => [r1(x), r1(y), Math.round(p * 100) / 100]) })) })
    .replace(/</g, "\\u003c")
    .replace(/&/g, "\\u0026")
  const paths = sketch.strokes
    .map((s) => {
      const d = strokePath(s)
      if (!d) return ""
      const { fill, opacity } = strokeStyle(s)
      return `<path d="${d}" fill="${fill}"${opacity < 1 ? ` opacity="${opacity}"` : ""}/>`
    })
    .join("")
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${sketch.w} ${sketch.h}" width="${sketch.w}" height="${sketch.h}"><metadata id="mailbird-sketch">${meta}</metadata>${paths}</svg>`
}

/** A saved sketch's strokes, to edit again; null when the SVG has none of ours. */
export function fromSvg(svg: string): Sketch | null {
  const m = /<metadata id="mailbird-sketch">([\s\S]*?)<\/metadata>/.exec(svg)
  if (!m) return null
  try {
    const s = JSON.parse(m[1]!) as Sketch
    return s.v === 1 && Array.isArray(s.strokes) ? s : null
  } catch {
    return null
  }
}

/** Strokes within `r` of a point: what the eraser touches. */
export function hits(s: Stroke, x: number, y: number, r: number): boolean {
  const reach = r + s.size / 2
  return s.points.some(([px, py]) => (px - x) ** 2 + (py - y) ** 2 <= reach * reach)
}

/** A sketch as a raster, white behind it: for reading its text. */
export async function rasterize(svg: Blob): Promise<Blob> {
  const url = URL.createObjectURL(svg)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const c = document.createElement("canvas")
    c.width = img.naturalWidth || SKETCH_W
    c.height = img.naturalHeight || SKETCH_H
    const g = c.getContext("2d")!
    g.fillStyle = "#fff"
    g.fillRect(0, 0, c.width, c.height)
    g.drawImage(img, 0, 0, c.width, c.height)
    return await new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("couldn't draw the sketch"))), "image/png"))
  } finally {
    URL.revokeObjectURL(url)
  }
}
