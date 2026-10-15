import type { NoteColor } from "@/core/types"

export const NOTE_COLOR_LABEL: Record<NoteColor, string> = {
  red: "Red",
  orange: "Orange",
  yellow: "Yellow",
  green: "Green",
  teal: "Teal",
  blue: "Blue",
  purple: "Purple",
  pink: "Pink",
  brown: "Brown",
  gray: "Gray",
}

/** The card fill for a color, from the tokens (ADR-0038); plain cards use the card surface. */
export const noteFill = (c: NoteColor | null | undefined) => `var(--c-note-card-${c ?? "plain"})`

/** The card's edge: its own fill, a little toward the text color, so it holds on any background. */
export const noteEdge = (c: NoteColor | null | undefined) => (c ? `color-mix(in oklab, ${noteFill(c)} 82%, var(--foreground))` : undefined)
