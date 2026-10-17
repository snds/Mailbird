import type { NoteShare, ShareMode } from "@/core/types"
import { fromBase64, toBase64 } from "@/lib/base64"

/**
 * Share links (ADR-0056). A link is the owner's relay, as https, at
 * `/share`, with everything Mailbird needs after the `#`:
 *
 *   https://notes.example.com/share#<base64url JSON>
 *
 * Browsers never send the part after `#`, so the token in it only travels
 * where the link itself goes. Opened in a browser, the relay's `/share` page
 * explains how to open it in Mailbird.
 */
export interface ShareLink {
  v: 1
  /** The owner's relay, as Mailbird connects to it (wss://…). */
  relay: string
  id: string
  mode: ShareMode
  token: string
  title: string
  /** Who shared it, as their accounts name them. */
  from: string | null
  /** What it opens: a note (ADR-0056), or a conversation shared with teammates (ADR-0060). */
  kind: "note" | "thread"
  /** The share's key when it's end-to-end encrypted (ADR-0062). */
  k?: string
}

const b64url = (bytes: Uint8Array) => toBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
const unb64url = (s: string) => fromBase64(s.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (s.length % 4)) % 4))

/** The token a share's link carries: the relay checks it the same way (tools/notes-relay). */
export async function shareToken(relayToken: string, id: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey("raw", enc.encode(relayToken), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  return `s1.${b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`share:${id}`))))}`
}

/** Where a link points: the relay's own address, made https. */
function pageOf(relay: string): string {
  const u = new URL(relay)
  u.protocol = u.protocol === "ws:" ? "http:" : "https:"
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/share`
  u.search = ""
  u.hash = ""
  return u.toString()
}

export function shareUrl(link: Omit<ShareLink, "v" | "kind"> & { kind?: ShareLink["kind"] }): string {
  // A note's link leaves `kind` out, so links from before conversations read the same; a plain one leaves out `k`.
  const { kind, k, ...rest } = link
  const body = { v: 1 as const, ...rest, ...(kind === "thread" ? { kind } : {}), ...(k ? { k } : {}) }
  return `${pageOf(link.relay)}#${b64url(new TextEncoder().encode(JSON.stringify(body)))}`
}

/** A share link's contents, or `null` when the text isn't one. */
export function parseShareUrl(text: string): ShareLink | null {
  const m = /https?:\/\/[^\s#<>"]+\/share#([A-Za-z0-9_-]{16,})/.exec(text.trim())
  if (!m) return null
  try {
    const j = JSON.parse(new TextDecoder().decode(unb64url(m[1]))) as Partial<ShareLink>
    if (j.v !== 1 || typeof j.relay !== "string" || !/^wss?:\/\//.test(j.relay) || typeof j.id !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(j.id) || typeof j.token !== "string" || !j.token) return null
    return { v: 1, relay: j.relay, id: j.id, mode: j.mode === "view" ? "view" : "edit", token: j.token, title: typeof j.title === "string" ? j.title : "", from: typeof j.from === "string" && j.from.trim() ? j.from.trim() : null, kind: j.kind === "thread" ? "thread" : "note", ...(typeof j.k === "string" && /^[A-Za-z0-9_-]{43}$/.test(j.k) ? { k: j.k } : {}) }
  } catch {
    return null
  }
}

/** Every share link in a message, once each. */
export function shareLinksIn(text: string): ShareLink[] {
  const out: ShareLink[] = []
  for (const m of text.matchAll(/https?:\/\/[^\s#<>"]+\/share#[A-Za-z0-9_-]{16,}/g)) {
    const l = parseShareUrl(m[0])
    if (l && !out.some((o) => o.id === l.id)) out.push(l)
  }
  return out
}

/** The guest's side of a link, as the core keeps it. */
export const guestShareOf = (l: ShareLink): NoteShare => ({ id: l.id, role: "guest", mode: l.mode, revoked: false, relay: l.relay, token: l.token, from: l.from, ...(l.k ? { key: l.k } : {}) })

/** The note's text document on its relay. */
export const sharedDocName = (shareId: string) => `mailbird/shared/${shareId}`

/** An owner's share that's live (not stopped). */
export const activeOwnerShare = (s: NoteShare | null | undefined): boolean => !!s && s.role === "owner" && !s.revoked
