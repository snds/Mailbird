import { useId, useState } from "react"

import { AdaptiveDialog, Button, TextField, toast } from "@unicron/ui"
import { usePimAction } from "@/core/queries"

import { useSavingSet } from "./use-sets"

const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e))

/**
 * "Save as set…": the form that names what is showing (ADR-0021; brief C5).
 * The calendar view mounts it; the calendars list's row opens it
 * (`use-sets.ts`).
 */
export function SaveSetDialog() {
  const open = useSavingSet((s) => s.open)
  const close = () => useSavingSet.setState({ open: false })
  const [name, setName] = useState("")
  const form = useId()
  const save = usePimAction((c, name: string) => c.saveCalendarSet(name))
  const submit = () => {
    if (!name.trim()) return
    save.mutate(name, {
      onSuccess: () => (toast.success(`Saved “${name.trim()}”`, { duration: 2000 }), close(), setName("")),
      onError: fail,
    })
  }
  return (
    <AdaptiveDialog
      open={open}
      onOpenChange={(o) => !o && close()}
      size="question"
      overline="Calendars"
      title="Save as set"
      description="Saves the calendars showing now under one name. Picking the set shows exactly those again."
      footer={
        <>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form={form} disabled={!name.trim()} loading={save.isPending}>
            Save set
          </Button>
        </>
      }
    >
      <form id={form} onSubmit={(e) => (e.preventDefault(), submit())}>
        <TextField label="Set name" placeholder="Work" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </form>
    </AdaptiveDialog>
  )
}
