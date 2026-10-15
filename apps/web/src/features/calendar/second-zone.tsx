import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from "@unicron/ui"

import { deviceZone, setSecondZone, useSecondZone, zones } from "./zones"

/** Picks the second zone, grouped by region ("America", "Europe" …). */
export function SecondZonePicker() {
  const zone = useSecondZone()
  const groups = new Map<string, string[]>()
  for (const z of zones()) {
    const region = z.includes("/") ? z.split("/")[0]! : "Other"
    groups.set(region, [...(groups.get(region) ?? []), z])
  }
  return (
    <label className="flex flex-col gap-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
      Second time zone
      <NativeSelect value={zone ?? ""} onChange={(e) => setSecondZone(e.target.value || null)} className="w-full font-normal tracking-normal normal-case">
        <NativeSelectOption value="">None</NativeSelectOption>
        {[...groups].map(([region, list]) => (
          <NativeSelectOptGroup key={region} label={region.replace(/_/g, " ")}>
            {list
              .filter((z) => z !== deviceZone())
              .map((z) => (
                <NativeSelectOption key={z} value={z}>
                  {z.split("/").slice(1).join(" / ").replace(/_/g, " ") || z}
                </NativeSelectOption>
              ))}
          </NativeSelectOptGroup>
        ))}
      </NativeSelect>
    </label>
  )
}
