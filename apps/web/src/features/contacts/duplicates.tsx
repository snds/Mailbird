import { useState } from "react"
import { toast } from "sonner"

import { Icon, Button } from "@unicron/ui"
import { useDuplicates, usePimAction } from "@/core/queries"
import type { ContactSummary } from "@/core/types"

import { PersonAvatar } from "./person"

/** The card that keeps the most: most emails and phones, then a company. */
const richest = (g: ContactSummary[]) =>
  [...g].sort((a, b) => b.emails.length + b.phones.length - (a.emails.length + a.phones.length) || Number(!!b.org) - Number(!!a.org))[0]!

function Group({ group }: { group: ContactSummary[] }) {
  const [primary, setPrimary] = useState(() => richest(group).id)
  const merge = usePimAction((c, args: { primary: string; others: string[] }) => c.mergeContacts(args.primary, args.others))
  const keep = group.find((g) => g.id === primary)!
  const run = async () => {
    try {
      const merged = await merge.mutateAsync({ primary, others: group.filter((g) => g.id !== primary).map((g) => g.id) })
      toast.success(`Merged into ${merged.fullName}`, { description: `${merged.emails.length} email${merged.emails.length === 1 ? "" : "s"}, ${merged.phones.length} phone${merged.phones.length === 1 ? "" : "s"}`, duration: 3000 })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <section className="rounded-xl border" aria-label={`Possible duplicates of ${keep.fullName}`}>
      <fieldset>
        <legend className="sr-only">Keep which card?</legend>
        {group.map((c) => (
          <label key={c.id} className="flex cursor-pointer items-center gap-3 border-b px-4 py-3 last:border-0 has-checked:bg-muted/50">
            <input type="radio" name={`keep-${group[0]!.id}`} checked={primary === c.id} onChange={() => setPrimary(c.id)} className="accent-(--primary)" aria-label={`Keep ${c.fullName}`} />
            <PersonAvatar contact={c} size="sm" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium">{c.fullName}</span>
              <span className="truncate text-xs text-muted-foreground">{[c.org, ...c.emails.map((e) => e.value), ...c.phones.map((p) => p.value)].filter(Boolean).join(" · ") || "No details"}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="flex items-center justify-between gap-2 px-4 py-2">
        <p className="text-xs text-muted-foreground">Keeps {keep.fullName}'s name and adds everything missing from the others.</p>
        <Button size="sm" onClick={() => void run()} disabled={merge.isPending}>
          <Icon name="merge" data-icon="inline-start" /> Merge
        </Button>
      </div>
    </section>
  )
}

/** Possible duplicates: a shared email or phone number, or the same full name. */
export function DuplicatesPane() {
  const { data: groups = [], isPending } = useDuplicates()
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 px-4 pb-10 md:px-8 md:pt-8">
      <header>
        <h2 className="text-2xl font-semibold tracking-tight">Possible duplicates</h2>
        <p className="text-sm text-muted-foreground">Cards that share an email, a phone number, or a full name. Pick the one to keep; nothing merges without you.</p>
      </header>
      {!isPending && groups.length === 0 && (
        <p className="flex items-center gap-2 rounded-xl border p-4 text-sm text-muted-foreground">
          <Icon name="check_circle" className="size-5" /> No duplicates left.
        </p>
      )}
      {groups.map((g) => (
        <Group key={g.map((c) => c.id).join()} group={g} />
      ))}
    </div>
  )
}
