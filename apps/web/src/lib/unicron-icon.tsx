import type { CSSProperties } from "react"

import type { IconProps } from "@unicron/ui"

import { cn } from "@/lib/utils"

import CODEPOINTS from "./material-symbols-codepoints.json"

/**
 * unicron's Icon, drawing each symbol by its character instead of its
 * ligature (ADR-0073). The Mac app's web engine (WebKit) doesn't shape
 * ligatures in SVG text, so "inbox" stayed a word there and the icons came out
 * blank. vite.config.ts swaps this in for unicron's own icon module, so the
 * system's components use it too. Same props, same svg wrapper, same axes.
 */
const TONES = {
  muted: "text-muted-foreground",
  destructive: "text-destructive",
} as const

const glyph = (name: string) => {
  const cp = (CODEPOINTS as Record<string, number>)[name]
  return cp ? String.fromCodePoint(cp) : name
}

export function Icon({ name, fill, weight, grade, opticalSize, label, tone, className, style, ...props }: IconProps) {
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
      width="1.25em"
      height="1.25em"
      fill="currentColor"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("shrink-0 select-none", tone && TONES[tone], className)}
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
          fontVariationSettings: "'FILL' var(--c-icon-fill), 'wght' var(--c-icon-wght), 'GRAD' var(--c-icon-grad), 'opsz' var(--c-icon-opsz)",
          transition: "--c-icon-fill var(--g-duration-base) var(--g-ease-standard), --c-icon-wght var(--g-duration-base) var(--g-ease-standard)",
        }}
      >
        {glyph(name)}
      </text>
    </svg>
  )
}
