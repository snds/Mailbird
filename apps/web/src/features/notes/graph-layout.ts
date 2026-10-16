/** A settled force layout for the notes map (ADR-0053).
 *
 * Deterministic: the same nodes and links always land in the same places, so
 * the map doesn't reshuffle between visits, and tests can rely on it. Nodes
 * the last layout placed start where they were, so an edit nudges the map
 * instead of redrawing it. It runs once per change and then holds still: the
 * map is for reading, not for watching things drift. */

export interface Pt {
  x: number
  y: number
}

/** How far apart linked nodes like to sit, in map units. */
const SPACING = 70
/** The pull toward the middle: enough to keep separate clusters close, not so much that they overlap. */
const GRAVITY = 0.15

/** Places `ids`, joined by `edges` (index pairs). `from` holds positions to start from. */
export function layout(ids: string[], edges: [number, number][], from: Map<string, Pt> = new Map()): Map<string, Pt> {
  const n = ids.length
  const out = new Map<string, Pt>()
  if (n === 0) return out
  const xs = new Float64Array(n)
  const ys = new Float64Array(n)
  let fresh = 0
  // New nodes start on a sunflower spiral: even spacing, no randomness.
  ids.forEach((id, i) => {
    const p = from.get(id)
    if (p) {
      xs[i] = p.x
      ys[i] = p.y
    } else {
      const r = SPACING * 0.6 * Math.sqrt(i + 0.5)
      const a = i * 2.39996323 // the golden angle
      xs[i] = r * Math.cos(a)
      ys[i] = r * Math.sin(a)
      fresh++
    }
  })
  const degree = new Uint16Array(n)
  for (const [a, b] of edges) {
    degree[a]++
    degree[b]++
  }
  // A small edit settles in a few steps; a new map takes the full run. Big maps take fewer (each step is n²).
  const full = n > 600 ? 120 : 260
  const steps = fresh === 0 ? 40 : fresh < n / 4 ? 90 : full
  const k = SPACING
  const dx = new Float64Array(n)
  const dy = new Float64Array(n)
  for (let step = 0; step < steps; step++) {
    // Cooling: big moves first, then small ones.
    const t = SPACING * (fresh === n ? 1.2 : 0.4) * (1 - step / steps) + 0.5
    dx.fill(0)
    dy.fill(0)
    // Every pair pushes apart (k²/d).
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let ex = xs[i]! - xs[j]!
        let ey = ys[i]! - ys[j]!
        let d2 = ex * ex + ey * ey
        if (d2 < 0.01) {
          // Two nodes on the same spot: part them the same way every time.
          ex = 0.1 * ((i % 7) - 3) || 0.1
          ey = 0.1
          d2 = ex * ex + ey * ey
        }
        if (d2 > 9 * k * k) continue // far apart: too weak to matter
        const f = (k * k) / d2
        dx[i] += ex * f
        dy[i] += ey * f
        dx[j] -= ex * f
        dy[j] -= ey * f
      }
    }
    // Links pull together (d²/k), split by degree so a hub isn't yanked by every leaf.
    for (const [a, b] of edges) {
      const ex = xs[a]! - xs[b]!
      const ey = ys[a]! - ys[b]!
      const d = Math.sqrt(ex * ex + ey * ey) || 0.01
      const f = d / k
      const wa = 1 / Math.max(1, degree[a]! / 3)
      const wb = 1 / Math.max(1, degree[b]! / 3)
      dx[a] -= ex * f * wa
      dy[a] -= ey * f * wa
      dx[b] += ex * f * wb
      dy[b] += ey * f * wb
    }
    // A light pull to the middle keeps unlinked notes and separate clusters in view.
    for (let i = 0; i < n; i++) {
      dx[i] -= xs[i]! * GRAVITY
      dy[i] -= ys[i]! * GRAVITY
      const len = Math.sqrt(dx[i]! * dx[i]! + dy[i]! * dy[i]!)
      if (len > 0) {
        const m = Math.min(len, t) / len
        xs[i] += dx[i]! * m
        ys[i] += dy[i]! * m
      }
    }
  }
  ids.forEach((id, i) =>
    out.set(id, {
      x: Math.round(xs[i]! * 10) / 10,
      y: Math.round(ys[i]! * 10) / 10,
    }),
  )
  return out
}

/** The box around `pts`, padded by `pad`. */
export function bounds(pts: Iterable<Pt>, pad = 40) {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const p of pts) {
    x0 = Math.min(x0, p.x)
    y0 = Math.min(y0, p.y)
    x1 = Math.max(x1, p.x)
    y1 = Math.max(y1, p.y)
  }
  if (x0 === Infinity) return { x0: -pad, y0: -pad, x1: pad, y1: pad }
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad }
}

/** The node nearest `from` in an arrow key's direction, within a 90° cone; `null` when there's none. */
export function nearestInDirection(from: Pt, key: "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight", candidates: [string, Pt][]): string | null {
  const [ux, uy] = {
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
  }[key]
  let best: string | null = null
  let score = Infinity
  for (const [id, p] of candidates) {
    const ex = p.x - from.x
    const ey = p.y - from.y
    const along = ex * ux! + ey * uy!
    const across = Math.abs(ex * uy! - ey * ux!)
    if (along <= 0 || across > along) continue
    // Straight ahead beats off to the side at the same distance.
    const s = along + across * 2
    if (s < score) {
      score = s
      best = id
    }
  }
  return best
}
