import type { Address, Draft, MessageDetail } from "@/core/types"
import { longTime } from "@/lib/time"

import { escapeHtml, textToHtml } from "./rich-text"

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
  const intro = `On ${longTime(m.date)}, ${displayName(m.from)} wrote:`
  return {
    accountId: m.accountId,
    to: [m.from],
    subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`,
    body: `\n\n${intro}\n${quoted}`,
    // The quote is rebuilt from the text part: the sender's HTML is untrusted
    // and the editor's schema would drop most of it anyway.
    bodyHtml: `<p></p><p>${escapeHtml(intro)}</p><blockquote>${textToHtml(m.bodyText.trimEnd())}</blockquote>`,
    inReplyTo: m.messageId,
    references: m.references,
  }
}

/** The message a Reply answers: the newest one you didn't send yourself. */
export function replyTarget(thread: MessageDetail[]) {
  return [...thread].reverse().find((m) => m.mailbox !== "Sent") ?? thread.at(-1)
}

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function forwardDraft(m: MessageDetail): Partial<Draft> {
  const header = [
    "---------- Forwarded message ----------",
    `From: ${displayName(m.from)} <${m.from.email}>`,
    `Date: ${longTime(m.date)}`,
    `Subject: ${m.subject}`,
  ]
  return {
    accountId: m.accountId,
    subject: /^fwd?:/i.test(m.subject) ? m.subject : `Fwd: ${m.subject}`,
    body: `\n\n${header.join("\n")}\n\n${m.bodyText}`,
    bodyHtml: `<p></p><p></p>${textToHtml(header.join("\n"))}<p></p>${textToHtml(m.bodyText.trimEnd())}`,
  }
}
