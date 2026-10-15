import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"

import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@unicron/ui"
import { getCoreClient } from "@/core/client"
import { usePimAction } from "@/core/queries"

const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e))

const POINTS = [
  { label: "10 minutes ago", secs: 600 },
  { label: "An hour ago", secs: 3600 },
  { label: "Yesterday", secs: 86_400 },
  { label: "A week ago", secs: 7 * 86_400 },
  { label: "30 days ago", secs: 30 * 86_400 },
] as const

/** A short list of names: "Ana, Sam, and 3 more". */
const few = (names: string[]) => {
  if (names.length <= 3) return names.length === 3 ? `${names[0]}, ${names[1]}, and ${names[2]}` : names.join(" and ")
  return `${names.slice(0, 2).join(", ")}, and ${names.length - 2} more`
}

/**
 * Undo every contact change since a point in time, from this device or a
 * sync (Google Contacts' "Undo changes"). Shows what it will do first; the
 * restore itself can be undone.
 */
export function RestoreContactsDialog({ openedAt, onClose }: { openedAt: number | null; onClose: () => void }) {
  return (
    <Dialog open={openedAt !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">{openedAt !== null && <RestoreForm openedAt={openedAt} onDone={onClose} />}</DialogContent>
    </Dialog>
  )
}

/** `openedAt`: Unix seconds when the dialog opened, so "an hour ago" means an hour before that. */
function RestoreForm({ openedAt, onDone }: { openedAt: number; onDone: () => void }) {
  const [pick, setPick] = useState<number>(1)
  // Fixed when chosen, so the preview and the restore agree.
  const [since, setSince] = useState(openedAt - POINTS[1].secs)
  const choose = (i: number) => (setPick(i), setSince(openedAt - POINTS[i]!.secs))
  const { data: plan, isPending } = useQuery({
    queryKey: ["pim", "restore-preview", since],
    queryFn: async () => (await getCoreClient()).contactsRestorePreview({ since }),
  })
  const restore = usePimAction((c, point: { since?: number; after?: number }) => c.restoreContacts(point))
  const total = plan ? plan.added.length + plan.edited.length + plan.deleted.length : 0

  const run = async () => {
    try {
      const done = await restore.mutateAsync({ since })
      onDone()
      toast(`Restored ${done.changed} ${done.changed === 1 ? "contact" : "contacts"} to ${POINTS[pick]!.label.toLowerCase()}`, {
        // The dialog is gone by now; the core's pim:changed refreshes the lists.
        action: { label: "Undo", onClick: () => void getCoreClient().then((c) => c.restoreContacts({ after: done.mark })).catch(fail) },
        duration: 8000,
      })
    } catch (e) {
      fail(e)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Restore contacts</DialogTitle>
        <DialogDescription>Put every contact back the way it was, undoing edits, deletes, and additions since then, from here or from a sync.</DialogDescription>
      </DialogHeader>
      <div role="radiogroup" aria-label="Restore to" className="flex flex-wrap gap-1.5">
        {POINTS.map((p, i) => (
          <Button key={p.label} size="sm" variant={pick === i ? "secondary" : "outline"} role="radio" aria-checked={pick === i} shape="pill" onClick={() => choose(i)}>
            {p.label}
          </Button>
        ))}
      </div>
      <div role="status" aria-label="What changes" className="min-h-16 rounded-xl bg-muted/50 px-3 py-2.5 text-sm">
        {isPending || !plan ? (
          <span className="text-muted-foreground">Checking…</span>
        ) : total === 0 ? (
          <span className="text-muted-foreground">No contacts changed since then.</span>
        ) : (
          <ul className="flex flex-col gap-1">
            {plan.edited.length > 0 && <li>Puts back {few(plan.edited)} as they were</li>}
            {plan.deleted.length > 0 && <li>Brings back {few(plan.deleted)}</li>}
            {plan.added.length > 0 && <li>Removes {few(plan.added)}, added since (they go to Recently deleted)</li>}
          </ul>
        )}
        {plan && plan.readOnly > 0 && (
          <p className="mt-1 text-xs text-muted-foreground">
            {plan.readOnly} {plan.readOnly === 1 ? "change is" : "changes are"} in an address book you can't edit, so {plan.readOnly === 1 ? "it stays" : "they stay"}.
          </p>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button disabled={total === 0 || restore.isPending} onClick={() => void run()}>
          Restore {total > 0 ? total : ""}
        </Button>
      </DialogFooter>
    </div>
  )
}
