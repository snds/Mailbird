import type { CSSProperties, SVGProps } from "react"
import type { MaterialSymbol } from "material-symbols"

import { cn } from "@/lib/utils"

export type IconName = MaterialSymbol

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name" | "fill"> {
  /** Material Symbols ligature name, e.g. "inbox", "calendar_month". */
  name: IconName
  /** FILL axis. Booleans map to 0/1; omit to inherit --c-icon-fill. */
  fill?: boolean | number
  /** wght axis, 100–700. Omit to inherit --c-icon-wght. */
  weight?: number
  /** GRAD axis, -25–200. Omit to inherit --c-icon-grad. */
  grade?: number
  /** opsz axis, 20–48. Match the rendered px size for best stroke balance. */
  opticalSize?: number
  /** Accessible name. Without it the icon is decorative (aria-hidden). */
  label?: string
}

/**
 * Material Symbols, rendered as the glyph inside an <svg>.
 *
 * Why an <svg> wrapper instead of a <span class="material-symbols-rounded">:
 * every shadcn component styles its icons through `svg` selectors
 * (`[&_svg:not([class*='size-'])]:size-4`, `has-[>svg]:…`). Wrapping the
 * ligature in an svg keeps that whole contract working unchanged, while the
 * variable-font axes (fill, weight, grade, optical size) stay live and
 * animatable through CSS custom properties.
 */
export function Icon({
  name,
  fill,
  weight,
  grade,
  opticalSize,
  label,
  className,
  style,
  ...props
}: IconProps) {
  // Props become local overrides of the tier-3 icon tokens, so a parent can
  // still drive the axes (e.g. nav item active → --c-icon-fill: 1).
  const axes = {
    ...(fill !== undefined && { "--c-icon-fill": Number(fill) }),
    ...(weight !== undefined && { "--c-icon-wght": weight }),
    ...(grade !== undefined && { "--c-icon-grad": grade }),
    ...(opticalSize !== undefined && { "--c-icon-opsz": opticalSize }),
  } as CSSProperties

  return (
    <svg
      data-slot="icon"
      viewBox="0 0 24 24"
      // Presentation attributes lose to any CSS size class, so shadcn's
      // size-* rules and caller classNames still win.
      width="1.25em"
      height="1.25em"
      fill="currentColor"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("shrink-0 select-none", className)}
      style={{ ...axes, ...style }}
      {...props}
    >
      <text
        x="12"
        y="12"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize="24"
        style={{
          fontFamily: '"Material Symbols Rounded"',
          fontFeatureSettings: '"liga"',
          fontVariationSettings:
            "'FILL' var(--c-icon-fill), 'wght' var(--c-icon-wght), 'GRAD' var(--c-icon-grad), 'opsz' var(--c-icon-opsz)",
          transition:
            "--c-icon-fill var(--g-duration-base) var(--g-ease-standard), --c-icon-wght var(--g-duration-base) var(--g-ease-standard)",
        }}
      >
        {name}
      </text>
    </svg>
  )
}
