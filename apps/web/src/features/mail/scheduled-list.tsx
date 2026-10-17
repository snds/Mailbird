import { toast } from "sonner"

import { useUi } from "@/app/ui-store"
import { Icon, Button, Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@unicron/ui"
import { getCoreClient } from "@/core/client"
import { useScheduled } from "@/core/queries"
import type { OutboxItem } from "@/core/types"
import { longTime } from "@/lib/time"

import { displayName } from "./format"
import { SendLaterMenu } from "./send-later"

/** Messages waiting to go out at a set time: change the time, edit, or cancel. */
export function ScheduledList() {
  const { data: items = [], isPending } = useScheduled()
  if (isPending) return null
  if (items.length === 0) {
    return (
      <Empty className="py-16">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Icon name="schedule_send" />
          </EmptyMedia>
          <EmptyTitle>Nothing scheduled</EmptyTitle>
          <EmptyDescription>Use the arrow next to Send to send a message later.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return (
    <ul className="flex flex-col divide-y" aria-label="Scheduled">
      {items.map((item) => (
        <ScheduledRow key={item.id} item={item} />
      ))}
    </ul>
  )
}

function ScheduledRow({ item }: { item: OutboxItem }) {
  const openComposer = useUi((s) => s.openComposer)
  const run = async (fn: () => Promise<unknown>, done?: string) => {
    try {
      await fn()
      if (done) toast.success(done)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }
  const { draft } = item
  const to = [...draft.to, ...draft.cc].map(displayName).join(", ") || "No recipients"
  return (
    <li className="flex flex-col gap-2 px-(--c-list-row-padding-x) py-(--c-list-row-padding-y)">
      <div className="flex items-baseline gap-2">
        <span className="truncate text-sm font-medium">To {to}</span>
        <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-xs text-vertical-mail-text">
          <Icon name="schedule_send" className="size-3.5" />
          {longTime(item.sendAt)}
        </span>
      </div>
      <p className="line-clamp-2 text-sm text-muted-foreground">
        <span className="text-foreground">{draft.subject || "(no subject)"}</span>
        {draft.body.trim() && <> — {draft.body.trim()}</>}
      </p>
      <div className="-ml-2 flex flex-wrap gap-1">
        <Button variant="ghost" size="sm" onClick={() => run(async () => (await getCoreClient()).rescheduleSend(item.id, null), "Sending now")}>
          <Icon name="send" data-icon="inline-start" /> Send now
        </Button>
        <SendLaterMenu
          onPick={(at) => void run(async () => (await getCoreClient()).rescheduleSend(item.id, at), `Moved to ${longTime(at)}`)}
          trigger={<Button variant="ghost" size="sm" />}
        >
          <Icon name="schedule" data-icon="inline-start" /> Change time
        </SendLaterMenu>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => run(async () => openComposer({ ...(await (await getCoreClient()).cancelSend(item.id)), sendAt: item.sendAt }))}
        >
          <Icon name="edit" data-icon="inline-start" /> Edit
        </Button>
        <Button
          variant="ghost-destructive"
          size="icon-sm"
          aria-label="Delete"
          className="ml-auto"
          onClick={() =>
            run(async () => {
              const client = await getCoreClient()
              const kept = await client.cancelSend(item.id)
              toast("Scheduled message deleted", { action: { label: "Undo", onClick: () => void client.queueSend(kept, 0, item.sendAt).catch((e) => toast.error(String(e))) } })
            })
          }
        >
          <Icon name="delete" />
        </Button>
      </div>
    </li>
  )
}
