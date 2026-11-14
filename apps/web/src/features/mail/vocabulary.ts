
import { type IconName, toast } from "@unicron/ui"
import { useMailAction } from "@/core/queries"
import type { MessageSummary, SwipeActionId } from "@/core/types"
import { snoozeOptions } from "@/lib/time"

import type { useTriage } from "./actions"
import type { useSenderActions } from "./sender-actions"

/** One action, as a swipe shows it and does it. */
export interface MailVerb {
  icon: IconName
  label: string
  /** Background utility for the revealed action, bound to a semantic token. */
  tone: string
  onCommit: () => void
}

/**
 * The swipe-able part of the shared mail vocabulary (ADR-0025): what each
 * action is called in Settings, and the key command that does the same
 * thing (ADR-0032), so a gesture is never the only way in.
 */
export const SWIPE_CHOICES: { id: SwipeActionId; label: string; command?: string }[] = [
  { id: "read", label: "Read / unread", command: "mail.unread" },
  { id: "archive", label: "Archive", command: "mail.archive" },
  { id: "star", label: "Star", command: "mail.star" },
  { id: "snooze-tomorrow", label: "Snooze until tomorrow", command: "mail.snooze-tomorrow" },
  { id: "snooze-next-week", label: "Snooze until next week", command: "mail.snooze-next-week" },
  { id: "remind", label: "Remind me in 3 days if nobody replies", command: "mail.remind" },
  { id: "newsletters", label: "Always in Newsletters", command: "mail.newsletters" },
  { id: "none", label: "Nothing" },
]

/**
 * What a swipe reveals behind the row, fill and ink together. Read and
 * archive, the two the design draws solid, take the identity color; every
 * other action is a raised neutral tile.
 */
export const PRIMARY = "bg-primary text-primary-foreground"
const NEUTRAL = "bg-muted text-foreground"

/** 9:00 three days from now, for "remind me if nobody replies". */
const inThreeDays = () => {
  const d = new Date(Date.now() + 3 * 86_400_000)
  d.setHours(9, 0, 0, 0)
  return Math.floor(d.getTime() / 1000)
}

/** Turns an action id into what a swipe on `m` reveals and does. */
export function useMailVerbs(triage: ReturnType<typeof useTriage>, senders: ReturnType<typeof useSenderActions>) {
  const followUp = useMailAction<{ threadId: string; at: number }>((c, a) => c.setFollowUp(a.threadId, a.at))
  return (id: SwipeActionId, m: MessageSummary): MailVerb | null => {
    const snooze = (label: string) => () => {
      const o = snoozeOptions().find((x) => x.label === label)
      if (o) triage.snooze(m, o.until, o.label)
    }
    switch (id) {
      case "none":
        return null
      case "read":
        return { icon: m.seen ? "email--new" : "view", label: m.seen ? "Unread" : "Read", tone: PRIMARY, onCommit: () => triage.toggleSeen(m) }
      case "archive":
        return { icon: m.archived ? "reset" : "archive", label: m.archived ? "Inbox" : "Archive", tone: PRIMARY, onCommit: () => triage.toggleArchive(m) }
      case "star":
        return { icon: "star", label: m.flagged ? "Unstar" : "Star", tone: NEUTRAL, onCommit: () => triage.toggleFlag(m) }
      case "snooze-tomorrow":
        return { icon: "time", label: "Tomorrow", tone: NEUTRAL, onCommit: snooze("Tomorrow") }
      case "snooze-next-week":
        return { icon: "time", label: "Next week", tone: NEUTRAL, onCommit: snooze("Next week") }
      case "remind":
        return {
          icon: "notification",
          label: "Remind",
          tone: NEUTRAL,
          onCommit: () =>
            followUp.mutate(
              { threadId: m.threadId, at: inThreeDays() },
              { onSuccess: () => toast.success("If nobody replies, this comes back in 3 days"), onError: (e) => toast.error(e.message) },
            ),
        }
      case "newsletters":
        return { icon: "blog", label: "Newsletters", tone: NEUTRAL, onCommit: () => senders.move(m.from, "newsletters") }
    }
  }
}
