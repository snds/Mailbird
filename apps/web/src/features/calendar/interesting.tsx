import { useState } from "react"
import { toast } from "sonner"

import { Icon, Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, NativeSelect, NativeSelectOption, Switch } from "@unicron/ui"
import { useInterestingCalendars, usePimAction } from "@/core/queries"
import type { InterestingCalendar } from "@/core/types"

const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e))

/** The country this device's language points at ("en-GB" → GB), if any. */
const homeCountry = () => {
  try {
    return new Intl.Locale(navigator.language).maximize().region ?? null
  } catch {
    return null
  }
}

/** "DE" → "Germany", in the device's language. */
const countryName = (code: string) => {
  try {
    return new Intl.DisplayNames([navigator.language], { type: "region" }).of(code) ?? code
  } catch {
    return code
  }
}

/**
 * Holidays and moon phases, computed on the device: nothing to sign in to,
 * no feed to fetch (ADR-0024). The country your device's language suggests
 * comes first.
 */
export function InterestingCalendarsPicker() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="ghost-muted" size="sm" className="justify-start px-1" onClick={() => setOpen(true)}>
        <Icon name="add" data-icon="inline-start" /> Add holidays and more
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-md">{open && <Catalog />}</DialogContent>
      </Dialog>
    </>
  )
}

function Catalog() {
  const { data: all = [] } = useInterestingCalendars()
  const add = usePimAction((c, id: string) => c.addInterestingCalendar(id))
  const remove = usePimAction((c, id: string) => c.removeInterestingCalendar(id))
  const setRegion = usePimAction((c, a: { id: string; region: string | null }) => c.setHolidayRegion(a.id, a.region))
  const home = homeCountry()
  const holidays = all.filter((c) => c.group === "holidays").sort((a, b) => Number(b.country === home) - Number(a.country === home))
  const sky = all.filter((c) => c.group === "sky")
  const set = (c: InterestingCalendar, on: boolean) =>
    (on ? add : remove).mutate(c.id, {
      onError: fail,
      onSuccess: () => toast.success(on ? `Added ${c.name}` : `Removed ${c.name}`, { duration: 2000 }),
    })
  const pick = (c: InterestingCalendar, region: string | null) =>
    setRegion.mutate(
      { id: c.id, region },
      {
        onError: fail,
        onSuccess: () => {
          const r = c.regions.find((x) => x.code === region)
          toast.success(r ? `Showing ${r.name}’s days too` : "Showing nationwide holidays only", { duration: 2000 })
        },
      },
    )
  const row = (c: InterestingCalendar) => (
    <div key={c.id} className="flex flex-col">
      <label className="flex h-10 items-center justify-between gap-3 text-sm">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{c.name}</span>
          {/* Renamed for a region: keep the country in view, so the A–Z list still reads. */}
          {c.region && c.country && <span className="shrink-0 text-xs text-muted-foreground">{countryName(c.country)}</span>}
          {c.country && c.country === home && <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs whitespace-nowrap text-muted-foreground">Your country</span>}
        </span>
        <Switch checked={c.subscribed} onCheckedChange={(on) => set(c, on)} aria-label={c.name} />
      </label>
      {/* Regional days only once the country is added, so the list stays short. */}
      {c.subscribed && c.regions.length > 0 && (
        <label className="flex items-center justify-between gap-3 pb-2 pl-4 text-sm text-muted-foreground">
          <span>Region</span>
          <NativeSelect aria-label={`Region for ${c.name}`} className="w-56" value={c.region ?? ""} onChange={(e) => pick(c, e.target.value || null)}>
            <NativeSelectOption value="">Nationwide only</NativeSelectOption>
            {c.regions.map((r) => (
              <NativeSelectOption key={r.code} value={r.code}>
                {r.name.replace(/^the /, "").replace(/^./, (x) => x.toUpperCase())}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
      )}
    </div>
  )
  return (
    <div className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Add calendars</DialogTitle>
        <DialogDescription>Worked out on this device from the rules: nothing to sign in to, and nothing is fetched. Pick a region to add its own days, where they follow fixed rules.</DialogDescription>
      </DialogHeader>
      <section aria-label="Holidays" className="flex flex-col">
        <h3 className="pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Holidays</h3>
        {holidays.map(row)}
      </section>
      <section aria-label="Sky" className="flex flex-col">
        <h3 className="pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Sky</h3>
        {sky.map(row)}
      </section>
    </div>
  )
}
