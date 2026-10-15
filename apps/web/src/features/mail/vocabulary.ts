import { toast } from "sonner"

import type { IconName } from "@/components/icon"
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
 * action is called in Settings, and the key that does the same thing on a
 * keyboard, so a gesture is never the only way in.
 */
export const SWIPE_CHOICES: { id: SwipeActionId; label: string; key?: string }[] = [
  { id: "read", label: "Read / unread", key: "U" },
  { id: "archive", label: "Archive", key: "E" },
  { id: "star", label: "Star", key: "S" },
  { id: "snooze-tomorrow", label: "Snooze until tomorrow", key: "H" },
  { id: "snooze-next-week", label: "Snooze until next week" },
  { id: "remind", label: "Remind me in 3 days if nobody replies" },
  { id: "newsletters", label: "Always in Newsletters" },
  { id: "none", label: "Nothing" },
]

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
        return { icon: m.seen ? "mark_email_unread" : "drafts", label: m.seen ? "Unread" : "Read", tone: "bg-vertical-mail", onCommit: () => triage.toggleSeen(m) }
      case "archive":
        return { icon: m.archived ? "unarchive" : "archive", label: m.archived ? "Inbox" : "Archive", tone: "bg-vertical-contacts", onCommit: () => triage.toggleArchive(m) }
      case "star":
        return { icon: "star", label: m.flagged ? "Unstar" : "Star", tone: "bg-vertical-calendar", onCommit: () => triage.toggleFlag(m) }
      case "snooze-tomorrow":
        return { icon: "snooze", label: "Tomorrow", tone: "bg-vertical-notes", onCommit: snooze("Tomorrow") }
      case "snooze-next-week":
        return { icon: "snooze", label: "Next week", tone: "bg-vertical-notes", onCommit: snooze("Next week") }
      case "remind":
        return {
          icon: "notifications",
          label: "Remind",
          tone: "bg-vertical-mail",
          onCommit: () =>
            followUp.mutate(
              { threadId: m.threadId, at: inThreeDays() },
              { onSuccess: () => toast.success("If nobody replies, this comes back in 3 days"), onError: (e) => toast.error(e.message) },
            ),
        }
      case "newsletters":
        return { icon: "newspaper", label: "Newsletters", tone: "bg-vertical-contacts", onCommit: () => senders.move(m.from, "newsletters") }
    }
  }
}
