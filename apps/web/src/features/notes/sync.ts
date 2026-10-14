import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider"
import * as Y from "yjs"
import { create } from "zustand"

import type { CoreClient } from "@/core/client"
import type { NoteRecord, RelayConfig } from "@/core/types"

import { isEmpty, loadDoc, markdownOf, seed, stateOf } from "./ydoc"

/**
 * Notes sync through a Hocuspocus-compatible relay (ADR-0012):
 *
 * - **One index document** holds every note's record (pinned, archived,
 *   tags, links, deleted, `updated`) in a Y.Map. A record is replaced as a
 *   whole and the newest `updated` wins, on the relay and in the core.
 * - **One document per note** holds its text, merged by Yjs, so two people
 *   typing at once both keep their words. The open note stays connected
 *   for live edits; others connect briefly when their record says they
 *   changed, then save Markdown plus state to the core.
 *
 * The relay only ever sees Yjs updates. It isn't end-to-end encrypted, so
 * run your own (tools/notes-relay) or one you trust.
 */

export type SyncStatus = "off" | "connecting" | "synced" | "error"

export const useSyncStatus = create<{ status: SyncStatus; error: string | null }>(() => ({ status: "off", error: null }))

const set = (status: SyncStatus, error: string | null = null) => useSyncStatus.setState({ status, error })

/** Relay URLs must be encrypted unless they stay on this device. */
export function relayUrlProblem(url: string): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return "Enter the relay’s full address, like wss://notes.example.com"
  }
  if (u.protocol === "wss:") return null
  if (u.protocol === "ws:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return null
  return u.protocol === "ws:" ? "Use wss:// — notes never travel unencrypted off this device" : "The address starts with wss://"
}

const PREFIX = "mailbird/"
const CONCURRENCY = 4
const SYNC_TIMEOUT = 15_000

export class NotesSync {
  private socket: HocuspocusProviderWebsocket
  private index = new Y.Doc()
  private records = this.index.getMap<NoteRecord>("notes")
  private indexProvider: HocuspocusProvider
  /** Notes open in an editor, with their live connection. */
  private open = new Map<string, HocuspocusProvider>()
  /** Connections of just-closed notes, finishing their last sends. */
  private closing = new Set<HocuspocusProvider>()
  /** Closed notes being merged in the background; opening one cancels its merge. */
  private background = new Map<string, () => void>()
  /** The `updated` each note's text was last synced at. */
  private syncedAt = new Map<string, number>()
  private queue = new Set<string>()
  private running = 0
  private stopped = false
  private offCore: () => void

  private core: CoreClient
  private relay: RelayConfig

  constructor(core: CoreClient, relay: RelayConfig) {
    this.core = core
    this.relay = relay
    this.socket = new HocuspocusProviderWebsocket({ url: relay.url })
    set("connecting")
    this.indexProvider = this.provider("index", this.index, () => void this.reconcile())
    this.records.observe((e) => {
      if (e.transaction.local) return
      void this.pull()
    })
    this.offCore = core.on("notes:changed", () => this.schedulePush())
  }

  private provider(name: string, document: Y.Doc, onSynced?: () => void) {
    const p = new HocuspocusProvider({
      websocketProvider: this.socket,
      name: PREFIX + name,
      document,
      token: this.relay.token,
      // Each provider is its own session on the shared socket, so closing a
      // note's background merge can't unsubscribe the editor that replaced it.
      sessionAwareness: true,
      // An explicit `undefined` would replace Hocuspocus' default no-op handler.
      ...(onSynced ? { onSynced } : {}),
      onAuthenticationFailed: () => set("error", "The relay refused the token"),
    })
    p.attach()
    return p
  }

  private pushTimer: ReturnType<typeof setTimeout> | undefined
  private schedulePush() {
    clearTimeout(this.pushTimer)
    this.pushTimer = setTimeout(() => void this.push(), 300)
  }

  /** First contact: merge both ways, then catch up every note's text. */
  private async reconcile() {
    if (this.stopped) return
    await this.push()
    await this.pull()
    for (const r of await this.core.noteRecords()) if (!r.deleted) this.enqueue(r.id)
    set("synced")
  }

  /** Local records newer than the index's go up. */
  private async push() {
    if (this.stopped || !this.indexProvider.synced) return
    const local = await this.core.noteRecords()
    this.index.transact(() => {
      for (const r of local) {
        const remote = this.records.get(r.id)
        if (!remote || remote.updated < r.updated) this.records.set(r.id, { ...r, links: r.links.map(({ target: _t, ...l }) => l) })
      }
    })
    // A local text edit bumps `updated`; open notes are already live.
    for (const r of local) if (!r.deleted && !this.open.has(r.id) && this.syncedAt.get(r.id) !== r.updated) this.enqueue(r.id)
  }

  /** Index records newer than ours come down; their text follows. */
  private async pull() {
    if (this.stopped) return
    const changed = await this.core.applyNoteRecords([...this.records.values()])
    for (const id of changed) {
      const r = this.records.get(id)
      if (r && !r.deleted && !this.open.has(id)) this.enqueue(id)
    }
  }

  private enqueue(id: string) {
    this.queue.add(id)
    this.drain()
  }

  private drain() {
    while (!this.stopped && this.running < CONCURRENCY && this.queue.size) {
      const id = this.queue.values().next().value!
      this.queue.delete(id)
      this.running++
      void this.syncText(id)
        .catch((e) => set("error", e instanceof Error ? e.message : String(e)))
        .finally(() => {
          this.running--
          this.drain()
        })
    }
  }

  /** Connects one closed note's document long enough to merge it. */
  private async syncText(id: string) {
    if (this.open.has(id)) return
    const note = await this.core.getNote(id).catch(() => null)
    if (!note) return
    const doc = loadDoc(note.ydoc)
    if (isEmpty(doc)) seed(doc, note.markdown, id)
    const before = stateOf(doc)
    let cancelled = false
    await new Promise<void>((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        p.destroy()
        this.background.delete(id)
        resolve()
      }
      const p = this.provider(`note/${id}`, doc, () => {
        // Let our own updates reach the relay before letting go.
        setTimeout(finish, p.hasUnsyncedChanges ? 300 : 0)
      })
      this.background.set(id, () => {
        cancelled = true
        finish()
      })
      setTimeout(finish, SYNC_TIMEOUT)
    })
    // The note opened meanwhile: its editor holds (and saves) the live copy.
    if (cancelled || this.open.has(id)) return doc.destroy()
    const after = stateOf(doc)
    if (after !== before || !note.ydoc) await this.core.saveNoteBody(id, markdownOf(doc), after, false)
    this.syncedAt.set(id, (await this.core.getNote(id).catch(() => note)).updated)
    doc.destroy()
  }

  /** Live connection for the open note's editor. */
  attach(id: string, doc: Y.Doc): () => void {
    this.queue.delete(id)
    this.background.get(id)?.()
    const p = this.provider(`note/${id}`, doc)
    this.open.set(id, p)
    return () => {
      // Give the last sends a moment, then close. Anything unsent is in the
      // core and merges on the next pass.
      this.open.delete(id)
      this.closing.add(p)
      setTimeout(
        () => {
          p.destroy()
          this.closing.delete(p)
        },
        p.hasUnsyncedChanges ? 500 : 0,
      )
      this.schedulePush()
    }
  }

  stop() {
    this.stopped = true
    clearTimeout(this.pushTimer)
    this.offCore()
    for (const p of [...this.open.values(), ...this.closing.values()]) p.destroy()
    for (const cancel of this.background.values()) cancel()
    this.indexProvider.destroy()
    this.socket.destroy()
    set("off")
  }
}

let current: NotesSync | null = null

export const notesSync = () => current

export function startNotesSync(core: CoreClient, relay: RelayConfig | null) {
  current?.stop()
  current = relay && !relayUrlProblem(relay.url) ? new NotesSync(core, relay) : null
  if (!current) set("off")
  return () => {
    current?.stop()
    current = null
  }
}
