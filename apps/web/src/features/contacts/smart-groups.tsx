import { useState } from "react"
import { toast } from "sonner"

import { Icon, Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Switch, DialogAction, DialogActions } from "@unicron/ui"
import { useContactLabels, usePimAction, useSmartGroups } from "@/core/queries"
import type { SmartGroup, SmartGroupInput } from "@/core/types"

const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e))

/** Smart groups as chips: each keeps its own members by rule (ADR-0023). */
export function SmartGroupChips({ active, onPick }: { active: string | null; onPick: (id: string | null) => void }) {
  const { data: groups = [] } = useSmartGroups()
  const [editing, setEditing] = useState<{ group?: SmartGroup } | null>(null)
  const current = groups.find((g) => g.id === active)
  return (
    <div role="group" aria-label="Smart groups" className="-mx-4 no-scrollbar mt-2 flex items-center gap-1.5 overflow-x-auto px-4">
      {groups.map((g) => (
        <Button
          key={g.id}
          size="xs"
          variant={active === g.id ? "secondary" : "ghost"}
          aria-pressed={active === g.id}
          shape="pill"
          onClick={() => onPick(active === g.id ? null : g.id)}
        >
          <Icon name="filter_alt" data-icon="inline-start" className="text-vertical-contacts-text" />
          {g.name}
          <span className="text-muted-foreground tabular-nums">{g.count}</span>
        </Button>
      ))}
      {current ? (
        <Button size="icon-xs" variant="ghost" shape="pill" aria-label="Edit smart group" onClick={() => setEditing({ group: current })}>
          <Icon name="tune" />
        </Button>
      ) : (
        <Button size="xs" variant="ghost-muted" shape="pill" onClick={() => setEditing({})}>
          <Icon name="add" data-icon="inline-start" /> Smart group
        </Button>
      )}
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent size="md">
          {editing && (
            <SmartGroupForm
              key={editing.group?.id ?? "new"}
              group={editing.group}
              onDone={(id) => {
                setEditing(null)
                if (id !== undefined) onPick(id)
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function SmartGroupForm({ group, onDone }: { group?: SmartGroup; onDone: (picked?: string | null) => void }) {
  const { data: labels = [] } = useContactLabels()
  const [name, setName] = useState(group?.name ?? "")
  const [picked, setPicked] = useState<string[]>(group?.labels ?? [])
  const [company, setCompany] = useState(group?.company ?? "")
  const [domain, setDomain] = useState(group?.domain ?? "")
  const [hasPhone, setHasPhone] = useState(group?.hasPhone ?? false)
  const [hasBirthday, setHasBirthday] = useState(group?.hasBirthday ?? false)
  const [inTouch, setInTouch] = useState(group?.inTouchDays != null)
  const [days, setDays] = useState(String(group?.inTouchDays ?? 90))
  const save = usePimAction((c, input: SmartGroupInput) => c.saveSmartGroup(group?.id ?? null, input))
  const remove = usePimAction((c) => c.deleteSmartGroup(group!.id))
  // Labels on cards plus any this group names that no card carries right now.
  const choices = [...new Set([...labels.map((l) => l.name), ...picked])]
  const toggle = (l: string) => setPicked((p) => (p.includes(l) ? p.filter((x) => x !== l) : [...p, l]))

  const submit = async () => {
    try {
      const g = await save.mutateAsync({
        name,
        labels: picked,
        company: company || null,
        domain: domain || null,
        hasPhone,
        hasBirthday,
        inTouchDays: inTouch ? Number(days) || null : null,
      })
      toast.success(group ? `Updated “${g.name}”` : `Added “${g.name}”: ${g.count} ${g.count === 1 ? "person" : "people"} so far`, { duration: 2500 })
      onDone(g.id)
    } catch (e) {
      fail(e)
    }
  }
  const del = async () => {
    try {
      await remove.mutateAsync(undefined)
      toast.success(`Deleted “${group!.name}”. Nobody in it was changed.`, { duration: 2500 })
      onDone(null)
    } catch (e) {
      fail(e)
    }
  }
  const field = "h-9 w-full rounded-lg border bg-transparent px-2.5 text-sm dark:bg-input/30"
  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => (e.preventDefault(), void submit())}>
      <DialogHeader>
        <DialogTitle>{group ? "Edit smart group" : "New smart group"}</DialogTitle>
        <DialogDescription>People join and leave by themselves as their cards change. Fill in what applies: they must match all of it.</DialogDescription>
      </DialogHeader>
      <label className="flex flex-col gap-1 text-sm">
        Name
        <input className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="Studio team, Keep in touch…" autoFocus />
      </label>
      {choices.length > 0 && (
        <div role="group" aria-label="Has any of these labels" className="flex flex-col gap-1.5 text-sm">
          Has any of these labels
          <div className="flex flex-wrap gap-1.5">
            {choices.map((l) => (
              <Button key={l} type="button" size="xs" variant={picked.includes(l) ? "secondary" : "outline"} aria-pressed={picked.includes(l)} shape="pill" onClick={() => toggle(l)}>
                {l}
              </Button>
            ))}
          </div>
        </div>
      )}
      <label className="flex flex-col gap-1 text-sm">
        Company contains
        <input className={field} value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Studio" />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Email at
        <input className={field} value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="studio.example" />
        <span className="text-xs text-muted-foreground">A domain. Its subdomains count too.</span>
      </label>
      <label className="flex items-center justify-between gap-3 text-sm">
        Has a phone number
        <Switch checked={hasPhone} onCheckedChange={setHasPhone} aria-label="Has a phone number" />
      </label>
      <label className="flex items-center justify-between gap-3 text-sm">
        Has a birthday
        <Switch checked={hasBirthday} onCheckedChange={setHasBirthday} aria-label="Has a birthday" />
      </label>
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="flex flex-wrap items-center gap-1.5">
          In touch in the last
          <input
            aria-label="Days"
            type="number"
            min={1}
            className="h-8 w-16 rounded-lg border bg-transparent px-2 text-sm tabular-nums disabled:opacity-50 dark:bg-input/30"
            value={days}
            disabled={!inTouch}
            onChange={(e) => setDays(e.target.value)}
          />
          days
        </span>
        <Switch checked={inTouch} onCheckedChange={setInTouch} aria-label="In touch recently" />
      </div>
      <DialogActions>
        {group && (
          <DialogAction kind="destructive" type="button" onClick={() => void del()}>
            Delete group
          </DialogAction>
        )}
        <DialogAction kind="cancel" type="button" onClick={() => onDone()}>
          Cancel
        </DialogAction>
        <DialogAction type="submit" disabled={save.isPending}>
          {group ? "Save" : "Add group"}
        </DialogAction>
      </DialogActions>
    </form>
  )
}
