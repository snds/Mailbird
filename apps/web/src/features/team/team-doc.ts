import * as Y from "yjs"

import type { MessageDetail } from "@/core/types"

/**
 * A shared conversation's document (ADR-0060), `mailbird/shared/<id>`:
 *
 * - `meta`: the subject, and who shared it;
 * - `messages`: the owner's copy of the conversation, each message's own words;
 * - `comments`: the team's notes beside it, never sent to anyone;
 * - `draft`: the reply they write together (a Tiptap document). Only the owner sends it.
 */
export interface TeamMessage {
  id: string
  from: string
  email: string
  date: number
  text: string
  /** Sent by the person who shared the conversation. */
  byOwner: boolean
}

export interface TeamComment {
  id: string
  author: string
  at: number
  text: string
}

export interface TeamSnapshot {
  subject: string
  from: string | null
  messages: TeamMessage[]
  comments: TeamComment[]
}

export const DRAFT_FIELD = "draft"

const meta = (doc: Y.Doc) => doc.getMap<string>("meta")
const messages = (doc: Y.Doc) => doc.getArray<TeamMessage>("messages")
const comments = (doc: Y.Doc) => doc.getArray<TeamComment>("comments")

export function snapshot(doc: Y.Doc): TeamSnapshot {
  return {
    subject: meta(doc).get("subject") ?? "",
    from: meta(doc).get("from") ?? null,
    messages: messages(doc).toArray(),
    comments: comments(doc).toArray(),
  }
}

/** A message's own words: quoted earlier messages are already in the conversation. */
export function ownWords(text: string): string {
  const out: string[] = []
  for (const line of text.split("\n")) {
    const t = line.trim()
    if (/^-{3,}\s*Original Message/i.test(t) || /^-{3,}\s*Forwarded/i.test(t) || (/^On .+/.test(t) && t.endsWith("wrote:"))) break
    if (t.startsWith(">")) continue
    out.push(line.trimEnd())
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim()
}

/** The owner brings the copy up to date: new messages are added, nothing is removed. */
export function syncMessages(doc: Y.Doc, thread: MessageDetail[], ownerAddress: string | null, from: string | null) {
  const arr = messages(doc)
  const have = new Set(arr.toArray().map((m) => m.id))
  const add = thread
    .slice()
    .sort((a, b) => a.date - b.date)
    .filter((m) => !have.has(m.id))
    .map<TeamMessage>((m) => ({
      id: m.id,
      from: m.mailbox === "Sent" || (ownerAddress && m.from.email.toLowerCase() === ownerAddress.toLowerCase()) ? (from ?? "Me") : (m.from.name ?? m.from.email),
      email: m.from.email,
      date: m.date,
      text: ownWords(m.bodyText),
      byOwner: m.mailbox === "Sent" || (!!ownerAddress && m.from.email.toLowerCase() === ownerAddress.toLowerCase()),
    }))
  const subject = thread.at(-1)?.subject ?? ""
  if (!add.length && meta(doc).get("subject") === subject && meta(doc).get("from") === (from ?? "")) return
  doc.transact(() => {
    if (add.length) arr.push(add)
    if (meta(doc).get("subject") !== subject) meta(doc).set("subject", subject)
    if (meta(doc).get("from") !== (from ?? "")) meta(doc).set("from", from ?? "")
  }, "owner")
}

export function addComment(doc: Y.Doc, author: string, text: string) {
  const t = text.trim()
  if (!t) return
  comments(doc).push([{ id: crypto.randomUUID(), author, at: Math.floor(Date.now() / 1000), text: t }])
}

/** Takes back a comment you wrote. */
export function removeComment(doc: Y.Doc, id: string) {
  const arr = comments(doc)
  const i = arr.toArray().findIndex((c) => c.id === id)
  if (i >= 0) arr.delete(i, 1)
}
