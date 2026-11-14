import { Badge, Highlight, Icon, ListRow } from "@unicron/ui"
import type { Lane, MessageSummary } from "@/core/types"
import { shortTime } from "@/lib/time"

import { displayName } from "./format"

export interface MessageRowProps {
  message: MessageSummary
  onOpen: () => void
  /** The conversation open beside the list. */
  selected?: boolean
  /** The lane the row is listed in: Snoozed and Waiting show when it comes back, in place of when it came. */
  lane?: Lane
  /** The time now, in seconds, to tell a follow-up that has come due. Without it, none shows as due. */
  now?: number
  /** Which account the message came to, where more than one is listed together. */
  account?: string
  /** The words a search matched: marked in the subject and the preview. */
  query?: string
}

/**
 * A conversation as a row (ADR-0085): the core's `MessageSummary` on
 * unicron's message row, with the data the core has today and nothing else.
 * Search lists with it; a mail lane that adopts it adds what it needs (swipes
 * around it, a menu) as optional props, and never a second row of its own.
 */
export function MessageRow({ message: m, onOpen, selected, lane, now, account, query }: MessageRowProps) {
  // Your own mail says who it went to.
  const sentTo = m.mailbox === "Sent" ? m.sentTo : null
  // A follow-up that came due brings your own message back to the inbox.
  const nudged = (lane === undefined || lane === "inbox") && now !== undefined && m.followUpAt != null && m.followUpAt <= now
  const at = lane === "snoozed" && m.snoozedUntil ? m.snoozedUntil : lane === "waiting" && m.followUpAt ? m.followUpAt : nudged ? Math.max(m.followUpAt!, m.sortAt) : m.sortAt
  const subject = m.subject || "(no subject)"
  return (
    <ListRow
      layout="message"
      selected={selected}
      onClick={onOpen}
      unread={!m.seen}
      sender={sentTo ? `To ${sentTo}` : displayName(m.from)}
      count={m.threadCount > 1 ? m.threadCount : undefined}
      tag={nudged ? <Badge>No reply yet</Badge> : undefined}
      marks={
        m.flagged || m.hasAttachments ? (
          <>
            {m.flagged && <Icon name="star--filled" size="sm" label="Starred" />}
            {m.hasAttachments && <Icon name="attachment" tone="muted" size="sm" label="Has attachments" />}
          </>
        ) : undefined
      }
      account={account}
      time={shortTime(at)}
      subject={query ? <Highlight text={subject} query={query} /> : subject}
      preview={m.preview ? query ? <Highlight text={m.preview} query={query} /> : m.preview : undefined}
    />
  )
}
