import { HocuspocusProvider, HocuspocusProviderWebsocket, WebSocketStatus } from "@hocuspocus/provider"
import * as Y from "yjs"
import { create } from "zustand"

import type { CoreClient } from "@/core/client"
import type { NoteRecord, NoteShare, ShareMode } from "@/core/types"
import { fromBase64 } from "@/lib/base64"

import { type Person, setPeople } from "./presence"
import { type DocProvider, SealedProvider } from "./sealed"
import { SharedFiles } from "./shared-files"
import { type ShareLink, guestShareOf, sharedDocName } from "./share-link"
import { isEmpty, loadDoc, markdownOf, seed, stateOf } from "./ydoc"

/**
 * Shared notes' text (ADR-0056). Each shared note stays connected to its
 * document, `mailbird/shared/<id>`, while the app runs: the other person's
 * edits arrive whether or not the note is open, and are saved to the core.
 * The owner connects with the relay's token (through NotesSync); a guest
 * with the link's token, on the owner's relay (through GuestShares).
 */

const SAVE_DELAY = 400
/** How long adding a link waits for the note's text before showing it anyway. */
const FIRST_SYNC = 8_000

type Ready = "synced" | "denied" | "timeout"

/**
 * What each shared-with-you note allows now, by note id. The owner keeps it
 * in the shared document (its `share` map), so a link turned view-only
 * reaches guests without a new link; the relay enforces it either way.
 */
export const useLiveShareModes = create<Record<string, ShareMode>>(() => ({}))

/**
 * A connection to a shared document that rejoins when the relay closes it
 * (the link turned view-only, or was stopped) while the socket stays up:
 * rejoining is how a guest becomes a reader, or learns the link is gone.
 *
 * With `presence`, it also says who has the document open (ADR-0061):
 * `here(name)` while it's open here, `here(null)` when it closes, and
 * `onPeople` hears everyone else.
 *
 * With `key` (the share's, ADR-0062), the document is end-to-end encrypted.
 */
export function rejoining(
  socket: HocuspocusProviderWebsocket,
  name: string,
  doc: Y.Doc,
  token: string,
  on: { synced?: () => void; denied: () => void; onPeople?: (people: Person[]) => void; key?: string | null },
) {
  let p: DocProvider
  let gone = false
  let me: string | null = null
  const report = () => {
    if (!on.onPeople || !p.awareness) return
    const people: Person[] = []
    p.awareness.getStates().forEach((state, id) => {
      const who = (state as { person?: { name?: unknown } }).person
      if (id !== p.awareness!.clientID && typeof who?.name === "string") people.push({ id, name: who.name })
    })
    on.onPeople(people)
  }
  const join = () => {
    const onClose = () => {
      if (gone || socket.status !== WebSocketStatus.Connected) return
      p.destroy()
      setTimeout(() => !gone && join(), 200)
    }
    const common = { websocketProvider: socket, name, document: doc, token, ...(on.synced ? { onSynced: on.synced } : {}), onAuthenticationFailed: () => on.denied(), onClose }
    p = on.key ? new SealedProvider({ ...common, rootKey: on.key }) : new HocuspocusProvider({ ...common, sessionAwareness: true })
    p.awareness?.on("change", report)
    if (me) p.setAwarenessField("person", { name: me })
    p.attach()
  }
  join()
  return {
    get unsynced() {
      return p.hasUnsyncedChanges
    },
    here(name: string | null) {
      me = name
      p.setAwarenessField("person", name ? { name } : null)
    },
    destroy() {
      gone = true
      on.onPeople?.([])
      p.destroy()
    },
  }
}

export interface WatchOptions {
  core: CoreClient
  socket: HocuspocusProviderWebsocket
  noteId: string
  share: NoteShare
  token: string
  /** The owner seeds the document from the note's text; a guest never does. */
  owner: boolean
  /** The note is open in an editor, which saves it itself. */
  isOpen: (noteId: string) => boolean
  /** The relay refused: the link was stopped (or never worked). */
  onDenied: () => void
}

/** One shared note's document, kept connected; remote edits save to the core. */
export class SharedDocWatch {
  readonly ready: Promise<Ready>
  private doc: Y.Doc | null = null
  private p: ReturnType<typeof rejoining> | null = null
  /** The note's images, beside its text (ADR-0061). */
  private files: SharedFiles | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private saved: string | null = null
  private stopped = false
  private settle: (r: Ready) => void = () => {}
  /** The note's `updated` when its text was last read from the core. */
  updated = 0
  readonly o: WatchOptions

  constructor(o: WatchOptions) {
    this.o = o
    this.ready = new Promise<Ready>((resolve) => (this.settle = resolve))
    setTimeout(() => this.settle("timeout"), FIRST_SYNC)
    void this.start()
  }

  private async start() {
    const { core, noteId } = this.o
    const note = await core.getNote(noteId).catch(() => null)
    if (this.stopped || !note) return
    const doc = loadDoc(note.ydoc)
    if (this.o.owner && isEmpty(doc)) seed(doc, note.markdown, noteId)
    this.doc = doc
    this.updated = note.updated
    this.saved = note.ydoc
    const meta = doc.getMap<string>("share")
    this.p = rejoining(this.o.socket, sharedDocName(this.o.share.id), doc, this.o.token, {
      key: this.o.share.key,
      synced: () => {
        this.settle("synced")
        this.scheduleSave()
        // The owner says what the link allows, for guests to read.
        if (this.o.owner) this.setMode(this.o.share.mode)
      },
      denied: () => {
        this.settle("denied")
        if (!this.stopped) this.o.onDenied()
      },
    })
    doc.on("update", (_u: Uint8Array, origin: unknown) => {
      if (origin !== "core" && origin !== "meta") this.scheduleSave()
    })
    // Images go with the note: the owner puts them up, a guest takes them as their own.
    const owner = this.o.owner
    this.files = new SharedFiles(this.o.socket, this.o.share.id, this.o.token, { key: this.o.share.key, synced: () => owner && void this.files?.putImages(core, noteId) })
    if (!owner) this.files.takeImages(core, noteId)
    if (!this.o.owner) {
      const read = () => {
        const m = meta.get("mode")
        if (m === "edit" || m === "view") useLiveShareModes.setState({ [noteId]: m })
      }
      meta.observe(read)
      read()
    }
  }

  /** The owner changed what the link allows: tell the guests. */
  setMode(mode: ShareMode) {
    this.o.share = { ...this.o.share, mode }
    const meta = this.doc?.getMap<string>("share")
    if (meta && meta.get("mode") !== mode) this.doc!.transact(() => meta.set("mode", mode), "meta")
  }

  private scheduleSave() {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.save(), SAVE_DELAY)
  }

  private async save() {
    const doc = this.doc
    if (!doc || this.stopped || this.o.isOpen(this.o.noteId)) return
    const state = stateOf(doc)
    if (state === this.saved) return
    this.saved = state
    // Their edits, not yours: the note isn't marked edited by you (as in the editor).
    await this.o.core.saveNoteBody(this.o.noteId, markdownOf(doc), state, false).catch(() => {})
    this.updated = (await this.o.core.getNote(this.o.noteId).catch(() => null))?.updated ?? this.updated
  }

  /** The core's copy changed some other way (a checklist tick, a rename): merge it in. */
  async mergeFromCore(updated: number) {
    if (!this.doc || updated <= this.updated) return
    this.updated = updated
    if (this.o.owner) void this.files?.putImages(this.o.core, this.o.noteId)
    const note = await this.o.core.getNote(this.o.noteId).catch(() => null)
    if (note?.ydoc && this.doc) Y.applyUpdate(this.doc, fromBase64(note.ydoc), "core")
  }

  /** A live connection for the note's editor, on the same socket. */
  attach(doc: Y.Doc, me?: string): () => void {
    const id = this.o.share.id
    const p = rejoining(this.o.socket, sharedDocName(id), doc, this.o.token, { key: this.o.share.key, denied: () => this.o.onDenied(), onPeople: (people) => setPeople(id, people) })
    // Open here: the others see you're here (ADR-0061).
    if (me) p.here(me)
    return () => {
      setTimeout(() => p.destroy(), p.unsynced ? 500 : 0)
      // What the editor saved is the core's copy now.
      if (this.doc) this.saved = stateOf(this.doc)
    }
  }

  stop() {
    this.stopped = true
    clearTimeout(this.timer)
    this.p?.destroy()
    this.files?.stop()
    this.doc?.destroy()
    this.settle("timeout")
  }
}

/**
 * Notes others shared with you (ADR-0056). They sync on the owner's relay,
 * with the link's token, whether or not you run a relay of your own. When
 * the owner stops sharing, the note becomes your own copy.
 */
export class GuestShares {
  private sockets = new Map<string, HocuspocusProviderWebsocket>()
  private watches = new Map<string, SharedDocWatch>()
  private open = new Set<string>()
  /** Links being added: a refusal there means the link is dead, not a stop. */
  private adding = new Set<string>()
  private offCore: () => void
  private refreshTimer: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  private core: CoreClient
  private onStopped: (title: string, from: string | null) => void

  constructor(core: CoreClient, onStopped: (title: string, from: string | null) => void) {
    this.core = core
    this.onStopped = onStopped
    this.offCore = core.on("notes:changed", () => {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = setTimeout(() => void this.refresh(), 300)
    })
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

  /** Watch every guest note that's still shared; let go of the rest. */
  async refresh() {
    if (this.stopped) return
    const records = await this.core.noteRecords().catch(() => [] as NoteRecord[])
    const live = new Map(records.filter((r) => !r.deleted && r.share?.role === "guest" && !r.share.revoked && r.share.relay && r.share.token).map((r) => [r.id, r]))
    for (const [id, w] of this.watches) {
      if (!live.has(id) || live.get(id)!.share!.id !== w.o.share.id) {
        w.stop()
        this.watches.delete(id)
      }
    }
    for (const [id, r] of live) {
      const w = this.watches.get(id)
      if (w) void w.mergeFromCore(r.updated)
      else this.watch(id, r.share!)
    }
    for (const [url, s] of this.sockets) {
      if (![...this.watches.values()].some((w) => w.o.share.relay === url)) {
        s.destroy()
        this.sockets.delete(url)
      }
    }
  }

  private watch(noteId: string, share: NoteShare) {
    const w = new SharedDocWatch({
      core: this.core,
      socket: this.socket(share.relay!),
      noteId,
      share,
      token: share.token!,
      owner: false,
      isOpen: (id) => this.open.has(id),
      onDenied: () => void this.denied(noteId),
    })
    this.watches.set(noteId, w)
    return w
  }

  /** The owner stopped sharing: keep what's here as your own note. */
  private async denied(noteId: string) {
    const w = this.watches.get(noteId)
    if (!w || this.adding.has(noteId)) return
    w.stop()
    this.watches.delete(noteId)
    const n = await this.core.unshareNote(noteId).catch(() => null)
    if (n) this.onStopped(n.title, w.o.share.from ?? null)
  }

  /**
   * Adds a note from someone's link, waits for its text, and returns its id.
   * A link already added opens the note it made.
   */
  async add(link: ShareLink): Promise<{ id: string; ready: Ready }> {
    // Your own link (say, in mail you sent) opens your note.
    const existing = (await this.core.noteRecords()).find((r) => !r.deleted && r.share?.id === link.id && (r.share.role === "owner" || !r.share.revoked))
    if (existing) return { id: existing.id, ready: "synced" }
    const note = await this.core.createNote({ markdown: "", share: guestShareOf(link) })
    this.adding.add(note.id)
    try {
      const ready = await this.watch(note.id, note.share!).ready
      if (ready === "denied") {
        this.watches.get(note.id)?.stop()
        this.watches.delete(note.id)
        await this.core.deleteNote(note.id)
        throw new Error("That link doesn't work any more. Ask for a new one.")
      }
      return { id: note.id, ready }
    } finally {
      this.adding.delete(note.id)
    }
  }

  /** Live connection for an open guest note's editor. */
  attach(noteId: string, share: NoteShare, doc: Y.Doc, me?: string): (() => void) | undefined {
    if (this.stopped || share.revoked || !share.relay || !share.token) return undefined
    const w = this.watches.get(noteId) ?? this.watch(noteId, share)
    this.open.add(noteId)
    const detach = w.attach(doc, me)
    return () => {
      this.open.delete(noteId)
      detach()
    }
  }

  stop() {
    this.stopped = true
    clearTimeout(this.refreshTimer)
    this.offCore()
    for (const w of this.watches.values()) w.stop()
    for (const s of this.sockets.values()) s.destroy()
    this.watches.clear()
    this.sockets.clear()
  }
}

let guests: GuestShares | null = null

export const guestShares = () => guests

export function startGuestShares(core: CoreClient, onStopped: (title: string, from: string | null) => void) {
  guests?.stop()
  guests = new GuestShares(core, onStopped)
  return () => {
    guests?.stop()
    guests = null
  }
}
