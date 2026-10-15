import { useState } from "react"
import { toast } from "sonner"

import { useUi } from "@/app/ui-store"
import { Icon, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, NativeSelect, NativeSelectOption, Switch } from "@unicron/ui"
import { getCoreClient } from "@/core/client"
import { useAccounts, useInboxOverview, useMailAction, useSplits } from "@/core/queries"
import type { Split, SplitInput } from "@/core/types"

const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e))

/** Your split tabs, after the category chips: each with its unread count, plus "New split". */
export function SplitChips({ accountId, onPick }: { accountId: string | null; onPick: () => void }) {
  const { data: splits = [] } = useSplits()
  const { data: overview } = useInboxOverview(accountId)
  const active = useUi((s) => s.mailSplit)
  const setSplit = useUi((s) => s.setMailSplit)
  const open = useUi((s) => s.openSplitEditor)
  return (
    <>
      {splits.map((s) => {
        const unread = overview?.splits.find((c) => c.id === s.id)?.unread ?? 0
        return (
          <Button
            key={s.id}
            size="xs"
            variant={active === s.id ? "secondary" : "ghost"}
            aria-pressed={active === s.id}
            className="shrink-0 rounded-full px-3"
            onClick={() => (setSplit(s.id), onPick())}
            onDoubleClick={() => open({ id: s.id, initial: s })}
          >
            {s.name}
            {unread > 0 && <span className="text-muted-foreground tabular-nums">{unread}</span>}
          </Button>
        )
      })}
      {active && splits.some((s) => s.id === active) ? (
        <Button size="icon-xs" variant="ghost" className="shrink-0 rounded-full" aria-label="Edit split" onClick={() => open({ id: active, initial: splits.find((s) => s.id === active)! })}>
          <Icon name="tune" />
        </Button>
      ) : (
        <Button size="icon-xs" variant="ghost" className="shrink-0 rounded-full" aria-label="New split" onClick={() => open({ initial: {} })}>
          <Icon name="add" />
        </Button>
      )}
    </>
  )
}

/** Creates or edits a split: who it's from, what the subject says, and whether it leaves the inbox. */
export function SplitEditor() {
  const state = useUi((s) => s.splitEditor)
  const open = useUi((s) => s.openSplitEditor)
  return (
    <Dialog open={state !== null} onOpenChange={(o) => !o && open(null)}>
      <DialogContent className="sm:max-w-md">{state && <SplitForm key={state.id ?? "new"} id={state.id} initial={state.initial} onDone={() => open(null)} />}</DialogContent>
    </Dialog>
  )
}

function SplitForm({ id, initial, onDone }: { id?: string; initial: Partial<SplitInput>; onDone: () => void }) {
  const { data: accounts = [] } = useAccounts()
  const setSplit = useUi((s) => s.setMailSplit)
  const [name, setName] = useState(initial.name ?? "")
  const [senders, setSenders] = useState((initial.senders ?? []).join(", "))
  const [subject, setSubject] = useState(initial.subject ?? "")
  const [attachments, setAttachments] = useState(initial.hasAttachments ?? false)
  const [account, setAccount] = useState(initial.accountId ?? "")
  // New splits keep their mail out of All by default: that's the point of a split.
  const [exclusive, setExclusive] = useState(initial.exclusive ?? true)
  const save = useMailAction((c, input: SplitInput) => c.saveSplit(id ?? null, input))
  const remove = useMailAction((c) => c.deleteSplit(id!))
  const submit = async () => {
    const input: SplitInput = {
      name,
      senders: senders.split(/[,\s]+/).filter(Boolean),
      subject: subject || null,
      hasAttachments: attachments,
      accountId: account || null,
      exclusive,
    }
    try {
      const split = (await save.mutateAsync(input)) as Split
      toast.success(id ? `Updated “${split.name}”` : `Added the “${split.name}” split`, { duration: 2000 })
      setSplit(split.id)
      onDone()
    } catch (e) {
      fail(e)
    }
  }
  const del = async () => {
    try {
      await remove.mutateAsync(undefined)
      setSplit(null)
      toast.success(`Deleted “${name}”`, { duration: 2000 })
      onDone()
    } catch (e) {
      fail(e)
    }
  }
  const field = "h-9 w-full rounded-lg border bg-transparent px-2.5 text-sm dark:bg-input/30"
  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => (e.preventDefault(), void submit())}>
      <DialogHeader>
        <DialogTitle>{id ? "Edit split" : "New split"}</DialogTitle>
        <DialogDescription>A tab for mail that matches. Fill in what applies: mail must match all of it.</DialogDescription>
      </DialogHeader>
      <label className="flex flex-col gap-1 text-sm">
        Name
        <input className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="Work, Bills, Clients…" autoFocus />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        From
        <input className={field} value={senders} onChange={(e) => setSenders(e.target.value)} placeholder="ana@example.com, @studio.example" />
        <span className="text-xs text-muted-foreground">Addresses, or a whole domain with @ in front. Any one of them matches.</span>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Subject contains
        <input className={field} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="invoice" />
      </label>
      {accounts.length > 1 && (
        <label className="flex flex-col gap-1 text-sm">
          Account
          <NativeSelect value={account} onChange={(e) => setAccount(e.target.value)} className="w-full">
            <NativeSelectOption value="">Any account</NativeSelectOption>
            {accounts.map((a) => (
              <NativeSelectOption key={a.id} value={a.id}>
                {a.displayName}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
      )}
      <label className="flex items-center justify-between gap-3 text-sm">
        Only with attachments
        <Switch checked={attachments} onCheckedChange={setAttachments} aria-label="Only with attachments" />
      </label>
      <label className="flex items-center justify-between gap-3 text-sm">
        <span>
          Keep out of All
          <span className="block text-xs text-muted-foreground">Its mail shows only in this tab.</span>
        </span>
        <Switch checked={exclusive} onCheckedChange={setExclusive} aria-label="Keep out of All" />
      </label>
      <DialogFooter className="flex-row items-center">
        {id && (
          <Button type="button" variant="ghost" className="mr-auto text-destructive hover:text-destructive" onClick={() => void del()}>
            Delete split
          </Button>
        )}
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {id ? "Save" : "Add split"}
        </Button>
      </DialogFooter>
    </form>
  )
}

/** Newsletters folded into one row: open them, mark them read, or clear them out (with Undo). */
export function BundleRow({ accountId, onOpen }: { accountId: string | null; onOpen: () => void }) {
  const { data: overview } = useInboxOverview(accountId)
  const read = useMailAction((c) => c.bundleMarkRead(accountId))
  const archive = useMailAction((c) => c.bundleArchive(accountId))
  const b = overview?.bundle
  if (!b) return null
  const clear = async () => {
    try {
      const keys = (await archive.mutateAsync(undefined)) as string[]
      toast(`Archived ${b.threads} newsletters`, {
        action: { label: "Undo", onClick: () => void getCoreClient().then((c) => c.unarchiveBundle(keys)).catch(fail) },
        duration: 6000,
      })
    } catch (e) {
      fail(e)
    }
  }
  return (
    <section aria-label="Newsletters bundle" className="mx-3 mb-1 flex items-center gap-3 rounded-xl border bg-muted/40 py-2 pr-2 pl-3" data-slot="bundle">
      <button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={onOpen}>
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-background">
          <Icon name="newspaper" className="size-5 text-muted-foreground" />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className={b.unread ? "text-sm font-semibold" : "text-sm font-medium"}>
            Newsletters <span className="font-normal text-muted-foreground tabular-nums">· {b.unread ? `${b.unread} new` : b.threads}</span>
          </span>
          <span className="truncate text-xs text-muted-foreground">{b.senders.join(", ")}</span>
        </span>
      </button>
      {b.unread > 0 && (
        <Button size="icon-sm" variant="ghost" aria-label="Mark all newsletters read" disabled={read.isPending} onClick={() => read.mutate(undefined, { onError: fail })}>
          <Icon name="done_all" />
        </Button>
      )}
      <Button size="icon-sm" variant="ghost" aria-label="Archive all newsletters" disabled={archive.isPending} onClick={() => void clear()}>
        <Icon name="archive" />
      </Button>
    </section>
  )
}
