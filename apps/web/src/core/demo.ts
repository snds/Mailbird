import type { CoreClient, CoreEvent } from "./client"
import type {
  Account, AttachmentInfo, Capabilities, Draft, Lane, MessageDetail, MessageQuery, MessageSummary, OAuthClientInfo, OAuthIssuer, OutboxItem, Provider, PushSettings,
  Signature, Template, Category, Sender, SenderDecision,
  Split,
  SplitInput,
  SwipeActions,
  MailPrefs,
  KeyBindings,
  LocalTime,
} from "./types"
import { DEFAULT_KEYS, KEY_COMMANDS, keyProblem, mergedKeys } from "@/lib/keys"
import { createDemoAi } from "./demo-ai"
import { createDemoTeam } from "./demo-team"
import { createDemoNotes } from "./demo-notes"
import { createDemoPim, type DemoInviteSeed } from "./demo-pim"
import { signatureFromMessage } from "./demo-signature"
import { downloadVcard } from "@/lib/download"

// An in-memory stand-in for the Rust core, so the web build is usable before
// the gateway exists. It follows the same rules as crates/core/src/store.rs:
// conversations, lanes (Sent copies never fill the inbox), snooze wake-ups
// (unread, back on top), thread-level triage, an undo-send window, scheduled
// sends, and follow-up reminders keyed by Message-ID (ADR-0017).

const now = () => Math.floor(Date.now() / 1000)
const HOUR = 3600
const SENT = "Sent"

const CAPABILITIES: Record<Provider, Capabilities> = {
  google: { mail: true, calendar: true, contacts: true, notes: "import_only", mail_organization: "labels", contact_groups: true, server_side_scheduling: true, push: true, auth: "o_auth2" },
  microsoft: { mail: true, calendar: true, contacts: true, notes: "unsupported", mail_organization: "folders", contact_groups: true, server_side_scheduling: true, push: true, auth: "o_auth2" },
  i_cloud: { mail: true, calendar: true, contacts: true, notes: "import_only", mail_organization: "folders", contact_groups: true, server_side_scheduling: false, push: true, auth: "app_password" },
  jmap: { mail: true, calendar: true, contacts: true, notes: "unsupported", mail_organization: "labels", contact_groups: true, server_side_scheduling: false, push: true, auth: "password" },
  generic: { mail: true, calendar: false, contacts: false, notes: "unsupported", mail_organization: "folders", contact_groups: false, server_side_scheduling: false, push: false, auth: "password" },
  local: { mail: false, calendar: true, contacts: true, notes: "native", mail_organization: null, contact_groups: true, server_side_scheduling: false, push: false, auth: "none" },
}

/** A small solid-color PNG, so sample image attachments open as real files. */
function swatch(r: number, g: number, b: number): string {
  if (typeof document === "undefined") return ""
  const c = document.createElement("canvas")
  c.width = c.height = 64
  const ctx = c.getContext("2d")
  if (!ctx) return ""
  ctx.fillStyle = `rgb(${r},${g},${b})`
  ctx.fillRect(0, 0, 64, 64)
  return c.toDataURL("image/png").split(",")[1] ?? ""
}

/** A one-page PDF (a sample ferry booking), so the PDF preview has something real to show. */
const PDF = "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA0MjAgMjk3XSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCAxNTggPj4Kc3RyZWFtCkJUIC9GMSAyMCBUZiAzNiAyNDAgVGQgKEJvb2tpbmcgY29uZmlybWVkKSBUaiAvRjEgMTIgVGYgMCAtMzIgVGQgKFNhdHVyZGF5IDA4OjE1IC0gUGllciAzIC0gUmVmIEZYLTIyMTApIFRqIDAgLTIwIFRkIChWZWhpY2xlIHVuZGVyIDUgbSwgdHdvIHBhc3NlbmdlcnMpIFRqIEVUCmVuZHN0cmVhbQplbmRvYmoKNSAwIG9iago8PCAvVHlwZSAvRm9udCAvU3VidHlwZSAvVHlwZTEgL0Jhc2VGb250IC9IZWx2ZXRpY2EgPj4KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAxMTUgMDAwMDAgbiAKMDAwMDAwMDI0MSAwMDAwMCBuIAowMDAwMDAwNDUwIDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgNiAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKNTIwCiUlRU9GCg=="

interface DemoMessage extends MessageDetail {
  /** Attachment payloads (base64) for openAttachment. */
  files: Record<string, string>
  /** The meeting invitation this message carries, if any. */
  inviteSeed?: DemoInviteSeed
  /** The sender's UTC offset in minutes, from the Date header (ADR-0040). */
  tzOffset?: number | null
}

/** Where the demo's people write from: Bengaluru, Toronto, Lisbon, New York. */
const SENDER_TZ: Record<string, number> = { "priya@studio.example": 330, "marcus@example.com": -240, "ana@example.com": 60, "sam@example.com": -240 }

function seed(): { accounts: Account[]; messages: DemoMessage[]; followUps: Map<string, number> } {
  const t = now()
  const server = { host: "demo.invalid", port: 993, security: "tls" as const }
  const account = (id: string, displayName: string, address: string): Account => ({
    id, displayName, address, username: address, provider: "generic",
    imap: server, smtp: { ...server, port: 465 }, lastSync: t, lastError: null,
    dav: { calendarUrl: "https://demo.invalid/", contactsUrl: "https://demo.invalid/" }, davLastSync: t, davError: null,
  })
  const accounts = [account("personal", "Personal", "me@personal.example"), account("work", "Work", "me@studio.example")]
  const me = (acct: string) => ({ name: "Me", email: accounts.find((a) => a.id === acct)!.address })
  let n = 0
  const msg = (
    accountId: string, from: { name: string | null; email: string }, subject: string, body: string,
    ago: number, extra: Partial<DemoMessage> & { files?: Record<string, string> } = {},
  ): DemoMessage => {
    const date = t - ago
    const id = `demo-${++n}`
    return {
      id, accountId, threadId: extra.threadId ?? id, threadCount: 1, hasAttachments: false,
      from, subject, preview: body.replace(/\s+/g, " ").slice(0, 160), date, sortAt: date,
      seen: false, flagged: false, archived: false, snoozedUntil: null, mailbox: "INBOX",
      to: [me(accountId)], cc: [], messageId: `${id}@demo.example`, bodyText: body, bodyHtml: null,
      attachments: [], references: [], files: {}, tzOffset: SENDER_TZ[from.email] ?? null, ...extra,
    }
  }
  const file = (id: string, filename: string, mimeType: string, data: string): AttachmentInfo & { data: string } => ({
    id, filename, mimeType, size: Math.floor((data.length * 3) / 4), inline: false, data,
  })
  const withFiles = (list: (AttachmentInfo & { data: string })[]) => ({
    attachments: list.map(({ data: _d, ...info }) => info),
    files: Object.fromEntries(list.map((f) => [f.id, f.data])),
    hasAttachments: list.length > 0,
  })

  const priya = { name: "Priya Raman", email: "priya@studio.example" }
  const marcus = { name: "Marcus Lee", email: "marcus@example.com" }

  return {
    accounts,
    messages: [
      // A meeting invitation (iMIP): answering it adds the event to Work.
      msg("work", priya, "Invitation: Design crit", "Priya Raman invited you to “Design crit”. Bring the token audit sheet.", 0.8 * HOUR, {
        inviteSeed: (() => {
          const d = new Date()
          d.setDate(d.getDate() + 2)
          d.setHours(14, 0, 0, 0)
          const start = Math.floor(d.getTime() / 1000)
          return {
            uid: "crit-1@studio.example", title: "Design crit", location: "Studio, room 2", start, end: start + HOUR,
            notes: "Hybrid: room 2, or join online.\n\nJoin with Google Meet\nhttps://meet.google.com/xyz-abcd-efg\nJoin by phone\n(US) +1 252-555-0142 PIN: 381 442 907#",
            organizer: priya,
            attendees: [
              { ...priya, status: "accepted" },
              { name: "Me", email: "me@studio.example", status: "needs-action" },
              { name: "Sam Okafor", email: "sam@studio.example", status: "tentative" },
            ],
          }
        })(),
      }),
      // A three-message conversation, including my own reply.
      msg("work", priya, "Token audit", "Kicking off the audit. First pass: the semantic tier has a few aliases pointing at the wrong primitives.", 2 * 24 * HOUR, { threadId: "t-audit", seen: true }),
      msg("work", me("work"), "Re: Token audit", "Great — can you pull them into one sheet so we can see the drift?", 26 * HOUR, { threadId: "t-audit", seen: true, mailbox: SENT, to: [priya] }),
      msg("work", priya, "Re: Token audit",
        "Hi,\n\nI pulled the semantic tier into a single sheet so we can see where the aliases drift from the primitives. Three of the surface tokens resolve to the same value in dark mode, which is probably why the list pane feels flat.\n\nCan we review Thursday?\n\nPriya",
        0.3 * HOUR, { threadId: "t-audit", flagged: true }),
      msg("personal", { name: "Ferry Line", email: "no-reply@ferry.example" }, "Your booking is confirmed",
        "Saturday 08:15 crossing, vehicle under 5 m, two passengers. Arrive 30 minutes before departure. Your confirmation is attached.",
        1.6 * HOUR, withFiles([
          file("att-ferry", "booking-confirmation.pdf", "application/pdf", PDF),
          file("att-ferry-txt", "what-to-bring.txt", "text/plain", btoa("Passports\nBooking reference FX-2210\nSnacks for the crossing\n")),
        ])),
      msg("personal", me("personal"), "Cabin weekend", "Who's in for the cabin on the 24th? Ferry is at 8:15.", 2 * 24 * HOUR, { threadId: "t-cabin", seen: true, mailbox: SENT, to: [marcus] }),
      msg("personal", marcus, "Re: Cabin weekend", "Count me in. I'll bring the board games and the good coffee.\n\n— M", 20 * HOUR, { threadId: "t-cabin", seen: true }),
      msg("personal", { name: "Design Systems Weekly", email: "digest@dsweekly.example" }, "Issue 212: Variable fonts in production",
        "This week: shipping icon fonts with live axes, plus a look at density modes.", 2 * 24 * HOUR, {
          seen: true,
          unsubscribe: { oneClick: "https://dsweekly.example/u/212", mailto: "mailto:leave@dsweekly.example", web: "https://dsweekly.example/u/212" },
          // Exercises the HTML path: the script must be stripped, the pixel blocked.
          bodyHtml: `<h2 style="margin:0 0 8px">Variable fonts in production</h2>
<p>This week: shipping icon fonts with <b>live axes</b>, plus a look at density modes.</p>
<img src="https://tracker.example/open.gif?u=123" width="1" height="1" alt="">
<script>document.body.innerHTML = "pwned"</script>
<p><a href="https://example.com/issue-212">Read the issue →</a></p>`,
        }),
      // `?newsletters`: a second newsletter, so the inbox bundles them.
      ...(new URLSearchParams(globalThis.location?.search ?? "").has("newsletters")
        ? [
            msg("personal", { name: "Clay Club", email: "news@clayclub.example" }, "October at the studio", "Open kiln nights are back on Thursdays.", 5 * HOUR, {
              unsubscribe: { oneClick: null, mailto: "mailto:leave@clayclub.example", web: null },
            }),
          ]
        : []),
      msg("personal", { name: "Ana Duarte", email: "ana@example.com" }, "Photos from the trip",
        "Finally sorted them. The lighthouse ones came out great — two favorites attached.\n\nAna Duarte\nLighthouse Studio\nm: +351 913 555 010", 3 * 24 * HOUR, {
          seen: true, flagged: true,
          ...withFiles([
            file("att-light", "lighthouse.png", "image/png", swatch(37, 99, 235)),
            file("att-dunes", "dunes.png", "image/png", swatch(217, 160, 72)),
          ]),
        }),
      msg("work", { name: "Sam Okafor", email: "sam@example.com" }, "Density modes proposal",
        "Attached the comfortable / compact spec. The list row drops to 56px in compact.\n\n-- \nSam Okafor\nEngineer | Studio\nm: +1 555 010 2200", 4 * 24 * HOUR, { seen: true, archived: true }),
      // `?counter`: Sam proposes another time for a meeting you organize.
      ...(new URLSearchParams(globalThis.location?.search ?? "").has("counter")
        ? [
            msg("work", { name: "Sam Okafor", email: "sam@studio.example" }, "New time proposed: Studio sync", "Sam Okafor proposed a new time for “Studio sync”.", 0.2 * HOUR, {
              inviteSeed: (() => {
                const d = new Date()
                d.setDate(d.getDate() + 3)
                d.setHours(15, 0, 0, 0)
                const start = Math.floor(d.getTime() / 1000)
                return {
                  method: "counter" as const, uid: "sync-1@mailbird", title: "Studio sync", location: null, start, end: start + HOUR,
                  organizer: { name: "Me", email: "me@studio.example" },
                  attendees: [{ name: "Sam Okafor", email: "sam@studio.example", status: "tentative" }],
                  comment: "I'm at the kiln until 2. Could we do 3?",
                }
              })(),
            }),
          ]
        : []),
      // `?screener`: a first-time sender, waiting in the Screener (it's on).
      ...(new URLSearchParams(globalThis.location?.search ?? "").has("screener")
        ? [msg("personal", { name: "Riley Growth", email: "hi@growth.example" }, "Quick question about your studio", "Saw your work online. Do you have 15 minutes this week?\n\nThanks,\nRiley Park\nGrowth lead at Northwind\n+1 555 010 9000", 0.5 * HOUR)]
        : []),
      // `?shared=<link>`: Sam shares a note with you by link (ADR-0056).
      ...(new URLSearchParams(globalThis.location?.search ?? "").get("shared")
        ? [
            msg("work", { name: "Sam Okafor", email: "sam@studio.example" }, "Design review agenda", `I shared a note with you: “Design review agenda”.\n\nOpen it in Mailbird: ${new URLSearchParams(globalThis.location?.search ?? "").get("shared")}\n`, 0.1 * HOUR),
          ]
        : []),
      // Sent with a follow-up reminder that hasn't come due (the Waiting lane).
      msg("personal", me("personal"), "Quote for the kitchen shelves", "Hi Jo, could you send a quote for the oak shelves we talked about?", 22 * HOUR, {
        threadId: "t-quote", seen: true, mailbox: SENT, to: [{ name: "Jo Tanaka", email: "jo@joinery.example" }], messageId: "quote@demo.example",
      }),
    ],
    // `?nudge` makes it already due, to see a conversation a reminder brought back.
    followUps: new Map([["quote@demo.example", new URLSearchParams(globalThis.location?.search ?? "").has("nudge") ? t - HOUR : t + 2 * 24 * HOUR]]),
  }
}

/**
 * `?bulk=10000` adds that many older conversations, for testing long lists
 * (scrolling, paging) without an account. Capped at 50,000.
 */
function bulkMessages(): DemoMessage[] {
  const n = Math.min(Number(new URLSearchParams(globalThis.location?.search ?? "").get("bulk")) || 0, 50_000)
  const t = now()
  const senders = [{ name: "Priya Raman", email: "priya@studio.example" }, { name: "Marcus Lee", email: "marcus@example.com" }, { name: "Design Systems Weekly", email: "news@dsweekly.example" }, { name: null, email: "noreply@service.example" }]
  return Array.from({ length: n }, (_, i) => {
    const date = t - 5 * 24 * HOUR - i * 1800
    const id = `bulk-${i}`
    const from = senders[i % senders.length]!
    return {
      id, accountId: i % 3 ? "personal" : "work", threadId: id, threadCount: 1, hasAttachments: i % 7 === 0,
      from, subject: `Archive message ${i + 1}`, preview: `Older mail number ${i + 1}, for scrolling.`, date, sortAt: date,
      seen: i % 5 !== 0, flagged: i % 11 === 0, archived: false, snoozedUntil: null, mailbox: "INBOX",
      to: [{ name: "Me", email: "me@personal.example" }], cc: [], messageId: `${id}@demo.example`, bodyText: `Older mail number ${i + 1}.`, bodyHtml: null,
      attachments: [], references: [], files: {},
    }
  })
}

export function createDemoClient(): CoreClient {
  const state = seed()
  state.messages.push(...bulkMessages())
  const outbox = new Map<string, OutboxItem>()
  const { followUps } = state
  const templates: Template[] = [
    { id: "tpl-thanks", name: "Thanks, will reply soon", subject: "", html: "<p>Thanks for this — I'll get back to you by the end of the week.</p>", updated: now() },
  ]
  const signatures: Signature[] = []
  // The Screener and senders (ADR-0018), keyed by lowercased address.
  const senders = new Map<string, { decision: SenderDecision | null; category: Category | null; at: number }>()
  const screener = { since: new URLSearchParams(globalThis.location?.search ?? "").has("screener") ? now() - 0.75 * HOUR : (null as number | null) }
  const MACHINE = /^(no-?reply|do-?not-?reply|notifications?|notify|alerts?|receipts?|billing|orders|mailer-daemon|postmaster|bounces?)([+.].*)?$/
  const headerCategory = (m: MessageDetail): Category =>
    MACHINE.test(m.from.email.split("@")[0]!.toLowerCase()) ? "updates" : m.unsubscribe ? "newsletters" : "people"
  const key = (email: string) => email.trim().toLowerCase()
  const categoryOf = (m: MessageDetail): Category => (m.mailbox === SENT ? "people" : (senders.get(key(m.from.email))?.category ?? headerCategory(m)))
  const decisionOf = (m: MessageDetail) => senders.get(key(m.from.email))?.decision ?? null
  /** People you've written to are known, like the native core's `allowed` on send. */
  const wroteTo = (email: string) => state.messages.some((x) => x.mailbox === SENT && [...x.to, ...x.cc].some((a) => key(a.email) === key(email)))
  const screened = (m: MessageDetail) =>
    screener.since !== null && m.mailbox !== SENT && m.date >= screener.since && decisionOf(m) === null && !wroteTo(m.from.email)
  const kept = (m: MessageDetail) => decisionOf(m) !== "screened_out" && decisionOf(m) !== "blocked" && !screened(m)
  const followUpAt = (m: MessageDetail) => (m.mailbox === SENT && m.messageId ? (followUps.get(m.messageId) ?? null) : null)
  const listeners = new Map<CoreEvent, Set<(p?: unknown) => void>>()
  const emit = (e: CoreEvent, p?: unknown) => listeners.get(e)?.forEach((h) => h(p))
  const awake = (m: MessageDetail, t: number) => m.snoozedUntil === null || m.snoozedUntil <= t
  const thread = (threadId: string) => state.messages.filter((m) => m.threadId === threadId)
  const received = (threadId: string) => {
    const list = thread(threadId).filter((m) => m.mailbox !== SENT)
    if (!thread(threadId).length) throw new Error("that conversation is no longer here")
    return list
  }
  /** Message-IDs of your mail in a thread that carry a reminder. */
  const sentIn = (threadId: string) => thread(threadId).flatMap((m) => (m.mailbox === SENT && m.messageId && followUps.has(m.messageId) ? [m.messageId] : []))
  // Splits (ADR-0022): your own inbox tabs, by rule.
  let splits: Split[] = []
  let nSplits = 0
  const splitMatch = (s: SplitInput, m: MessageDetail) => {
    const from = key(m.from.email)
    const senders = s.senders.map(key).filter(Boolean)
    if (senders.length && !senders.some((x) => (x.startsWith("@") ? from.endsWith(x) || from.endsWith(`.${x.slice(1)}`) : from === x))) return false
    if (s.subject?.trim() && !m.subject.toLowerCase().includes(s.subject.trim().toLowerCase())) return false
    if (s.hasAttachments && !m.hasAttachments) return false
    if (s.accountId && m.accountId !== s.accountId) return false
    return true
  }
  const checkSplit = (input: SplitInput): SplitInput => {
    const r = { ...input, name: input.name.trim(), senders: input.senders.map((x) => x.trim().toLowerCase()).filter(Boolean), subject: input.subject?.trim() || null }
    if (!r.name) throw new Error("give the split a name")
    if (!r.senders.length && !r.subject && !r.hasAttachments && !r.accountId) throw new Error("say what goes in it: a sender, a domain, or subject words")
    const bad = r.senders.find((x) => !x.includes("@") || x.endsWith("@"))
    if (bad) throw new Error(`“${bad}” isn't an address or a domain like @example.com`)
    return r
  }
  /** Newsletters in the main inbox: what the bundle holds. */
  const bundleMessages = (accountId: string | null, t: number) => {
    const list = state.messages.filter((m) => (!accountId || m.accountId === accountId) && m.mailbox !== SENT && inLane(m, "inbox", t) && inMainInbox(m) && categoryOf(m) === "newsletters")
    const threads = new Map<string, MessageDetail[]>()
    for (const m of list) threads.set(m.threadId, [...(threads.get(m.threadId) ?? []), m])
    const newest = [...list].sort((a, b) => b.date - a.date)
    const senders = [...new Set(newest.map((m) => m.from.name || m.from.email))].slice(0, 3)
    return { list, threads: threads.size, unread: [...threads.values()].filter((ms) => ms.some((m) => !m.seen)).length, latest: newest[0]?.date ?? 0, senders }
  }
  /** The main inbox leaves out what exclusive splits take. */
  const inMainInbox = (m: MessageDetail) => !splits.some((s) => s.exclusive && splitMatch(s, m))
  const inLane = (m: MessageDetail, lane: Lane, t: number) => {
    const r = m.mailbox !== SENT
    const due = followUpAt(m)
    switch (lane) {
      case "inbox": return (r && !m.archived && awake(m, t) && kept(m)) || (due !== null && due <= t)
      case "screener": return !m.archived && screened(m)
      case "waiting": return due !== null && due > t
      case "unread": return r && !m.archived && !m.seen && awake(m, t) && kept(m)
      case "starred": return m.flagged
      case "snoozed": return r && m.snoozedUntil !== null && m.snoozedUntil > t
      case "archive": return r && m.archived
    }
  }
  const summary = ({ to: _t, cc: _c, messageId: _m, bodyText: _b, bodyHtml: _h, attachments: _a, references: _r, files: _f, inviteSeed: _i, invite: _v, unsubscribe: _u, ...s }: DemoMessage): MessageSummary => s
  // A reminder that came due sorts the conversation by when it came back.
  const rankAt = (m: MessageDetail, lane: Lane, t: number) => {
    const due = followUpAt(m)
    return lane === "inbox" && due !== null && due <= t ? Math.max(due, m.sortAt) : m.sortAt
  }

  // The same 1-second tick the native workers run.
  let checked = now()
  setInterval(() => {
    const t = now()
    let changed = false
    for (const due of followUps.values()) if (due > checked && due <= t) changed = true
    checked = t
    for (const m of state.messages) {
      if (m.snoozedUntil !== null && m.snoozedUntil <= t) {
        Object.assign(m, { snoozedUntil: null, sortAt: t, seen: false })
        changed = true
      }
    }
    for (const item of outbox.values()) {
      if (item.state === "queued" && item.sendAt <= t) {
        item.state = "sent"
        // File a Sent copy in its conversation, as the native shell does.
        const parent = state.messages.find((m) => item.draft.inReplyTo && m.messageId === item.draft.inReplyTo)
        const id = `sent-${item.id}`
        const account = state.accounts.find((a) => a.id === item.draft.accountId)
        state.messages.push({
          id, accountId: item.draft.accountId, threadId: parent?.threadId ?? id, threadCount: 1,
          hasAttachments: (item.draft.attachments?.length ?? 0) > 0,
          from: { name: account?.displayName ?? "Me", email: account?.address ?? "" },
          subject: item.draft.subject, preview: item.draft.body.replace(/\s+/g, " ").slice(0, 160),
          date: t, sortAt: t, seen: true, flagged: false, archived: false, snoozedUntil: null, mailbox: SENT,
          to: item.draft.to, cc: item.draft.cc, messageId: `${id}@demo.example`, bodyText: item.draft.body, bodyHtml: item.draft.bodyHtml ?? null,
          attachments: (item.draft.attachments ?? []).map((a, i) => ({ id: `${id}-a${i}`, filename: a.filename, mimeType: a.mimeType, size: Math.floor((a.dataBase64.length * 3) / 4), inline: false })),
          references: [...(item.draft.references ?? [])], files: Object.fromEntries((item.draft.attachments ?? []).map((a, i) => [`${id}-a${i}`, a.dataBase64])),
        })
        if (item.draft.followUpAfter) followUps.set(`${id}@demo.example`, t + item.draft.followUpAfter)
        emit("outbox:changed", item.id)
        changed = true
      }
    }
    if (changed) emit("mail:changed")
  }, 1000)

  const oauthClients: Partial<Record<OAuthIssuer, OAuthClientInfo>> = {}
  const push = { mode: "periodic" as PushSettings["mode"], relayUrl: null as string | null, endpoint: null as string | null, tokenSaved: false }
  const pushView = (): PushSettings => ({
    mode: push.mode,
    relayUrl: push.relayUrl,
    target: push.mode === "relay" ? "unifiedpush" : null,
    unifiedPushEndpoint: push.endpoint,
    platformPush: false,
    accounts: state.accounts.map((a) => ({
      accountId: a.id,
      address: a.address,
      via: push.mode === "relay" ? "relay" : "periodic",
      note: null,
      status: push.mode === "relay" ? { kind: "imap", lastChange: null, lastPush: null, error: null } : null,
    })),
    error: null,
  })
  const later = <T,>(v: T) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), 60))
  const done = () => emit("mail:changed")
  const pim = createDemoPim(emit, later)
  let swipes: SwipeActions = { right: "read", rightLong: "none", left: "archive", leftLong: "none" }
  const ai = createDemoAi(thread, later)
  // `notes` is made below; the team only asks once someone shares.
  const team = createDemoTeam(thread, () => state.accounts[0]?.displayName ?? null, later, () => emit("team:changed"), () => relaySealed())
  let mailPrefs: MailPrefs = { images: "ask", markRead: "open", quote: true, replyBelow: false, checkMinutes: 2, requestReceipts: false }
  let keysSaved: KeyBindings = {}
  const address = (accountId: string) => state.accounts.find((a) => a.id === accountId)!.address
  const { noteLinks, suggestFor, setMailSource, ...pimApi } = pim
  // Smart groups' "in touch": anyone you've had mail from, or sent mail to.
  setMailSource((since) => {
    const out = new Set<string>()
    for (const m of state.messages.filter((m) => m.date >= since)) {
      if (m.mailbox === SENT) for (const a of [...m.to, ...m.cc]) out.add(a.email.trim().toLowerCase())
      else out.add(m.from.email.trim().toLowerCase())
    }
    return out
  })
  const { relaySealed, ...notes } = createDemoNotes(emit, later, {
    linkFor: (t) => {
      if (t.kind === "event") {
        const e = noteLinks.event(t.id)
        return e && { kind: "event", key: e.uid, label: e.title, target: e.id }
      }
      if (t.kind === "contact") {
        const k = noteLinks.contact(t.id)
        return k && { kind: "contact", key: k.id, label: k.fullName, target: k.id }
      }
      const first = thread(t.id).sort((a, b) => a.date - b.date)[0]
      return first ? { kind: "thread", key: first.messageId ?? `local:${t.id}`, label: first.subject, target: t.id } : null
    },
    resolve: (l) => {
      if (l.kind === "event") return noteLinks.eventByUid(l.key)
      if (l.kind === "contact") return noteLinks.contact(l.key)?.id ?? null
      return state.messages.find((m) => m.messageId === l.key || `local:${m.threadId}` === l.key)?.threadId ?? null
    },
    eventByUid: (uid) => {
      const id = noteLinks.eventByUid(uid)
      const e = id ? noteLinks.event(id) : null
      return e && { id: e.id, title: e.title, start: e.start, end: e.end }
    },
    byName: (kind, name) => {
      if (kind === "event") {
        const e = noteLinks.eventByTitle(name)
        return e && { kind: "event", key: e.uid, label: e.title }
      }
      const k = noteLinks.contactByName(name)
      return k && { kind: "contact", key: k.id, label: k.fullName }
    },
  })
  const withInvite = ({ files: _f, inviteSeed, ...m }: DemoMessage): MessageDetail => ({
    ...m,
    invite: inviteSeed ? pim.inviteFor(inviteSeed, address(m.accountId)) : null,
  })

  // Newest first, one row per conversation with any of these addresses.
  const threadsWith = (emails: string[]) => {
    const rows = new Map<string, MessageSummary>()
    for (const m of [...state.messages].sort((a, b) => b.date - a.date)) {
      if (rows.has(m.threadId) || ![m.from, ...m.to, ...m.cc].some((a) => emails.includes(a.email.toLowerCase()))) continue
      rows.set(m.threadId, { ...summary(m), category: categoryOf(m), threadCount: thread(m.threadId).length })
    }
    return [...rows.values()].slice(0, 5)
  }
  return {
    kind: "demo",
    remote: false,
    providerCapabilities: async (p) => CAPABILITIES[p],
    listAccounts: () => later(state.accounts),
    addAccount: async () => {
      throw new Error("Connecting a real account needs the desktop app for now. The web version runs on sample mail.")
    },
    removeAccount: async () => {
      throw new Error("Sample accounts can't be removed.")
    },
    // The demo can set an OAuth client (so the sign-in screen is explorable),
    // but signing in needs the desktop app's browser hand-off.
    getOAuthClient: async (issuer) => later(oauthClients[issuer] ?? null),
    setOAuthClient: async (issuer, client) => {
      if (client?.clientId.trim()) oauthClients[issuer] = { clientId: client.clientId.trim(), hasSecret: !!client.clientSecret, builtIn: false }
      else delete oauthClients[issuer]
    },
    addOAuthAccount: async () => {
      throw new Error("Signing in with Google or Microsoft needs the desktop app. The web version runs on sample mail.")
    },
    reauthOAuthAccount: async () => {
      throw new Error("Signing in again needs the desktop app.")
    },
    cancelOAuthSignIn: async () => {},
    // A pretend relay, so the setting can be explored without a server.
    getPushSettings: async () => later(pushView()),
    setPushSettings: async (input) => {
      if (input.mode === "relay") {
        const url = input.relayUrl?.trim() ?? ""
        if (!/^https:\/\//.test(url)) throw new Error("the push relay needs an https:// address")
        if (!push.tokenSaved && (input.relayToken?.trim().length ?? 0) < 16) throw new Error("the relay token is at least 16 characters")
        if (!input.unifiedPushEndpoint?.trim()) throw new Error("this device has no push service yet: enter a UnifiedPush address (an ntfy topic, for example)")
        Object.assign(push, { mode: "relay", relayUrl: url, endpoint: input.unifiedPushEndpoint.trim(), tokenSaved: true })
      } else {
        push.mode = "periodic"
      }
      return later(pushView())
    },
    sendTestPush: async () => {
      if (push.mode !== "relay") throw new Error("set up the relay first")
    },
    setAccountDav: async () => {
      throw new Error("Connecting calendars needs the desktop app for now. The web version runs on sample data.")
    },
    ...pimApi,
    saveContactVcard: async (id) => downloadVcard(await pimApi.contactVcard(id)),
    contactSuggestion: async (messageId) => {
      const m = state.messages.find((x) => x.id === messageId)
      if (!m || m.mailbox === SENT || categoryOf(m) !== "people" || state.accounts.some((a) => a.address === m.from.email)) return later(null)
      const card = signatureFromMessage(m.bodyText, m.from.name)
      return later(card && suggestFor(m.from.email, m.from.name, card))
    },
    contactActivity: async (id) => {
      const { contactMeetings, getContact } = pimApi
      const emails = (await getContact(id)).emails.map((e) => e.value.trim().toLowerCase())
      return later({ threads: threadsWith(emails), ...contactMeetings(id) })
    },
    // The sender profile (ADR-0036), as the core builds it.
    senderProfile: async (raw) => {
      const email = raw.trim().toLowerCase()
      if (!email.includes("@")) throw new Error("that isn't an email address")
      const theirs = state.messages.filter((m) => m.from.email.toLowerCase() === email).sort((a, b) => b.date - a.date)
      const name = theirs.find((m) => m.from.name?.trim())?.from.name ?? null
      // Two cards can share an address; the one named as they sign wins.
      const named = (c: { fullName: string }) => Number(c.fullName.toLowerCase() === (name ?? "").toLowerCase())
      const hit = (await pimApi.listContacts(null)).filter((c) => c.emails.some((e) => e.value.trim().toLowerCase() === email)).sort((a, b) => named(b) - named(a) || a.fullName.localeCompare(b.fullName))[0]
      const contact = hit ? await pimApi.getContact(hit.id) : null
      const emails = [...new Set([email, ...(contact?.emails ?? []).map((e) => e.value.trim().toLowerCase()).filter((e) => e.includes("@"))])]
      const meetings = contact ? pimApi.contactMeetings(contact.id) : { upcoming: [], past: [] }
      // Their own newest mail's offset, never a list's (ADR-0040).
      const own = state.messages
        .filter((m) => emails.includes(m.from.email.toLowerCase()) && m.mailbox !== SENT && categoryOf(m) === "people" && (m as DemoMessage).tzOffset != null)
        .sort((a, b) => b.date - a.date)[0] as DemoMessage | undefined
      return later({
        email,
        name,
        contact,
        received: theirs.length,
        firstSeen: theirs.length ? Math.min(...theirs.map((m) => m.date)) : null,
        activity: { threads: threadsWith(emails), ...meetings },
        localOffset: own?.tzOffset ?? null,
        offsetSeen: own?.date ?? null,
      })
    },
    // Recipients' clocks (ADR-0041), as the core reads them.
    localTimes: async (emails) => {
      const out: LocalTime[] = []
      for (const raw of emails.slice(0, 20)) {
        const email = raw.trim().toLowerCase()
        if (!email.includes("@") || out.some((t) => t.email === email)) continue
        const own = state.messages
          .filter((m) => m.from.email.toLowerCase() === email && m.mailbox !== SENT && categoryOf(m) === "people" && (m as DemoMessage).tzOffset != null)
          .sort((a, b) => b.date - a.date)[0] as DemoMessage | undefined
        if (own) out.push({ email, name: own.from.name, offset: own.tzOffset!, seen: own.date })
      }
      return later(out)
    },
    ...notes,
    respondToInvite: async (messageId, response, calendarId) => {
      const m = state.messages.find((x) => x.id === messageId)
      if (!m?.inviteSeed) throw new Error("this message has no invitation")
      const inv = pim.respondTo(m.inviteSeed, address(m.accountId), response, calendarId)
      done()
      return later(inv)
    },
    applyInviteUpdate: async () => {
      throw new Error("nothing to apply for this message")
    },
    proposeTime: async (messageId, start, end) => {
      const m = state.messages.find((x) => x.id === messageId)
      if (!m?.inviteSeed || m.inviteSeed.method === "counter") throw new Error("only an invitation can get a new time")
      const inv = pim.proposeFor(m.inviteSeed, address(m.accountId), start, end)
      done()
      return later(inv)
    },
    acceptCounter: async (messageId) => {
      const m = state.messages.find((x) => x.id === messageId)
      if (m?.inviteSeed?.method !== "counter") throw new Error("this message doesn't propose a new time")
      const inv = pim.answerCounter(m.inviteSeed, address(m.accountId), true)
      done()
      return later(inv)
    },
    declineCounter: async (messageId) => {
      const m = state.messages.find((x) => x.id === messageId)
      if (m?.inviteSeed?.method !== "counter") throw new Error("this message doesn't propose a new time")
      const inv = pim.answerCounter(m.inviteSeed, address(m.accountId), false)
      done()
      return later(inv)
    },
    syncNow: () => later(undefined),

    listMessages: (q: MessageQuery) => {
      const t = now()
      const needle = q.search?.trim().toLowerCase()
      const split = q.lane === "inbox" && q.split ? splits.find((s) => s.id === q.split) : undefined
      if (q.lane === "inbox" && q.split && !split) throw new Error("that split was deleted")
      const bundled = q.lane === "inbox" && q.bundle && !q.category && !q.split && bundleMessages(q.accountId ?? null, t).threads >= 2
      const matching = state.messages.filter((m) => {
        if (q.accountId && m.accountId !== q.accountId) return false
        if (needle && ![m.subject, m.from.name ?? "", m.from.email, m.bodyText].some((f) => f.toLowerCase().includes(needle))) return false
        if (q.category && categoryOf(m) !== q.category) return false
        if (q.lane === "inbox") {
          if (split ? !splitMatch(split, m) : !inMainInbox(m)) return false
          if (bundled && categoryOf(m) === "newsletters") return false
        }
        return inLane(m, q.lane, t)
      })
      // Group by conversation: newest matching message, rolled-up state.
      const rows = new Map<string, MessageSummary>()
      for (const m of [...matching].sort((a, b) => rankAt(b, q.lane, t) - rankAt(a, q.lane, t))) {
        const row = rows.get(m.threadId)
        if (row) {
          row.seen &&= m.seen
          continue
        }
        const all = thread(m.threadId)
        rows.set(m.threadId, {
          ...summary(m),
          followUpAt: followUpAt(m),
          category: categoryOf(m),
          sentTo: m.mailbox === SENT ? (m.to[0]?.name ?? m.to[0]?.email ?? null) : null,
          threadCount: all.length,
          hasAttachments: all.some((x) => x.hasAttachments),
          flagged: all.some((x) => x.flagged),
        })
      }
      let list = [...rows.values()]
      if (q.lane === "snoozed") list = list.sort((a, b) => a.snoozedUntil! - b.snoozedUntil!)
      if (q.lane === "waiting") list = list.sort((a, b) => a.followUpAt! - b.followUpAt!)
      const offset = q.offset ?? 0
      return later(list.slice(offset, offset + (q.limit ?? 200)))
    },
    getThread: async (threadId) => {
      const list = thread(threadId).sort((a, b) => a.date - b.date)
      if (!list.length) throw new Error("that conversation is no longer here")
      return later(list.map((m) => ({ ...withInvite(m), followUpAt: followUpAt(m), threadCount: list.length })))
    },

    listSplits: async () => later(splits),
    saveSplit: async (id, input) => {
      const rule = checkSplit(input)
      if (id && !splits.some((s) => s.id === id)) throw new Error("that split was deleted")
      const split = { ...rule, id: id ?? `split-${++nSplits}` }
      splits = id ? splits.map((s) => (s.id === id ? split : s)) : [...splits, split]
      done()
      return later(split)
    },
    deleteSplit: async (id) => {
      splits = splits.filter((s) => s.id !== id)
      done()
      return later(splits)
    },
    moveSplit: async (id, index) => {
      const s = splits.find((x) => x.id === id)
      if (!s) throw new Error("that split was deleted")
      splits = splits.filter((x) => x !== s)
      splits.splice(Math.min(index, splits.length), 0, s)
      done()
      return later(splits)
    },
    // Opt-in AI (ADR-0059), answered from the thread itself.
    ...ai,
    // Shared conversations (ADR-0060).
    ...team,
    // Power settings (ADR-0055), with the core's private defaults and its snapping.
    mailPrefs: async () => later({ ...mailPrefs }),
    setMailPrefs: async (p) => {
      const minutes = [2, 5, 15, 30, 60].reduce((a, b) => (Math.abs(b - p.checkMinutes) < Math.abs(a - p.checkMinutes) ? b : a))
      mailPrefs = { ...p, checkMinutes: minutes }
      return later({ ...mailPrefs })
    },
    // Swipes (ADR-0025): Apple Mail's mapping until changed.
    swipeActions: async () => later(swipes),
    setSwipeActions: async (a) => {
      const ok = ["none", "read", "archive", "star", "snooze-tomorrow", "snooze-next-week", "remind", "newsletters"]
      const bad = [a.right, a.rightLong, a.left, a.leftLong].find((x) => !ok.includes(x))
      if (bad) throw new Error(`“${bad}” isn't something a swipe can do`)
      swipes = { ...a }
      return later(swipes)
    },
    // Keys (ADR-0032): the same checks as the core.
    keyBindings: async () => later(mergedKeys(keysSaved)),
    setKeyBindings: async (b) => {
      for (const [id, key] of Object.entries(b)) {
        if (!KEY_COMMANDS.some((c) => c.id === id)) throw new Error(`“${id}” isn't a command a key can do`)
        const why = keyProblem(key)
        if (why) throw new Error(why)
      }
      const all = mergedKeys(b)
      const seen = new Map<string, string>()
      for (const [id, key] of Object.entries(all)) {
        if (!key) continue
        const at = `${id.split(".")[0]} ${key}`
        if (seen.has(at)) throw new Error(`“${key}” is already the key for ${seen.get(at)}`)
        seen.set(at, id)
      }
      keysSaved = Object.fromEntries(Object.entries(all).filter(([id, k]) => DEFAULT_KEYS[id] !== k))
      return later(all)
    },
    inboxOverview: async (accountId) => {
      const t = now()
      const count = (s: Split) => {
        const threads = new Map<string, boolean>()
        for (const m of state.messages.filter((x) => (!accountId || x.accountId === accountId) && inLane(x, "inbox", t) && splitMatch(s, x))) threads.set(m.threadId, (threads.get(m.threadId) ?? true) && m.seen)
        return { id: s.id, threads: threads.size, unread: [...threads.values()].filter((seen) => !seen).length }
      }
      const b = bundleMessages(accountId ?? null, t)
      return later({ splits: splits.map(count), bundle: b.threads >= 2 ? { threads: b.threads, unread: b.unread, latest: b.latest, senders: b.senders } : null })
    },
    bundleMarkRead: async (accountId) => {
      const { list } = bundleMessages(accountId ?? null, now())
      const n = list.filter((m) => !m.seen).length
      list.forEach((m) => (m.seen = true))
      done()
      return later(n)
    },
    bundleArchive: async (accountId) => {
      const { list } = bundleMessages(accountId ?? null, now())
      list.forEach((m) => (m.archived = true))
      done()
      return later(list.map((m) => m.id))
    },
    unarchiveBundle: async (keys) => {
      state.messages.filter((m) => keys.includes(m.id)).forEach((m) => (m.archived = false))
      done()
    },
    setThreadSeen: async (threadId, seen) => { received(threadId).forEach((m) => (m.seen = seen)); done() },
    setThreadFlagged: async (threadId, flagged) => {
      const list = received(threadId)
      if (flagged) {
        const newest = [...list].sort((a, b) => b.sortAt - a.sortAt)[0]
        if (newest) newest.flagged = true
      } else list.forEach((m) => (m.flagged = false))
      done()
    },
    setThreadArchived: async (threadId, archived) => {
      // Archiving a conversation a reminder brought back dismisses the reminder.
      const t = now()
      const due = archived ? sentIn(threadId).filter((id) => followUps.get(id)! <= t) : []
      due.forEach((id) => followUps.delete(id))
      ;(due.length ? thread(threadId).filter((m) => m.mailbox !== SENT) : received(threadId)).forEach((m) => (m.archived = archived))
      done()
    },
    setFollowUp: async (threadId, dueAt) => {
      if (dueAt <= now()) throw new Error("pick a time in the future")
      if (dueAt > now() + 366 * 24 * HOUR) throw new Error("reminders can be set up to a year ahead")
      const mine = thread(threadId).filter((m) => m.mailbox === SENT && m.messageId).sort((a, b) => b.date - a.date)[0]
      if (!mine) throw new Error("follow-up reminders are for conversations where you've sent a message")
      followUps.set(mine.messageId!, dueAt)
      done()
    },
    cancelFollowUp: async (threadId) => {
      sentIn(threadId).forEach((id) => followUps.delete(id))
      done()
    },
    unsubscribe: async (messageId) => {
      const m = state.messages.find((x) => x.id === messageId)
      const u = m?.unsubscribe
      if (!m || !u) throw new Error("this message doesn't say how to unsubscribe")
      // Sample lists don't exist: one-click and mail succeed without sending anything.
      if (u.oneClick) return later("one_click" as const)
      if (u.mailto) return later("mail" as const)
      window.open(u.web!, "_blank", "noopener")
      return later("web" as const)
    },
    listTemplates: () => later([...templates].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))),
    saveTemplate: async (input) => {
      if (!input.name.trim()) throw new Error("give the template a name")
      if (!input.html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim()) throw new Error("the template is empty")
      const t: Template = { id: input.id ?? crypto.randomUUID(), name: input.name.trim(), subject: input.subject.trim(), html: input.html, updated: now() }
      const i = templates.findIndex((x) => x.id === t.id)
      if (input.id && i < 0) throw new Error("that template was deleted")
      if (i >= 0) templates[i] = t
      else templates.push(t)
      emit("compose:changed")
      return later(t)
    },
    deleteTemplate: async (id) => {
      const i = templates.findIndex((x) => x.id === id)
      if (i >= 0) templates.splice(i, 1)
      emit("compose:changed")
    },
    listSignatures: () => later(signatures),
    screenerStatus: async () => {
      const waiting = new Set(state.messages.filter((m) => !m.archived && screened(m)).map((m) => key(m.from.email))).size
      return later({ enabled: screener.since !== null, since: screener.since, waiting })
    },
    setScreener: async (enabled) => {
      screener.since = enabled ? (screener.since ?? now()) : null
      done()
      const waiting = new Set(state.messages.filter((m) => !m.archived && screened(m)).map((m) => key(m.from.email))).size
      return later({ enabled, since: screener.since, waiting })
    },
    decideSender: async (email, decision) => {
      if (!email.includes("@")) throw new Error(`“${email}” isn't an email address`)
      const prev = senders.get(key(email))
      senders.set(key(email), { decision, category: prev?.category ?? null, at: now() })
      if (decision === "screened_out" || decision === "blocked") {
        for (const m of state.messages) {
          if (key(m.from.email) !== key(email) || m.mailbox === SENT) continue
          m.archived = true
          if (decision === "blocked") m.seen = true
        }
      }
      done()
    },
    setSenderCategory: async (email, category) => {
      const prev = senders.get(key(email))
      senders.set(key(email), { decision: prev?.decision ?? null, category, at: now() })
      done()
    },
    listSenders: async () => {
      const list: Sender[] = [...senders.entries()]
        .filter(([, v]) => v.decision === "screened_out" || v.decision === "blocked" || v.category !== null)
        .sort((a, b) => b[1].at - a[1].at)
        .map(([email, v]) => {
          const theirs = state.messages.filter((m) => key(m.from.email) === email && m.mailbox !== SENT).sort((a, b) => b.date - a.date)
          return { email, name: theirs[0]?.from.name ?? null, decision: v.decision, category: v.category, messages: theirs.length }
        })
      return later(list)
    },
    setSignature: async (accountId, html) => {
      if (!state.accounts.some((a) => a.id === accountId)) throw new Error("that account is no longer here")
      const i = signatures.findIndex((s) => s.accountId === accountId)
      if (i >= 0) signatures.splice(i, 1)
      if (html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim()) signatures.push({ accountId, html })
      emit("compose:changed")
    },
    snoozeThread: async (threadId, until) => {
      if (until <= now()) throw new Error("pick a time in the future")
      received(threadId).filter((m) => !m.archived).forEach((m) => (m.snoozedUntil = until))
      done()
    },
    unsnoozeThread: async (threadId) => { thread(threadId).forEach((m) => (m.snoozedUntil = null)); done() },

    openAttachment: async (id) => {
      const m = state.messages.find((x) => id in x.files)
      const info = m?.attachments.find((a) => a.id === id)
      if (!m || !info) throw new Error("that attachment is no longer here")
      // Browsers can't open files with the system's default app; download instead.
      const a = document.createElement("a")
      a.href = `data:${info.mimeType};base64,${m.files[id]}`
      a.download = info.filename
      a.click()
      return null
    },

    attachmentData: async (id) => {
      const m = state.messages.find((x) => id in x.files)
      if (!m) throw new Error("that attachment is no longer here")
      return Uint8Array.from(atob(m.files[id]!), (c) => c.charCodeAt(0)).buffer
    },

    queueSend: async (draft: Draft, undoSecs, sendAt) => {
      if (sendAt != null && sendAt <= now() + 60) throw new Error("pick a time at least a minute from now")
      if (sendAt != null && sendAt > now() + 366 * 24 * HOUR) throw new Error("mail can be scheduled up to a year ahead")
      if (draft.followUpAfter != null && (draft.followUpAfter < 60 || draft.followUpAfter > 366 * 24 * HOUR)) throw new Error("pick a follow-up between a minute and a year after sending")
      if (draft.to.length + draft.cc.length === 0) throw new Error("add at least one recipient")
      const bad = [...draft.to, ...draft.cc].find((a) => !a.email.includes("@"))
      if (bad) throw new Error(`“${bad.email}” isn't an email address`)
      const bytes = (draft.attachments ?? []).reduce((n, a) => n + (a.dataBase64.length * 3) / 4, 0)
      if (bytes > 25 * 1024 * 1024) throw new Error("attachments are over 25 MB — most mail servers will refuse the message")
      const item: OutboxItem = {
        id: crypto.randomUUID(), draft, sendAt: sendAt ?? now() + Math.min(Math.max(undoSecs, 0), 120),
        state: "queued", error: null, scheduled: sendAt != null,
      }
      outbox.set(item.id, item)
      emit("outbox:changed")
      return structuredClone(item)
    },
    cancelSend: async (id) => {
      const item = outbox.get(id)
      if (!item || item.state !== "queued") throw new Error("too late to undo — it has already been sent")
      item.state = "cancelled"
      emit("outbox:changed")
      return structuredClone(item.draft)
    },
    listOutbox: () => later([...outbox.values()].filter((i) => i.state === "queued" || i.state === "failed")),
    rescheduleSend: async (id, sendAt) => {
      const item = outbox.get(id)
      if (!item || item.state !== "queued") throw new Error("it has already been sent")
      if (sendAt != null && sendAt <= now() + 60) throw new Error("pick a time at least a minute from now")
      item.sendAt = sendAt ?? now()
      emit("outbox:changed")
      return structuredClone(item)
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(handler)
      return () => listeners.get(event)!.delete(handler)
    },
  }
}
