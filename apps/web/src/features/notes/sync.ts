import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider"
import * as Y from "yjs"
import { create } from "zustand"

import type { CoreClient } from "@/core/client"
import type { NoteFile, NoteRecord, NoteShare, NotesLockSetting, RelayConfig } from "@/core/types"

import { activeOwnerShare } from "./share-link"
import { SharedDocWatch } from "./shared-docs"
import { FIELD, isEmpty, loadDoc, markdownOf, seed, stateOf } from "./ydoc"

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
 * run your own (tools/notes-relay) or one you trust. Locked notes are the
 * exception (ADR-0043): their text travels sealed in the record, their own
 * document is emptied when they're locked and never synced while they are,
 * and the passphrase's salt and check ride in the index for other devices.
 *
 * Images (ADR-0044) have their facts in the index's `files` map and their
 * bytes in a document each (`file/<id>`), written before the record so a
 * device that sees the record finds the bytes. A locked note's images
 * travel sealed.
 *
 * Shared notes (ADR-0056) keep their text in `shared/<id>` instead, and stay
 * connected to it (SharedDocWatch), since the people they're shared with
 * edit them without touching the index. The index's `shares` map is the
 * relay's list of which links still work. Notes shared *with* you sync on
 * the owner's relay (GuestShares), never on yours.
 */

/** A share as the relay reads it from the index (tools/notes-relay): a note's, or a shared conversation's (ADR-0060). */
interface ShareEntry {
  note?: string
  thread?: string
  mode: NoteShare["mode"]
  revoked: boolean
  updated: number
}

/** Text that syncs somewhere other than `note/<id>`. */
const elsewhere = (r: { share?: NoteShare | null }) => activeOwnerShare(r.share) || r.share?.role === "guest"

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
  /** The locked-notes passphrase setting, one entry: newest `updated` wins. */
  private lockSetting = this.index.getMap<NotesLockSetting>("lock")
  /** Every image's facts; the bytes are in `file/<id>`. Newest `updated` wins. */
  private fileRecords = this.index.getMap<NoteFile>("files")
  /** Shares by id: which note, editable or not, and whether it was stopped. */
  private shares = this.index.getMap<ShareEntry>("shares")
  /** Notes you've shared, each connected to its shared document. */
  private shared = new Map<string, SharedDocWatch>()
  private sharedOpen = new Set<string>()
  /** Images moving now, one at a time so a big first sync doesn't flood the relay. */
  private filesBusy = new Set<string>()
  private fileChain: Promise<void> = Promise.resolve()
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
    this.fileRecords.observe((e) => {
      if (!e.transaction.local) void this.pullFiles()
    })
    this.lockSetting.observe((e) => {
      if (e.transaction.local) return
      const remote = this.lockSetting.get("setting")
      if (remote) void this.core.applyNotesLockSetting(remote)
    })
    const offNotes = core.on("notes:changed", () => this.schedulePush())
    const offTeam = core.on("team:changed", () => this.schedulePush())
    this.offCore = () => (offNotes(), offTeam())
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
    for (const r of await this.core.noteRecords()) if (!r.deleted && !elsewhere(r)) this.enqueue(r.id)
    set("synced")
  }

  /** Local records newer than the index's go up. */
  private async push() {
    if (this.stopped || !this.indexProvider.synced) return
    const local = await this.core.noteRecords()
    const lock = await this.core.notesLockSetting()
    const team = await this.core.teamThreads().catch(() => [])
    this.index.transact(() => {
      // Shared conversations: teammates edit their comments and reply, so the link allows editing.
      for (const t of team) {
        if (t.role !== "owner" || !t.threadId) continue
        const entry: ShareEntry = { thread: t.threadId, mode: "edit", revoked: t.revoked, updated: t.updated }
        const was = this.shares.get(t.id)
        if (!was || (was.updated < entry.updated && was.revoked !== entry.revoked)) this.shares.set(t.id, entry)
      }
      const remote = this.lockSetting.get("setting")
      if (lock && (!remote || remote.updated < lock.updated)) this.lockSetting.set("setting", lock)
      for (const r of local) {
        const remote = this.records.get(r.id)
        if (!remote || remote.updated < r.updated) this.records.set(r.id, { ...r, links: r.links.map(({ target: _t, ...l }) => l) })
        // The relay's list of shares, before anyone uses the link. A deleted note's link stops working.
        if (r.share?.role === "owner") {
          const entry: ShareEntry = { note: r.id, mode: r.share.mode, revoked: !!r.share.revoked || r.deleted, updated: r.updated }
          const was = this.shares.get(r.share.id)
          if (!was || (was.updated < entry.updated && (was.mode !== entry.mode || was.revoked !== entry.revoked))) this.shares.set(r.share.id, entry)
        }
      }
    })
    // A local text edit bumps `updated`; open notes are already live.
    for (const r of local) if (!r.deleted && !elsewhere(r) && !this.open.has(r.id) && this.syncedAt.get(r.id) !== r.updated) this.enqueue(r.id)
    this.watchShares(local)
    await this.pushFiles()
  }

  /** Images newer here go up: bytes first, then the record that points at them. */
  private async pushFiles() {
    for (const f of await this.core.noteFileRecords()) {
      const remote = this.fileRecords.get(f.id)
      if ((remote && remote.updated >= f.updated) || this.filesBusy.has(f.id)) continue
      this.moveFile(f.id, async (bytes) => {
        bytes.set("raw", await this.core.noteFileRaw(f.id))
        bytes.set("updated", f.updated)
      }, () => this.fileRecords.set(f.id, f))
    }
  }

  /** Images newer on the relay come down. */
  private async pullFiles() {
    if (this.stopped) return
    const local = new Map((await this.core.noteFileRecords()).map((f) => [f.id, f.updated]))
    for (const f of this.fileRecords.values()) {
      if ((local.get(f.id) ?? -1) >= f.updated || this.filesBusy.has(f.id)) continue
      this.moveFile(f.id, async (bytes) => {
        const raw = bytes.get("raw")
        const at = bytes.get("updated")
        if (typeof raw === "string" && typeof at === "number" && at >= f.updated) await this.core.putNoteFile(f, raw)
      })
    }
  }

  /** Opens one image's document, does `work` once it's synced, waits for the sends, and closes. */
  private moveFile(id: string, work: (bytes: Y.Map<unknown>) => Promise<void>, then?: () => void) {
    this.filesBusy.add(id)
    this.fileChain = this.fileChain.then(async () => {
      if (this.stopped) return
      const doc = new Y.Doc()
      try {
        await new Promise<void>((resolve, reject) => {
          let done = false
          const finish = (e?: unknown) => {
            if (done) return
            done = true
            p.destroy()
            if (e) reject(e)
            else resolve()
          }
          const p = this.provider(`file/${id}`, doc, () => {
            work(doc.getMap("file")).then(
              // Let the bytes reach the relay before letting go.
              () => setTimeout(() => finish(), p.hasUnsyncedChanges ? 500 : 0),
              finish,
            )
          })
          setTimeout(() => finish(new Error("An image took too long to sync")), SYNC_TIMEOUT * 2)
        })
        then?.()
      } catch (e) {
        set("error", e instanceof Error ? e.message : String(e))
      } finally {
        doc.destroy()
        this.filesBusy.delete(id)
      }
    })
  }

  /** Index records newer than ours come down; their text follows. */
  private async pull() {
    if (this.stopped) return
    // The passphrase setting first, so a locked note that arrives can be opened.
    const lock = this.lockSetting.get("setting")
    if (lock) await this.core.applyNotesLockSetting(lock)
    const changed = await this.core.applyNoteRecords([...this.records.values()])
    for (const id of changed) {
      const r = this.records.get(id)
      if (r && !r.deleted && !elsewhere(r) && !this.open.has(id)) this.enqueue(id)
    }
    if (changed.length) this.watchShares(await this.core.noteRecords())
    await this.pullFiles()
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

  /** Keeps each note you share connected to its shared document; lets go of stopped ones. */
  private watchShares(records: NoteRecord[]) {
    if (this.stopped) return
    const live = new Map(records.filter((r) => !r.deleted && activeOwnerShare(r.share)).map((r) => [r.id, r]))
    for (const [id, w] of this.shared) {
      if (live.get(id)?.share?.id !== w.o.share.id) {
        w.stop()
        this.shared.delete(id)
      }
    }
    for (const [id, r] of live) {
      const w = this.shared.get(id)
      if (w) {
        void w.mergeFromCore(r.updated)
        if (w.o.share.mode !== r.share!.mode) w.setMode(r.share!.mode)
      } else this.watchShare(id, r.share!)
    }
  }

  private watchShare(id: string, share: NoteShare) {
    const w = new SharedDocWatch({ core: this.core, socket: this.socket, noteId: id, share, token: this.relay.token, owner: true, isOpen: (n) => this.sharedOpen.has(n), onDenied: () => set("error", "The relay refused the token") })
    this.shared.set(id, w)
    return w
  }

  /** Connects one closed note's document long enough to merge it. */
  private async syncText(id: string) {
    if (this.open.has(id)) return
    const note = await this.core.getNote(id).catch(() => null)
    // A locked note's text isn't in its document; its record carries it sealed.
    // A shared one's is in its shared document, which stays connected.
    if (!note || note.locked || elsewhere(note)) return
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

  /**
   * Empties a just-locked note's shared document, so the relay keeps no
   * readable copy (ADR-0043). Yjs drops deleted text from a document's
   * state, so what the relay stores from then on is an empty note.
   */
  async blank(id: string) {
    this.queue.delete(id)
    this.background.get(id)?.()
    const doc = new Y.Doc()
    await new Promise<void>((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        p.destroy()
        resolve()
      }
      const p = this.provider(`note/${id}`, doc, () => {
        const text = doc.getXmlFragment(FIELD)
        if (text.length) doc.transact(() => text.delete(0, text.length), "lock")
        setTimeout(finish, p.hasUnsyncedChanges ? 500 : 0)
      })
      setTimeout(finish, SYNC_TIMEOUT)
    })
    doc.destroy()
  }

  /** Live connection for the open note's editor. */
  attach(id: string, doc: Y.Doc, share?: NoteShare | null): () => void {
    this.queue.delete(id)
    this.background.get(id)?.()
    // Just shared, or just stopped: change documents now, not on the next push.
    let shared = this.shared.get(id)
    if (shared && share !== undefined && (!activeOwnerShare(share) || shared.o.share.id !== share!.id)) {
      shared.stop()
      this.shared.delete(id)
      shared = undefined
    }
    if (!shared && share && activeOwnerShare(share)) shared = this.watchShare(id, share)
    if (shared) {
      this.sharedOpen.add(id)
      const detach = shared.attach(doc)
      return () => {
        this.sharedOpen.delete(id)
        detach()
        this.schedulePush()
      }
    }
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
    for (const w of this.shared.values()) w.stop()
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
