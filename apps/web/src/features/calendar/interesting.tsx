import { useState } from "react"
import { toast } from "sonner"

import { Icon } from "@/components/icon"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Switch } from "@/components/ui/switch"
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

/**
 * Holidays and moon phases, computed on the device: nothing to sign in to,
 * no feed to fetch (ADR-0024). The country your device's language suggests
 * comes first.
 */
export function InterestingCalendarsButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="ghost" size="sm" className="justify-start px-1 text-muted-foreground" onClick={() => setOpen(true)}>
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
  const home = homeCountry()
  const holidays = all.filter((c) => c.group === "holidays").sort((a, b) => Number(b.country === home) - Number(a.country === home))
  const sky = all.filter((c) => c.group === "sky")
  const set = (c: InterestingCalendar, on: boolean) =>
    (on ? add : remove).mutate(c.id, {
      onError: fail,
      onSuccess: () => toast.success(on ? `Added ${c.name}` : `Removed ${c.name}`, { duration: 2000 }),
    })
  const row = (c: InterestingCalendar) => (
    <label key={c.id} className="flex h-10 items-center justify-between gap-3 text-sm">
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate">{c.name}</span>
        {c.country && c.country === home && <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">Your region</span>}
      </span>
      <Switch checked={c.subscribed} onCheckedChange={(on) => set(c, on)} aria-label={c.name} />
    </label>
  )
  return (
    <div className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Add calendars</DialogTitle>
        <DialogDescription>Worked out on this device from the rules: nothing to sign in to, and nothing is fetched. National holidays only; regional days vary too much to guess.</DialogDescription>
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
