import type { Address, Draft, MessageDetail } from "@/core/types"
import { longTime } from "@/lib/time"

/** Seconds between pressing Send and the message leaving. */
export const UNDO_SECONDS = 10

export const displayName = (a: Address) => a.name?.trim() || a.email

export const initials = (a: Address) =>
  displayName(a)
    .split(/[\s@.]+/)
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase())
    .slice(0, 2)
    .join("")

/** "Ana <ana@x.com>, sam@y.com; …" → addresses. */
export function parseRecipients(text: string): Address[] {
  return text
    .split(/[,;\n]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const m = part.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/)
      return m ? { name: m[1]!.trim() || null, email: m[2]!.trim() } : { name: null, email: part }
    })
}

export const formatRecipients = (list: Address[] = []) =>
  list.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(", ")

export function replyDraft(m: MessageDetail): Partial<Draft> {
  const quoted = m.bodyText
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n")
  return {
    accountId: m.accountId,
    to: [m.from],
    subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`,
    body: `\n\nOn ${longTime(m.date)}, ${displayName(m.from)} wrote:\n${quoted}`,
    inReplyTo: m.messageId,
  }
}

export function forwardDraft(m: MessageDetail): Partial<Draft> {
  return {
    accountId: m.accountId,
    subject: /^fwd?:/i.test(m.subject) ? m.subject : `Fwd: ${m.subject}`,
    body: `\n\n---------- Forwarded message ----------\nFrom: ${displayName(m.from)} <${m.from.email}>\nDate: ${longTime(m.date)}\nSubject: ${m.subject}\n\n${m.bodyText}`,
  }
}
