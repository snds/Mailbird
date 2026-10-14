import type { Lane } from "@/core/types"

/** A lane of conversations, or the outbox's scheduled messages. */
export type MailTab = Lane | "scheduled"

export const LANES: { id: MailTab; label: string; empty: string }[] = [
  { id: "inbox", label: "Inbox", empty: "You're all caught up." },
  { id: "unread", label: "Unread", empty: "Nothing unread." },
  { id: "starred", label: "Starred", empty: "Star messages to keep them close." },
  { id: "snoozed", label: "Snoozed", empty: "Snoozed mail waits here until it's time." },
  { id: "waiting", label: "Waiting", empty: "Mail you're waiting on a reply to. Set a reminder when you send." },
  { id: "scheduled", label: "Scheduled", empty: "Nothing scheduled." },
  { id: "archive", label: "Archive", empty: "Archived mail shows up here." },
]
