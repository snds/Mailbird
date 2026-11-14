import { useTheme } from "next-themes"

import { FieldRow, FilterChip, FilterChipGroup, Tooltip, TooltipContent, TooltipTrigger, useViewport } from "@unicron/ui"

/**
 * The three choices, in the order shown (ADR-0082). The values are the ones
 * next-themes stores: `light` is the Stone ground, `dark` is Graphite, and
 * `system` follows the device. Light and dark are said only in the tooltips.
 */
const THEMES = [
  { value: "system", label: "System", hint: "Follows your device's light or dark setting." },
  { value: "light", label: "Stone", hint: "Light" },
  { value: "dark", label: "Graphite", hint: "Dark" },
]

/**
 * Settings → Appearance: one row, Theme. The change applies to the whole app
 * at once and is kept on this device, in next-themes' own store, so the
 * command menu's "Theme: …" items and this row always agree.
 */
export function AppearanceSettings() {
  const { theme = "system", setTheme } = useTheme()
  const phone = useViewport().widthClass === "compact"
  return (
    <FieldRow size={phone ? "stacked" : "default"} label="Theme" rule="both">
      <FilterChipGroup label="Theme" value={theme} onValueChange={setTheme}>
        {THEMES.map((t) => (
          // The tooltip hangs on a wrapper, not on the chip: as a TooltipTrigger's own element a chip
          // loses its data-slot, and the group's arrow keys find chips by it.
          <Tooltip key={t.value}>
            <TooltipTrigger render={<span />}>
              <FilterChip value={t.value}>{t.label}</FilterChip>
            </TooltipTrigger>
            <TooltipContent>{t.hint}</TooltipContent>
          </Tooltip>
        ))}
      </FilterChipGroup>
    </FieldRow>
  )
}
