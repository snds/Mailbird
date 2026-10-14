import type { CoreClient, CoreEvent } from "./client"
import type { Account, AttachmentInfo, Capabilities, Draft, Lane, MessageDetail, MessageQuery, MessageSummary, OAuthClientInfo, OAuthIssuer, OutboxItem, Provider, PushSettings } from "./types"
import { createDemoNotes } from "./demo-notes"
import { createDemoPim, type DemoInviteSeed } from "./demo-pim"

// An in-memory stand-in for the Rust core, so the web build is usable before
// the gateway exists. It follows the same rules as crates/core/src/store.rs:
// conversations, lanes (Sent copies never fill the inbox), snooze wake-ups
// (unread, back on top), thread-level triage, and an undo-send window.

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
}

function seed(): { accounts: Account[]; messages: DemoMessage[] } {
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
      attachments: [], references: [], files: {}, ...extra,
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
          // Exercises the HTML path: the script must be stripped, the pixel blocked.
          bodyHtml: `<h2 style="margin:0 0 8px">Variable fonts in production</h2>
<p>This week: shipping icon fonts with <b>live axes</b>, plus a look at density modes.</p>
<img src="https://tracker.example/open.gif?u=123" width="1" height="1" alt="">
<script>document.body.innerHTML = "pwned"</script>
<p><a href="https://example.com/issue-212">Read the issue →</a></p>`,
        }),
      msg("personal", { name: "Ana Duarte", email: "ana@example.com" }, "Photos from the trip",
        "Finally sorted them. The lighthouse ones came out great — two favorites attached.", 3 * 24 * HOUR, {
          seen: true, flagged: true,
          ...withFiles([
            file("att-light", "lighthouse.png", "image/png", swatch(37, 99, 235)),
            file("att-dunes", "dunes.png", "image/png", swatch(217, 160, 72)),
          ]),
        }),
      msg("work", { name: "Sam Okafor", email: "sam@example.com" }, "Density modes proposal",
        "Attached the comfortable / compact spec. The list row drops to 56px in compact.", 4 * 24 * HOUR, { seen: true, archived: true }),
    ],
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
  const listeners = new Map<CoreEvent, Set<(p?: unknown) => void>>()
  const emit = (e: CoreEvent, p?: unknown) => listeners.get(e)?.forEach((h) => h(p))
  const awake = (m: MessageDetail, t: number) => m.snoozedUntil === null || m.snoozedUntil <= t
  const thread = (threadId: string) => state.messages.filter((m) => m.threadId === threadId)
  const received = (threadId: string) => {
    const list = thread(threadId).filter((m) => m.mailbox !== SENT)
    if (!thread(threadId).length) throw new Error("that conversation is no longer here")
    return list
  }
  const inLane = (m: MessageDetail, lane: Lane, t: number) => {
    const r = m.mailbox !== SENT
    switch (lane) {
      case "inbox": return r && !m.archived && awake(m, t)
      case "unread": return r && !m.archived && !m.seen && awake(m, t)
      case "starred": return m.flagged
      case "snoozed": return r && m.snoozedUntil !== null && m.snoozedUntil > t
      case "archive": return r && m.archived
    }
  }
  const summary = ({ to: _t, cc: _c, messageId: _m, bodyText: _b, bodyHtml: _h, attachments: _a, references: _r, files: _f, inviteSeed: _i, invite: _v, ...s }: DemoMessage): MessageSummary => s

  // The same 1-second tick the native workers run.
  setInterval(() => {
    const t = now()
    let changed = false
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
  const address = (accountId: string) => state.accounts.find((a) => a.id === accountId)!.address
  const { noteLinks, ...pimApi } = pim
  const notes = createDemoNotes(emit, later, {
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

  return {
    kind: "demo",
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
    syncNow: () => later(undefined),

    listMessages: (q: MessageQuery) => {
      const t = now()
      const needle = q.search?.trim().toLowerCase()
      const matching = state.messages.filter((m) => {
        if (q.accountId && m.accountId !== q.accountId) return false
        if (needle && ![m.subject, m.from.name ?? "", m.from.email, m.bodyText].some((f) => f.toLowerCase().includes(needle))) return false
        return inLane(m, q.lane, t)
      })
      // Group by conversation: newest matching message, rolled-up state.
      const rows = new Map<string, MessageSummary>()
      for (const m of [...matching].sort((a, b) => b.sortAt - a.sortAt)) {
        const row = rows.get(m.threadId)
        if (row) {
          row.seen &&= m.seen
          continue
        }
        const all = thread(m.threadId)
        rows.set(m.threadId, {
          ...summary(m),
          threadCount: all.length,
          hasAttachments: all.some((x) => x.hasAttachments),
          flagged: all.some((x) => x.flagged),
        })
      }
      let list = [...rows.values()]
      if (q.lane === "snoozed") list = list.sort((a, b) => a.snoozedUntil! - b.snoozedUntil!)
      const offset = q.offset ?? 0
      return later(list.slice(offset, offset + (q.limit ?? 200)))
    },
    getThread: async (threadId) => {
      const list = thread(threadId).sort((a, b) => a.date - b.date)
      if (!list.length) throw new Error("that conversation is no longer here")
      return later(list.map((m) => ({ ...withInvite(m), threadCount: list.length })))
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
    setThreadArchived: async (threadId, archived) => { received(threadId).forEach((m) => (m.archived = archived)); done() },
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

    queueSend: async (draft: Draft, undoSecs) => {
      if (draft.to.length + draft.cc.length === 0) throw new Error("add at least one recipient")
      const bad = [...draft.to, ...draft.cc].find((a) => !a.email.includes("@"))
      if (bad) throw new Error(`“${bad.email}” isn't an email address`)
      const bytes = (draft.attachments ?? []).reduce((n, a) => n + (a.dataBase64.length * 3) / 4, 0)
      if (bytes > 25 * 1024 * 1024) throw new Error("attachments are over 25 MB — most mail servers will refuse the message")
      const item: OutboxItem = {
        id: crypto.randomUUID(), draft, sendAt: now() + Math.min(Math.max(undoSecs, 0), 120),
        state: "queued", error: null,
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
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(handler)
      return () => listeners.get(event)!.delete(handler)
    },
  }
}
