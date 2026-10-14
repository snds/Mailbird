import type { Category, Lane } from "@/core/types"

/** A lane of conversations, or the outbox's scheduled messages. */
export type MailTab = Lane | "scheduled"

export const LANES: { id: MailTab; label: string; empty: string }[] = [
  { id: "inbox", label: "Inbox", empty: "You're all caught up." },
  { id: "screener", label: "Screener", empty: "No new senders waiting. Mail from people writing for the first time shows up here." },
  { id: "unread", label: "Unread", empty: "Nothing unread." },
  { id: "starred", label: "Starred", empty: "Star messages to keep them close." },
  { id: "snoozed", label: "Snoozed", empty: "Snoozed mail waits here until it's time." },
  { id: "waiting", label: "Waiting", empty: "Mail you're waiting on a reply to. Set a reminder when you send." },
  { id: "scheduled", label: "Scheduled", empty: "Nothing scheduled." },
  { id: "archive", label: "Archive", empty: "Archived mail shows up here." },
]

/** The inbox's filter chips (Spark's smart inbox). */
export const CATEGORIES: { id: Category; label: string; empty: string }[] = [
  { id: "people", label: "People", empty: "No mail from people." },
  { id: "updates", label: "Updates", empty: "No receipts, alerts, or notifications." },
  { id: "newsletters", label: "Newsletters", empty: "No newsletters." },
]
