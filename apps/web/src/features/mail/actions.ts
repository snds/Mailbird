import { toast } from "sonner"

import { useMailAction } from "@/core/queries"
import type { MessageSummary } from "@/core/types"

/**
 * Conversation triage shared by the toolbar, keyboard shortcuts, and swipe
 * gestures. Anything that moves mail out of view toasts with Undo
 * (principle: reversibility).
 */
export function useTriage(onLeave: () => void) {
  const seen = useMailAction<{ threadId: string; seen: boolean }>((c, a) => c.setThreadSeen(a.threadId, a.seen))
  const flag = useMailAction<{ threadId: string; flagged: boolean }>((c, a) => c.setThreadFlagged(a.threadId, a.flagged))
  const archive = useMailAction<{ threadId: string; archived: boolean }>((c, a) => c.setThreadArchived(a.threadId, a.archived))
  const snooze = useMailAction<{ threadId: string; until: number }>((c, a) => c.snoozeThread(a.threadId, a.until))
  const unsnooze = useMailAction<{ threadId: string }>((c, a) => c.unsnoozeThread(a.threadId))

  const fail = (e: unknown) => toast.error(String(e instanceof Error ? e.message : e))

  return {
    markSeen: (m: MessageSummary, value: boolean) => seen.mutate({ threadId: m.threadId, seen: value }, { onError: fail }),
    toggleSeen: (m: MessageSummary) => seen.mutate({ threadId: m.threadId, seen: !m.seen }, { onError: fail }),
    toggleFlag: (m: MessageSummary) => flag.mutate({ threadId: m.threadId, flagged: !m.flagged }, { onError: fail }),
    toggleArchive: (m: MessageSummary) => {
      const archived = !m.archived
      archive.mutate(
        { threadId: m.threadId, archived },
        {
          onError: fail,
          onSuccess: () => {
            onLeave()
            toast(archived ? "Archived" : "Moved to Inbox", {
              action: { label: "Undo", onClick: () => archive.mutate({ threadId: m.threadId, archived: !archived }) },
            })
          },
        },
      )
    },
    snooze: (m: MessageSummary, until: number, label: string) =>
      snooze.mutate(
        { threadId: m.threadId, until },
        {
          onError: fail,
          onSuccess: () => {
            onLeave()
            toast(`Snoozed until ${label.toLowerCase()}`, {
              action: { label: "Undo", onClick: () => unsnooze.mutate({ threadId: m.threadId }) },
            })
          },
        },
      ),
    unsnooze: (m: MessageSummary) => unsnooze.mutate({ threadId: m.threadId }, { onError: fail }),
  }
}
