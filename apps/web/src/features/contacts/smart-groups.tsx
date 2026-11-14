import { useState } from "react"

import { useUi } from "@/app/ui-store"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Switch, DialogAction, DialogActions, Toggle, toast } from "@unicron/ui"
import { useContactLabels, usePimAction } from "@/core/queries"
import type { SmartGroup, SmartGroupInput } from "@/core/types"

import { useSmartGroupEditor } from "./open-smart-group"

const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e))

/**
 * Smart groups keep their own members by rule (ADR-0023). Contacts mounts
 * this; a saved group becomes the place, a deleted one gives way to everyone.
 */
export function SmartGroupEditor() {
  const editing = useSmartGroupEditor((s) => s.editing)
  const close = () => useSmartGroupEditor.setState({ editing: null })
  return (
    <Dialog open={editing !== null} onOpenChange={(o) => !o && close()}>
      <DialogContent size="md">
        {editing && (
          <SmartGroupForm
            key={editing.group?.id ?? "new"}
            group={editing.group}
            onDone={(id) => {
              close()
              if (id !== undefined) useUi.getState().setContactsPlace(id ? { kind: "group", id } : { kind: "all" })
            }}
          />
        )}
      </DialogContent>
    </Dialog>
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
              <Toggle key={l} type="button" size="sm" variant="outline" pressed={picked.includes(l)} onPressedChange={() => toggle(l)}>
                {l}
              </Toggle>
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
