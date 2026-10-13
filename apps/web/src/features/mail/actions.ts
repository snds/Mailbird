import { toast } from "sonner"

import { useMailAction } from "@/core/queries"
import type { MessageSummary } from "@/core/types"

/**
 * Triage actions shared by the toolbar and keyboard shortcuts. Every
 * destructive-feeling action toasts with Undo (principle: reversibility).
 */
export function useTriage(onLeave: () => void) {
  const seen = useMailAction<{ id: string; seen: boolean }>((c, a) => c.setSeen(a.id, a.seen))
  const flag = useMailAction<{ id: string; flagged: boolean }>((c, a) => c.setFlagged(a.id, a.flagged))
  const archive = useMailAction<{ id: string; archived: boolean }>((c, a) => c.setArchived(a.id, a.archived))
  const snooze = useMailAction<{ id: string; until: number }>((c, a) => c.snooze(a.id, a.until))
  const unsnooze = useMailAction<{ id: string }>((c, a) => c.unsnooze(a.id))

  const fail = (e: unknown) => toast.error(String(e instanceof Error ? e.message : e))

  return {
    markSeen: (m: MessageSummary, value: boolean) => seen.mutate({ id: m.id, seen: value }, { onError: fail }),
    toggleFlag: (m: MessageSummary) => flag.mutate({ id: m.id, flagged: !m.flagged }, { onError: fail }),
    toggleArchive: (m: MessageSummary) => {
      const archived = !m.archived
      archive.mutate(
        { id: m.id, archived },
        {
          onError: fail,
          onSuccess: () => {
            onLeave()
            toast(archived ? "Archived" : "Moved to Inbox", {
              action: { label: "Undo", onClick: () => archive.mutate({ id: m.id, archived: !archived }) },
            })
          },
        },
      )
    },
    snooze: (m: MessageSummary, until: number, label: string) =>
      snooze.mutate(
        { id: m.id, until },
        {
          onError: fail,
          onSuccess: () => {
            onLeave()
            toast(`Snoozed until ${label.toLowerCase()}`, {
              action: { label: "Undo", onClick: () => unsnooze.mutate({ id: m.id }) },
            })
          },
        },
      ),
    unsnooze: (m: MessageSummary) => unsnooze.mutate({ id: m.id }, { onError: fail }),
  }
}
