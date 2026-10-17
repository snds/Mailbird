import { HocuspocusProviderWebsocket } from "@hocuspocus/provider"
import * as Y from "yjs"
import { create } from "zustand"

import type { CoreClient } from "@/core/client"
import type { RelayConfig, TeamThread } from "@/core/types"

import { rejoining } from "../notes/shared-docs"
import { sharedDocName } from "../notes/share-link"
import { loadDoc, stateOf } from "../notes/ydoc"
import { snapshot, syncMessages } from "./team-doc"

/**
 * Shared conversations' documents (ADR-0060). Every one you shared or
 * joined stays connected while the app runs, so comments and the shared
 * reply arrive whether or not it's open, and each change is saved to the
 * core. The owner connects with their relay's token and keeps the copy of
 * the messages current; a teammate connects with the link's token, on the
 * owner's relay. A stopped one stays as a read-only copy.
 */

const SAVE_DELAY = 400
/** How long joining waits to hear from the relay before showing what's there. */
const FIRST_SYNC = 8_000

type Ready = "synced" | "denied" | "timeout"

/** Changes per shared conversation, so views redraw when a document does. */
export const useTeamVersions = create<Record<string, number>>(() => ({}))
const bump = (id: string) => useTeamVersions.setState((s) => ({ [id]: (s[id] ?? 0) + 1 }))

/** Whether a shared conversation is connected right now, by id. */
export const useTeamLive = create<Record<string, boolean>>(() => ({}))

class TeamWatch {
  readonly ready: Promise<Ready>
  private p: ReturnType<typeof rejoining> | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private saved: string | null
  private stopped = false
  private settle: (r: Ready) => void = () => {}
  readonly t: TeamThread
  readonly doc: Y.Doc
  private o: { core: CoreClient; socket: HocuspocusProviderWebsocket; token: string; ownerAddress: () => Promise<string | null>; onDenied: () => void }

  constructor(t: TeamThread, doc: Y.Doc, saved: string | null, o: TeamWatch["o"]) {
    this.t = t
    this.doc = doc
    this.saved = saved
    this.o = o
    this.ready = new Promise<Ready>((resolve) => (this.settle = resolve))
    setTimeout(() => this.settle("timeout"), FIRST_SYNC)
    doc.on("update", this.onUpdate)
    this.p = rejoining(o.socket, sharedDocName(t.id), doc, o.token, {
      synced: () => {
        this.settle("synced")
        useTeamLive.setState({ [t.id]: true })
        void this.refreshMessages()
      },
      denied: () => {
        this.settle("denied")
        useTeamLive.setState({ [t.id]: false })
        if (!this.stopped) o.onDenied()
      },
    })
  }

  private onUpdate = (_u: Uint8Array, origin: unknown) => {
    bump(this.t.id)
    if (origin !== "load") this.scheduleSave()
  }

  /** The owner's copy of the messages follows the conversation in their mail. */
  async refreshMessages() {
    if (this.t.role !== "owner" || !this.t.threadId || this.stopped) return
    const thread = await this.o.core.getThread(this.t.threadId).catch(() => null)
    if (thread?.length && !this.stopped) syncMessages(this.doc, thread, await this.o.ownerAddress(), this.t.from)
  }

  private scheduleSave() {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.save(), SAVE_DELAY)
  }

  private async save() {
    if (this.stopped) return
    const state = stateOf(this.doc)
    if (state === this.saved) return
    this.saved = state
    await this.o.core.saveTeamDoc(this.t.id, state, snapshot(this.doc).subject || null).catch(() => {})
  }

  stop() {
    this.stopped = true
    clearTimeout(this.timer)
    this.doc.off("update", this.onUpdate)
    this.p?.destroy()
    useTeamLive.setState({ [this.t.id]: false })
    this.settle("timeout")
  }
}

export class TeamSync {
  private sockets = new Map<string, HocuspocusProviderWebsocket>()
  private watches = new Map<string, TeamWatch>()
  /** Every shared conversation's document, live or a stopped copy. */
  private docs = new Map<string, Y.Doc>()
  private loading = new Map<string, Promise<Y.Doc>>()
  private joining = new Set<string>()
  private offs: (() => void)[]
  private refreshTimer: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  private core: CoreClient
  private relay: RelayConfig | null
  private onStopped: (title: string, from: string | null) => void

  constructor(core: CoreClient, relay: RelayConfig | null, onStopped: (title: string, from: string | null) => void) {
    this.core = core
    this.relay = relay
    this.onStopped = onStopped
    const later = () => {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = setTimeout(() => void this.refresh(), 200)
    }
    this.offs = [
      core.on("team:changed", later),
      // New mail in a shared conversation goes into its copy.
      core.on("mail:changed", () => {
        for (const w of this.watches.values()) void w.refreshMessages()
      }),
    ]
    void this.refresh()
  }

  private socket(url: string) {
    let s = this.sockets.get(url)
    if (!s) {
      s = new HocuspocusProviderWebsocket({ url })
      this.sockets.set(url, s)
    }
    return s
  }

  /** A shared conversation's document, from its last saved state. */
  doc(id: string): Promise<Y.Doc> {
    const d = this.docs.get(id)
    if (d) return Promise.resolve(d)
    let p = this.loading.get(id)
    if (!p) {
      p = this.core.teamDoc(id).then((state) => {
        const doc = this.docs.get(id) ?? loadDoc(state)
        this.docs.set(id, doc)
        this.loading.delete(id)
        return doc
      })
      this.loading.set(id, p)
    }
    return p
  }

  /** Connect every live shared conversation; let go of the rest. */
  async refresh() {
    if (this.stopped) return
    const list = await this.core.teamThreads().catch(() => [] as TeamThread[])
    const live = new Map(list.filter((t) => !t.revoked && (t.role === "owner" ? !!this.relay : !!t.relay && !!t.token)).map((t) => [t.id, t]))
    for (const [id, w] of this.watches) {
      if (!live.has(id)) {
        w.stop()
        this.watches.delete(id)
      }
    }
    for (const id of this.docs.keys()) if (!list.some((t) => t.id === id)) this.docs.delete(id)
    for (const [id, t] of live) if (!this.watches.has(id)) await this.watch(t)
    for (const [url, s] of this.sockets) {
      if (![...this.watches.values()].some((w) => (w.t.role === "owner" ? this.relay?.url : w.t.relay) === url)) {
        s.destroy()
        this.sockets.delete(url)
      }
    }
  }

  private async watch(t: TeamThread) {
    const doc = await this.doc(t.id)
    if (this.stopped || this.watches.has(t.id)) return this.watches.get(t.id)!
    const owner = t.role === "owner"
    const w = new TeamWatch(t, doc, null, {
      core: this.core,
      socket: this.socket(owner ? this.relay!.url : t.relay!),
      token: owner ? this.relay!.token : t.token!,
      ownerAddress: async () => {
        if (!owner || !t.threadId) return null
        const thread = await this.core.getThread(t.threadId).catch(() => [])
        const accounts = await this.core.listAccounts().catch(() => [])
        return accounts.find((a) => a.id === thread[0]?.accountId)?.address ?? null
      },
      onDenied: () => void this.denied(t),
    })
    this.watches.set(t.id, w)
    return w
  }

  /** The owner stopped sharing: what's here stays, read-only. */
  private async denied(t: TeamThread) {
    if (t.role === "owner" || this.joining.has(t.id)) return
    this.watches.get(t.id)?.stop()
    this.watches.delete(t.id)
    const stopped = await this.core.stopTeamThread(t.id).catch(() => null)
    if (stopped) this.onStopped(snapshot(this.docs.get(t.id) ?? new Y.Doc()).subject || t.title, t.from)
  }

  /**
   * Joins a conversation from a teammate's link and waits to hear from the
   * relay. The same link twice opens the one already joined.
   */
  async join(link: { id: string; relay: string; token: string; title: string; from: string | null }): Promise<TeamThread> {
    const mine = (await this.core.teamThreads()).find((t) => t.id === link.id)
    if (mine && !mine.revoked) return mine
    const t = await this.core.joinTeamThread(link)
    this.joining.add(t.id)
    try {
      const ready = await (await this.watch(t)).ready
      if (ready === "denied") {
        this.watches.get(t.id)?.stop()
        this.watches.delete(t.id)
        await this.core.stopTeamThread(t.id).catch(() => {})
        await this.core.removeTeamThread(t.id).catch(() => {})
        throw new Error("That link doesn't work any more. Ask for a new one.")
      }
      return t
    } finally {
      this.joining.delete(t.id)
    }
  }

  stop() {
    this.stopped = true
    clearTimeout(this.refreshTimer)
    for (const off of this.offs) off()
    for (const w of this.watches.values()) w.stop()
    for (const s of this.sockets.values()) s.destroy()
    this.watches.clear()
    this.sockets.clear()
  }
}

let current: TeamSync | null = null

export const teamSync = () => current

export function startTeamSync(core: CoreClient, relay: RelayConfig | null, onStopped: (title: string, from: string | null) => void) {
  current?.stop()
  current = new TeamSync(core, relay, onStopped)
  return () => {
    current?.stop()
    current = null
  }
}
