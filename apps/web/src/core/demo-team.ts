import type { MessageDetail, TeamLink, TeamThread } from "./types"

/**
 * Shared conversations in the demo (ADR-0060), kept as the core keeps them:
 * the list, and each document's last state. The documents themselves sync
 * on a real relay, as in the desktop app, when one is set up.
 */
export function createDemoTeam(thread: (threadId: string) => MessageDetail[], fromName: () => string | null, later: <T>(v: T) => Promise<T>, changed: () => void) {
  const rows = new Map<string, TeamThread & { ydoc: string | null }>()
  const now = () => Math.floor(Date.now() / 1000)
  const pub = ({ ydoc: _y, ...t }: TeamThread & { ydoc: string | null }): TeamThread => t
  const get = (id: string) => {
    const t = rows.get(id)
    if (!t) throw new Error("that shared conversation isn't here any more")
    return t
  }
  const touch = (t: TeamThread) => (t.updated = Math.max(now(), t.updated + 1))
  const done = <T,>(v: T) => (changed(), later(v))
  return {
    teamThreads: async () => later([...rows.values()].sort((a, b) => b.updated - a.updated).map(pub)),
    threadShare: async (threadId: string) => later([...rows.values()].find((t) => t.role === "owner" && t.threadId === threadId && !t.revoked) ?? null).then((t) => (t ? pub(t) : null)),
    shareThread: async (threadId: string) => {
      const live = [...rows.values()].find((t) => t.role === "owner" && t.threadId === threadId && !t.revoked)
      if (live) return later(pub(live))
      const list = thread(threadId).sort((a, b) => a.date - b.date)
      if (!list.length) throw new Error("that conversation is no longer here")
      const t = { id: crypto.randomUUID().replaceAll("-", ""), role: "owner" as const, threadId, revoked: false, relay: null, token: null, title: list.at(-1)!.subject, from: fromName(), created: now(), updated: now(), ydoc: null }
      rows.set(t.id, t)
      return done(pub(t))
    },
    joinTeamThread: async (l: TeamLink) => {
      if (!/^[A-Za-z0-9_-]{16,64}$/.test(l.id) || !/^wss?:\/\//.test(l.relay.trim()) || !l.token.trim()) throw new Error("that link isn't complete")
      const was = rows.get(l.id)
      if (was?.revoked) throw new Error("That conversation isn't shared any more.")
      if (was) return later(pub(was))
      const t = { id: l.id, role: "guest" as const, threadId: null, revoked: false, relay: l.relay.trim(), token: l.token.trim(), title: l.title.trim(), from: l.from?.trim() || null, created: now(), updated: now(), ydoc: null }
      rows.set(t.id, t)
      return done(pub(t))
    },
    stopTeamThread: async (id: string) => {
      const t = get(id)
      t.revoked = true
      touch(t)
      return done(pub(t))
    },
    removeTeamThread: async (id: string) => {
      const t = get(id)
      if (t.role === "owner" && !t.revoked) throw new Error("Stop sharing this conversation first.")
      rows.delete(id)
      return done(undefined)
    },
    teamDoc: async (id: string) => later(get(id).ydoc),
    saveTeamDoc: async (id: string, ydoc: string, title: string | null) => {
      const t = get(id)
      t.ydoc = ydoc
      if (title?.trim()) t.title = title.trim()
      touch(t)
      return done(pub(t))
    },
  }
}
