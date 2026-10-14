// The web demo's copy of the core's signature reader (crates/core/src/signature.rs).
// The same rules, so the demo suggests what the apps would; the Rust tests
// are the reference.

import type { ContactField, SignatureCard } from "./types"

const SIGN_OFFS = new Set([
  "best", "best regards", "best wishes", "kind regards", "regards", "warm regards", "warmly", "thanks", "thank you", "many thanks", "cheers", "sincerely", "yours",
  "all the best", "talk soon", "take care", "thx",
])

const TITLE_WORDS = new Set([
  "manager", "lead", "director", "engineer", "designer", "founder", "co-founder", "ceo", "cto", "cfo", "coo", "head", "vp", "president", "officer", "consultant",
  "developer", "partner", "analyst", "specialist", "coordinator", "owner", "associate", "principal", "architect", "producer", "editor", "writer", "researcher",
  "scientist", "professor", "student", "intern", "assistant", "advisor", "strategist", "administrator", "recruiter", "attorney", "counsel", "nurse", "doctor",
])

const isSignOff = (line: string) => SIGN_OFFS.has(line.trim().replace(/[,!.]+$/, "").replace(/^[—–\-\s]+/, "").toLowerCase())
const isTitle = (line: string) => line.toLowerCase().split(/[^\p{L}\p{N}-]+/u).some((w) => TITLE_WORDS.has(w))
const digits = (s: string) => s.replace(/\D/g, "")
const isLink = (s: string) => /^(https?:\/\/|www\.|linkedin\.)/i.test(s) || /\.com\//i.test(s)

function looksLikeName(line: string) {
  const words = line.split(/\s+/).filter(Boolean)
  return words.length >= 2 && words.length <= 4 && line.length <= 40 && !isTitle(line) && words.every((w) => /^\p{Lu}[\p{L}'’.-]*$/u.test(w))
}

function emailIn(s: string): string | null {
  for (const raw of s.split(/[\s<>()[\],;:]+/)) {
    const t = raw.replace(/^[."']+|[."']+$/g, "")
    const [user, host, extra] = t.split("@")
    if (extra === undefined && user && host && host.includes(".") && !host.startsWith(".") && !host.endsWith(".") && !t.includes("..")) return t.toLowerCase()
  }
  return null
}

function phoneIn(s: string): ContactField | null {
  let label = ""
  let number = s.trim()
  const keyed = /^([\p{L} ]{1,8})[:.](.*)$/u.exec(s)
  const word = /^(mobile|cell|office|work|tel|phone|direct|fax)\s+(.*)$/i.exec(s)
  if (keyed) [label, number] = [keyed[1]!.trim().toLowerCase(), keyed[2]!.trim()]
  else if (word) [label, number] = [word[1]!.toLowerCase(), word[2]!.trim()]
  if (label === "fax" || label === "f") return null
  const shape = /^[\d\s+()\-./x]+$/.test(number) || /ext/i.test(number)
  const d = digits(number).length
  if (d < 7 || d > 15 || !shape) return null
  const kind = ["m", "mob", "mobile", "cell", "c"].includes(label)
    ? "cell"
    : ["o", "office", "w", "work", "d", "direct", "t", "tel", "phone", "p", "ph"].includes(label)
      ? "work"
      : ["h", "home"].includes(label)
        ? "home"
        : null
  return { label: kind, value: number }
}

function splitRole(line: string): [string, string] | null {
  for (const sep of [" | ", " at ", " @ ", " — ", " – ", " - ", ", "]) {
    const i = line.indexOf(sep)
    if (i > 0) {
      const [a, b] = [line.slice(0, i).trim(), line.slice(i + sep.length).trim()]
      if (a && b) return [a, b]
    }
  }
  return null
}

/** The signature lines, and whether a `-- ` line or a sign-off marked them. */
function block(body: string): [string[], boolean] {
  const lines: string[] = []
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim()
    if (t.startsWith(">") || t.startsWith("-----Original Message") || (t.startsWith("On ") && t.endsWith("wrote:")) || t.startsWith("---------- Forwarded")) break
    lines.push(line.trimEnd())
  }
  while (lines.length && !lines.at(-1)!.trim()) lines.pop()
  const tail = (from: number) => lines.slice(from).map((l) => l.trim()).filter(Boolean).slice(0, 10)
  const dash = lines.findLastIndex((l) => l === "-- " || l.trim() === "--")
  if (dash >= 0) return [tail(dash + 1), true]
  const off = lines.findLastIndex(isSignOff)
  if (off >= 0) return [tail(off + 1), true]
  const start = lines.findLastIndex((l) => !l.trim()) + 1
  const last = tail(start)
  return last.length && last.length <= 6 && start > 0 ? [last, false] : [[], false]
}

export function parseSignature(text: string, sender?: string | null): SignatureCard {
  const card: SignatureCard = { fullName: "", org: null, title: null, emails: [], phones: [] }
  const rest: string[] = []
  const from = sender?.trim() && !sender.includes("@") ? sender.trim() : null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^[—–\-*\s]+/, "").trim()
    if (!line || isSignOff(line)) continue
    const leftover: string[] = []
    for (const part of line.split(/[|·•]/).map((p) => p.trim()).filter(Boolean)) {
      const email = emailIn(part)
      const phone = email ? null : phoneIn(part)
      if (email) {
        if (!card.emails.some((e) => e.value.toLowerCase() === email)) card.emails.push({ label: null, value: email })
      } else if (phone) {
        if (!card.phones.some((p) => digits(p.value) === digits(phone.value))) card.phones.push(phone)
      } else if (!isLink(part) && !/\d/.test(part)) leftover.push(part)
    }
    if (leftover.length) rest.push(leftover.join(" | "))
  }
  const first = from?.split(/\s+/)[0]
  let at = rest.findIndex((l) => (from && l.toLowerCase() === from.toLowerCase()) || (first && l.toLowerCase() === first.toLowerCase()))
  if (at < 0) at = rest.findIndex(looksLikeName)
  if (at >= 0 && at < 3) {
    const [line] = rest.splice(at, 1)
    card.fullName = line!.includes(" ") ? line! : (from ?? line!)
    rest.splice(0, at)
  } else card.fullName = from ?? ""
  const [a, b] = rest
  if (a) {
    const split = splitRole(a)
    if (split) [card.title, card.org] = split
    else if (b) [card.title, card.org] = [a, b]
    else if (isTitle(a)) card.title = a
    else card.org = a
  }
  return card
}

const isEmpty = (c: SignatureCard) => !c.emails.length && !c.phones.length && !c.org && !c.title

/** A signature at the end of a message, or null if it has nothing useful. */
export function signatureFromMessage(body: string, sender?: string | null): SignatureCard | null {
  const [lines, marked] = block(body)
  if (!lines.length) return null
  const card = parseSignature(lines.join("\n"), sender)
  return !isEmpty(card) && (marked || card.emails.length || card.phones.length) ? card : null
}
