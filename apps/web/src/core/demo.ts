import type { CoreClient, CoreEvent } from "./client"
import type { Account, Capabilities, Draft, MessageDetail, MessageQuery, OutboxItem, Provider } from "./types"

// An in-memory stand-in for the Rust core, so the web build is usable before
// the gateway exists. It follows the same rules as crates/core/src/store.rs:
// lanes, snooze wake-ups (unread, back on top), and an undo-send window.

const now = () => Math.floor(Date.now() / 1000)
const HOUR = 3600

const CAPABILITIES: Record<Provider, Capabilities> = {
  google: { mail: true, calendar: true, contacts: true, notes: "import_only", mail_organization: "labels", contact_groups: true, server_side_scheduling: true, push: true, auth: "o_auth2" },
  microsoft: { mail: true, calendar: true, contacts: true, notes: "unsupported", mail_organization: "folders", contact_groups: true, server_side_scheduling: true, push: true, auth: "o_auth2" },
  i_cloud: { mail: true, calendar: true, contacts: true, notes: "import_only", mail_organization: "folders", contact_groups: true, server_side_scheduling: false, push: true, auth: "app_password" },
  jmap: { mail: true, calendar: true, contacts: true, notes: "unsupported", mail_organization: "labels", contact_groups: true, server_side_scheduling: false, push: true, auth: "o_auth2" },
  generic: { mail: true, calendar: false, contacts: false, notes: "unsupported", mail_organization: "folders", contact_groups: false, server_side_scheduling: false, push: false, auth: "password" },
  local: { mail: false, calendar: true, contacts: true, notes: "native", mail_organization: null, contact_groups: true, server_side_scheduling: false, push: false, auth: "none" },
}

function seed(): { accounts: Account[]; messages: MessageDetail[] } {
  const t = now()
  const server = { host: "demo.invalid", port: 993, security: "tls" as const }
  const account = (id: string, displayName: string, address: string): Account => ({
    id, displayName, address, username: address, provider: "generic",
    imap: server, smtp: { ...server, port: 465 }, lastSync: t, lastError: null,
  })
  const accounts = [account("personal", "Personal", "me@personal.example"), account("work", "Work", "me@studio.example")]
  let n = 0
  const msg = (
    accountId: string, name: string, email: string, subject: string, body: string,
    ago: number, extra: Partial<MessageDetail> = {},
  ): MessageDetail => {
    const date = t - ago
    return {
      id: `demo-${++n}`, accountId, from: { name, email }, subject,
      preview: body.replace(/\s+/g, " ").slice(0, 160), date, sortAt: date,
      seen: false, flagged: false, archived: false, snoozedUntil: null,
      to: [{ name: null, email: accounts.find((a) => a.id === accountId)!.address }], cc: [],
      messageId: `demo-${n}@example.com`, bodyText: body, bodyHtml: null, ...extra,
    }
  }
  return {
    accounts,
    messages: [
      msg("work", "Priya Raman", "priya@studio.example", "Token audit — round two",
        "Hi,\n\nI pulled the semantic tier into a single sheet so we can see where the aliases drift from the primitives. Three of the surface tokens resolve to the same value in dark mode, which is probably why the list pane feels flat.\n\nCan we review Thursday?\n\nPriya",
        0.3 * HOUR, { flagged: true }),
      msg("personal", "Ferry Line", "no-reply@ferry.example", "Your booking is confirmed",
        "Saturday 08:15 crossing, vehicle under 5 m, two passengers. Arrive 30 minutes before departure.", 1.6 * HOUR),
      msg("personal", "Marcus Lee", "marcus@example.com", "Re: Cabin weekend",
        "Count me in. I'll bring the board games and the good coffee.\n\n— M", 20 * HOUR, { seen: true }),
      msg("personal", "Design Systems Weekly", "digest@dsweekly.example", "Issue 212: Variable fonts in production",
        "This week: shipping icon fonts with live axes, plus a look at density modes.", 2 * 24 * HOUR, {
          seen: true,
          // Exercises the HTML path: the script must be stripped, the pixel blocked.
          bodyHtml: `<h2 style="margin:0 0 8px">Variable fonts in production</h2>
<p>This week: shipping icon fonts with <b>live axes</b>, plus a look at density modes.</p>
<img src="https://tracker.example/open.gif?u=123" width="1" height="1" alt="">
<script>document.body.innerHTML = "pwned"</script>
<p><a href="https://example.com/issue-212">Read the issue →</a></p>`,
        }),
      msg("personal", "Ana Duarte", "ana@example.com", "Photos from the trip",
        "Finally sorted them. Shared album link inside — the lighthouse ones came out great.", 3 * 24 * HOUR, { seen: true, flagged: true }),
      msg("work", "Sam Okafor", "sam@example.com", "Density modes proposal",
        "Attached the comfortable / compact spec. The list row drops to 56px in compact.", 4 * 24 * HOUR, { seen: true, archived: true }),
    ],
  }
}

export function createDemoClient(): CoreClient {
  const state = seed()
  const outbox = new Map<string, OutboxItem>()
  const listeners = new Map<CoreEvent, Set<(p?: unknown) => void>>()
  const emit = (e: CoreEvent, p?: unknown) => listeners.get(e)?.forEach((h) => h(p))
  const find = (id: string) => {
    const m = state.messages.find((x) => x.id === id)
    if (!m) throw new Error("that message is no longer here")
    return m
  }
  const awake = (m: MessageDetail, t: number) => m.snoozedUntil === null || m.snoozedUntil <= t

  // The same 1-second tick the native workers run.
  setInterval(() => {
    const t = now()
    let woke = false
    for (const m of state.messages) {
      if (m.snoozedUntil !== null && m.snoozedUntil <= t) {
        Object.assign(m, { snoozedUntil: null, sortAt: t, seen: false })
        woke = true
      }
    }
    if (woke) emit("mail:changed")
    for (const item of outbox.values()) {
      if (item.state === "queued" && item.sendAt <= t) {
        item.state = "sent"
        emit("outbox:changed", item.id)
      }
    }
  }, 1000)

  const later = <T,>(v: T) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), 60))

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
    syncNow: () => later(undefined),
    listMessages: (q: MessageQuery) => {
      const t = now()
      const needle = q.search?.trim().toLowerCase()
      let list = state.messages.filter((m) => {
        if (q.accountId && m.accountId !== q.accountId) return false
        if (needle && ![m.subject, m.from.name ?? "", m.from.email, m.bodyText].some((f) => f.toLowerCase().includes(needle))) return false
        switch (q.lane) {
          case "inbox": return !m.archived && awake(m, t)
          case "unread": return !m.archived && !m.seen && awake(m, t)
          case "starred": return m.flagged
          case "snoozed": return m.snoozedUntil !== null && m.snoozedUntil > t
          case "archive": return m.archived
        }
      })
      list = q.lane === "snoozed"
        ? list.sort((a, b) => a.snoozedUntil! - b.snoozedUntil!)
        : list.sort((a, b) => b.sortAt - a.sortAt)
      return later(list.slice(0, q.limit ?? 200).map(({ to: _t, cc: _c, messageId: _m, bodyText: _b, bodyHtml: _h, ...s }) => s))
    },
    getMessage: async (id) => later(find(id)),
    setSeen: async (id, seen) => { find(id).seen = seen; emit("mail:changed") },
    setFlagged: async (id, flagged) => { find(id).flagged = flagged; emit("mail:changed") },
    setArchived: async (id, archived) => { find(id).archived = archived; emit("mail:changed") },
    snooze: async (id, until) => {
      if (until <= now()) throw new Error("pick a time in the future")
      Object.assign(find(id), { snoozedUntil: until, archived: false })
      emit("mail:changed")
    },
    unsnooze: async (id) => { find(id).snoozedUntil = null; emit("mail:changed") },
    queueSend: async (draft: Draft, undoSecs) => {
      if (draft.to.length + draft.cc.length === 0) throw new Error("add at least one recipient")
      const bad = [...draft.to, ...draft.cc].find((a) => !a.email.includes("@"))
      if (bad) throw new Error(`“${bad.email}” isn't an email address`)
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
