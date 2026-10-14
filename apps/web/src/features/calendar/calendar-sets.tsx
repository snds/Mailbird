import { useState } from "react"
import { toast } from "sonner"

import { Icon } from "@/components/icon"
import { Button } from "@/components/ui/button"
import { useCalendarSets, usePimAction } from "@/core/queries"
import type { Collection } from "@/core/types"

/**
 * Saved combinations of calendars ("Work", "Personal"): one tap shows exactly
 * that set (Fantastical's calendar sets). Saving uses what's showing now.
 */
export function CalendarSets({ calendars }: { calendars: Map<string, Collection> }) {
  const { data: sets = [] } = useCalendarSets()
  const apply = usePimAction((c, id: string) => c.applyCalendarSet(id))
  const save = usePimAction((c, name: string) => c.saveCalendarSet(name))
  const remove = usePimAction((c, id: string) => c.deleteCalendarSet(id))
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState("")
  const showing = [...calendars.values()].filter((c) => !c.hidden).map((c) => c.id)
  const isActive = (ids: string[]) => ids.length === showing.length && ids.every((id) => showing.includes(id))
  const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e))
  return (
    <section aria-label="Calendar sets" className="flex flex-col gap-1.5">
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Sets</h3>
      {sets.length > 0 && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Show a set">
          {sets.map((s) => (
            <span key={s.id} className="inline-flex items-center">
              <Button size="xs" variant={isActive(s.calendarIds) ? "secondary" : "outline"} aria-pressed={isActive(s.calendarIds)} className="rounded-l-full rounded-r-none pr-2" onClick={() => apply.mutate(s.id, { onError: fail })}>
                {s.name}
              </Button>
              <Button size="icon-xs" variant="outline" aria-label={`Delete set ${s.name}`} className="-ml-px rounded-l-none rounded-r-full" onClick={() => remove.mutate(s.id, { onError: fail })}>
                <Icon name="close" />
              </Button>
            </span>
          ))}
        </div>
      )}
      {naming ? (
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            if (!name.trim()) return
            save.mutate(name, {
              onSuccess: () => (toast.success(`Saved “${name.trim()}”`, { duration: 2000 }), setNaming(false), setName("")),
              onError: fail,
            })
          }}
        >
          <input
            aria-label="Set name"
            placeholder="Name, like Work"
            className="h-7 min-w-0 flex-1 rounded-lg border bg-background px-2 text-sm dark:bg-input/30"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            onKeyDown={(e) => e.key === "Escape" && setNaming(false)}
          />
          <Button type="submit" size="xs" disabled={!name.trim() || save.isPending}>
            Save
          </Button>
        </form>
      ) : (
        <button type="button" className="flex h-7 items-center gap-1.5 self-start text-xs font-medium text-primary hover:underline" onClick={() => setNaming(true)}>
          <Icon name="add" className="size-3.5" /> Save what's showing as a set
        </button>
      )}
    </section>
  )
}
