// Calendar and note colors as unicron's twelve swatches (ADR-0088; brief 1.3).
//
// A swatch shows in three places only: the 2 px bar of a calendar event, an
// 8 px square, and the 4 px top edge of a tile. It never colors text and
// never fills behind text. The helpers below are the only way a color
// reaches the screen, so that rule holds by construction.
//
// Relative imports only, and no runtime import at all: a script can read the
// mapping with `node --experimental-strip-types`.

/** A swatch by its number, as a nav item names it (`<NavItem swatch>`). */
export type SwatchNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12
/** A swatch by its id, as a calendar event and a tile name it, and as the role is called (`--swatch-07`). */
export type SwatchId = "01" | "02" | "03" | "04" | "05" | "06" | "07" | "08" | "09" | "10" | "11" | "12"

/** What unicron calls each swatch, in order. For a color's spoken name and for reading the mapping. */
export const SWATCH_NAMES = ["red", "orange", "ochre", "olive", "green", "jade", "teal", "azure", "blue", "violet", "plum", "rose"] as const

/** The OKLCH hue of swatch 01, in degrees. The twelve stand 30° apart from it, on both grounds (measured from the tokens: 25.1°, 54.8°, 84.6° … 355.1°). */
const FIRST_HUE = 25
const STEP = 30

/** The OKLCH hue of a `#rgb` or `#rrggbb` color, in degrees; null for anything else, and for a grey. */
export function hueOf(color: string | null | undefined): number | null {
  const m = color ? /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim()) : null
  if (!m) return null
  const hex = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join("") : m[1]!
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const mm = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const a = 1.9779984951 * l - 2.428592205 * mm + 0.4505937099 * s
  const bb = 0.0259040371 * l + 0.7827717662 * mm - 0.808675766 * s
  // Next to no chroma: a grey has no hue worth matching.
  if (Math.hypot(a, bb) < 0.02) return null
  return ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360
}

/** The swatch nearest a color in OKLCH hue; null when the color has no hue (none set, a grey, not a hex color). */
export function nearestSwatch(color: string | null | undefined): SwatchNumber | null {
  const hue = hueOf(color)
  if (hue === null) return null
  return ((((Math.round((hue - FIRST_HUE) / STEP) % 12) + 12) % 12) + 1) as SwatchNumber
}

/**
 * Each calendar's swatch. Pass the calendars in sidebar order, hidden ones
 * too (a hidden calendar still shows its square in the list, and hiding one
 * must not recolor the others).
 *
 * - A calendar takes the swatch nearest its server color in hue.
 * - When that one is taken, the later calendar takes the next free swatch.
 * - Past twelve colored calendars every swatch is taken, so they repeat:
 *   each further calendar takes its nearest, shared or not.
 * - A calendar with no color is not in the map: the neutral bar, no square.
 */
export function calendarSwatches(calendars: Iterable<{ id: string; color: string | null }>): Map<string, SwatchNumber> {
  const out = new Map<string, SwatchNumber>()
  const taken = new Set<number>()
  for (const c of calendars) {
    const nearest = nearestSwatch(c.color)
    if (nearest === null) continue
    let at: number = nearest
    if (taken.size < 12) while (taken.has(at)) at = (at % 12) + 1
    taken.add(at)
    out.set(c.id, at as SwatchNumber)
  }
  return out
}

/**
 * The ten note colors, one swatch each. Eight go by name. The set has no
 * brown and no gray, so those two take the nearest free swatch: brown is
 * olive (the earth tone left once orange and ochre are taken) and gray is
 * azure (the cool one left once blue is taken).
 */
export const NOTE_SWATCHES = {
  red: 1,
  orange: 2,
  yellow: 3,
  brown: 4,
  green: 5,
  teal: 7,
  gray: 8,
  blue: 9,
  purple: 10,
  pink: 12,
} as const satisfies Record<string, SwatchNumber>

/** A note color's swatch; null for no color, and for a color a newer device added. */
export function noteSwatch(color: string | null | undefined): SwatchNumber | null {
  return color && Object.hasOwn(NOTE_SWATCHES, color) ? NOTE_SWATCHES[color as keyof typeof NOTE_SWATCHES] : null
}

/** "07" for 7. */
export const swatchId = (swatch: SwatchNumber): SwatchId => String(swatch).padStart(2, "0") as SwatchId

// ── The four places a swatch may show ─────────────────────────────────────

/** The 2 px bar of a calendar event: `<CalendarEvent swatch={eventSwatch(s)}>`. Without a swatch the bar is the neutral rule. */
export const eventSwatch = (swatch: SwatchNumber | null | undefined): SwatchId | undefined => (swatch ? swatchId(swatch) : undefined)

/** The square in a nav item's icon place: `<NavItem swatch={navSwatch(s)}>`. Without a swatch, no square. */
export const navSwatch = (swatch: SwatchNumber | null | undefined): SwatchNumber | undefined => swatch ?? undefined

/** The 4 px top edge of a tile: `<Tile {...tileEdge(s)}>`. Without a swatch the tile has no edge. */
export const tileEdge = (swatch: SwatchNumber | null | undefined): { swatch: SwatchId } | { edge: "none" } => (swatch ? { swatch: swatchId(swatch) } : { edge: "none" })

// Written out in full so Tailwind finds every class.
const FILL: Record<SwatchId, string> = {
  "01": "bg-swatch-01",
  "02": "bg-swatch-02",
  "03": "bg-swatch-03",
  "04": "bg-swatch-04",
  "05": "bg-swatch-05",
  "06": "bg-swatch-06",
  "07": "bg-swatch-07",
  "08": "bg-swatch-08",
  "09": "bg-swatch-09",
  "10": "bg-swatch-10",
  "11": "bg-swatch-11",
  "12": "bg-swatch-12",
}

/**
 * The 8 px square: the classes of an empty, `aria-hidden` span beside the
 * name it belongs to. Null without a swatch: no square at all.
 */
export const swatchSquare = (swatch: SwatchNumber | null | undefined): string | null => (swatch ? `inline-block size-2 shrink-0 ${FILL[swatchId(swatch)]}` : null)
