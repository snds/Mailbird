import { toast } from "sonner"

import { Icon } from "@/components/icon"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { useCollections, useDeletedContacts, usePimAction } from "@/core/queries"
import { shortTime } from "@/lib/time"

/** Contacts deleted in the last 30 days, each one tap from coming back. */
export function RecentlyDeletedPane({ onRestored }: { onRestored: (id: string) => void }) {
  const { data: gone = [], isPending } = useDeletedContacts()
  const { data: books = [] } = useCollections("contacts")
  const restore = usePimAction((c, id: string) => c.restoreContact(id))
  const run = async (id: string) => {
    try {
      const back = await restore.mutateAsync(id)
      toast.success(`Restored ${back.fullName}`, { duration: 2500 })
      onRestored(back.id)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }
  if (isPending) return null
  return (
    <section className="mx-auto flex max-w-2xl flex-col gap-4 px-4 pb-10 md:px-8 md:pt-8" aria-label="Recently deleted">
      <header>
        <h2 className="text-2xl font-semibold tracking-tight">Recently deleted</h2>
        <p className="text-sm text-muted-foreground">Deleted contacts and cards merged into another stay here for 30 days.</p>
      </header>
      {gone.length === 0 ? (
        <Empty className="py-12">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Icon name="restore_from_trash" />
            </EmptyMedia>
            <EmptyTitle>Nothing deleted</EmptyTitle>
            <EmptyDescription>Contacts you delete show up here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="divide-y rounded-xl border">
          {gone.map((g) => {
            const book = books.find((b) => b.id === g.bookId)
            return (
              <li key={g.id} className="flex items-center gap-3 px-4 py-3">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">{g.fullName || "(no name)"}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {[g.emails[0]?.value, `deleted ${shortTime(g.deletedAt)}`, book ? null : "its address book is gone, so it returns to this device"].filter(Boolean).join(" · ")}
                  </span>
                </span>
                <Button variant="outline" size="sm" disabled={restore.isPending} onClick={() => void run(g.id)} aria-label={`Restore ${g.fullName}`}>
                  <Icon name="settings_backup_restore" data-icon="inline-start" /> Restore
                </Button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
