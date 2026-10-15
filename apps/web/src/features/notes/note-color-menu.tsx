import { Icon } from "@/components/icon"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { NOTE_COLORS, type NoteColor } from "@/core/types"
import { cn } from "@/lib/utils"

import { NOTE_COLOR_LABEL, noteEdge, noteFill } from "./note-color"

/** Keep's swatch row: tap a color, or the crossed-out one for none. */
export function NoteColorMenu({ value, onChange }: { value: NoteColor | null; onChange: (c: NoteColor | null) => void }) {
  const label = value ? `Color: ${NOTE_COLOR_LABEL[value]}` : "Color"
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger render={<DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={label} />} />}>
          <Icon name="palette" className="size-5" />
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-auto p-2">
        <DropdownMenuRadioGroup
          aria-label="Note color"
          value={value ?? "none"}
          onValueChange={(v: string) => onChange(v === "none" ? null : (v as NoteColor))}
          className="grid grid-cols-6 gap-1.5"
        >
          {(["none", ...NOTE_COLORS] as const).map((c) => (
            <DropdownMenuRadioItem
              key={c}
              value={c}
              closeOnClick
              aria-label={c === "none" ? "No color" : NOTE_COLOR_LABEL[c]}
              title={c === "none" ? "No color" : NOTE_COLOR_LABEL[c]}
              // The swatch is the whole item; the menu's own check sits in its middle.
              className={cn(
                "size-8 justify-center rounded-full border p-0 pr-0 ring-offset-2 ring-offset-popover focus:bg-transparent focus:ring-2 focus:ring-ring",
                "data-checked:ring-2 data-checked:ring-foreground [&_[data-slot=dropdown-menu-radio-item-indicator]]:inset-0"
              )}
              style={{ background: c === "none" ? undefined : noteFill(c), borderColor: c === "none" ? undefined : noteEdge(c) }}
            >
              {c === "none" && <Icon name="format_color_reset" className="size-4 text-muted-foreground in-data-checked:hidden" />}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
