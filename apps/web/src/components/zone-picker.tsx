import { useMemo, useState, type ReactElement } from "react"

import { AdaptivePopover, Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, Icon, type AdaptivePopoverProps } from "@unicron/ui"
import { deviceZone, zoneAbbr, zoneCity, zones } from "@/features/calendar/zones"

/**
 * The time-zone picker (ADR-0088; briefs C3 and T4): every zone the platform
 * knows in a searchable list, a popover on a desktop and a sheet on a phone.
 * "Yours" comes first; the rest are grouped by region, each with its short
 * name at `at` (PST or PDT depends on the date). Found by city, region or
 * short name.
 *
 * With `none`, for the calendar's second zone: "None" comes first, and your
 * own zone is left out, since the second zone is never the first.
 */
export function ZonePicker({
  trigger,
  title = "Time zone",
  value,
  onPick,
  at,
  none = false,
  align = "end",
}: {
  /** The control that opens it. Focus returns to it. */
  trigger: ReactElement<Record<string, unknown>>
  title?: string
  value: string | null
  onPick: (zone: string | null) => void
  /** The instant the short names are for. Now, when left out. */
  at?: Date
  none?: boolean
  align?: AdaptivePopoverProps["align"]
}) {
  const [open, setOpen] = useState(false)
  const pick = (zone: string | null) => {
    setOpen(false)
    onPick(zone)
  }
  return (
    <AdaptivePopover open={open} onOpenChange={setOpen} trigger={trigger} title={title} align={align}>
      <ZoneList value={value} onPick={pick} at={at} none={none} />
    </AdaptivePopover>
  )
}

/**
 * A zone is found when every word typed is in its name, its region or its
 * short name: "lisb" is Lisbon, and not Brisbane or Tbilisi as a looser
 * match would also give. A name that starts with the words comes first.
 */
function zoneFilter(value: string, search: string, keywords: string[] = []) {
  const hay = [value, ...keywords].join(" ").replace(/[_/]/g, " ").toLowerCase()
  const words = search.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.every((w) => hay.includes(w))) return 0
  return keywords.some((k) => k.toLowerCase().startsWith(words[0] ?? "")) ? 1 : 0.5
}

/** The end of a row: the check on the picked zone, and the same room on the others, so the short names line up. */
const mark = (picked: boolean) => (
  <span className="flex size-5 shrink-0 items-center justify-center">
    {picked && <Icon name="checkmark" />}
    {picked && <span className="sr-only">, picked</span>}
  </span>
)

// Mounted while the picker is open: the 400-odd short names are worked out once per opening.
function ZoneList({ value, onPick, at, none }: { value: string | null; onPick: (zone: string | null) => void; at?: Date; none: boolean }) {
  const mine = deviceZone()
  const [opened] = useState(() => new Date())
  const groups = useMemo(() => {
    const when = at && !Number.isNaN(at.getTime()) ? at : opened
    const out = new Map<string, { zone: string; city: string; abbr: string }[]>()
    for (const zone of zones()) {
      if (zone === mine) continue
      const region = zone.includes("/") ? zone.split("/")[0]!.replace(/_/g, " ") : "Other"
      // "Argentina / Buenos Aires" keeps its middle part, so two cities of one name stay apart.
      const city = zone.split("/").slice(1).join(" / ").replace(/_/g, " ") || zone
      out.set(region, [...(out.get(region) ?? []), { zone, city, abbr: zoneAbbr(zone, when) }])
    }
    return { when, regions: [...out] }
  }, [at, mine, opened])
  return (
    <Command label="Search time zones" filter={zoneFilter}>
      <CommandInput placeholder="Search by city or zone" />
      <CommandList>
        <CommandEmpty>No time zone like that.</CommandEmpty>
        <CommandGroup>
          {none ? (
            <CommandItem value="none" keywords={["None", "off", "remove"]} onSelect={() => onPick(null)}>
              <span className="min-w-0 flex-1 truncate">None</span>
              {mark(value === null)}
            </CommandItem>
          ) : (
            <CommandItem value={`yours ${mine}`} keywords={["Yours", "mine", zoneCity(mine), zoneAbbr(mine, groups.when)]} onSelect={() => onPick(mine)}>
              <span className="min-w-0 flex-1 truncate">Yours // {zoneCity(mine)}</span>
              <span className="type-meta">{zoneAbbr(mine, groups.when)}</span>
              {mark(value === mine)}
            </CommandItem>
          )}
        </CommandGroup>
        {groups.regions.map(([region, list]) => (
          <CommandGroup key={region} heading={region}>
            {list.map(({ zone, city, abbr }) => (
              <CommandItem key={zone} value={zone} keywords={[city, region, abbr]} onSelect={() => onPick(zone)}>
                <span className="min-w-0 flex-1 truncate">{city}</span>
                <span className="type-meta">{abbr}</span>
                {mark(value === zone)}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </Command>
  )
}
