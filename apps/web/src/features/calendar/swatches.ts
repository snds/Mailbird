import type { CalendarEventProps, NavItemSwatch } from "@unicron/ui"
import type { Collection } from "@/core/types"

/** The OKLCH hue of a `#rrggbb` color, in degrees; null for anything else, and for a grey. */
function hueOf(color: string | null): number | null {
  const m = color && /^#([0-9a-f]{6})$/i.exec(color.trim())
  if (!m) return null
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(m[1]!.slice(i, i + 2), 16) / 255
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

/**
 * Each calendar's swatch, of unicron's twelve (brief 1.3): the one nearest
 * its server color in hue. The swatches stand 30° apart from 25° (red). When
 * two calendars land on one, the later in list order takes the next free
 * one; past twelve they repeat. A calendar with no color gets none.
 */
export function calendarSwatches(calendars: Iterable<Collection>): Map<string, NavItemSwatch> {
  const out = new Map<string, NavItemSwatch>()
  const taken = new Set<number>()
  for (const c of calendars) {
    const hue = hueOf(c.color)
    if (hue === null) continue
    let at = (Math.round((hue - 25) / 30) + 12) % 12
    if (taken.size < 12) while (taken.has(at)) at = (at + 1) % 12
    taken.add(at)
    out.set(c.id, (at + 1) as NavItemSwatch)
  }
  return out
}

/** The same swatch as an event card names it: a nav item counts them 1 to 12, a card "01" to "12". */
export const eventSwatch = (swatch: NavItemSwatch | undefined) => (swatch ? (String(swatch).padStart(2, "0") as NonNullable<CalendarEventProps["swatch"]>) : undefined)
