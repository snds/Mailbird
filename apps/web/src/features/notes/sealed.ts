import { HocuspocusProvider, type HocuspocusProviderWebsocket } from "@hocuspocus/provider"
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness"
import * as Y from "yjs"

import { fromBase64, toBase64 } from "@/lib/base64"

/**
 * End-to-end encrypted documents (ADR-0062). The relay keeps each sealed
 * document, `mailbird/x/…`, as a list of updates it can't read: every Yjs
 * update is encrypted here (AES-256-GCM) before it leaves, and only devices
 * with the key can open it.
 *
 * - Your own notes use your sync key, which you copy to each of your devices.
 * - A share uses its own key, which its link carries after `#`. Your devices
 *   learn it from the note's record, which syncs sealed under your sync key.
 *
 * Each document gets its own key, derived (HKDF) from the root key and its
 * name, so one document's updates never open as another's.
 */

/** The relay's name for a document's sealed copy. */
export const sealedName = (name: string) => name.replace(/^mailbird\//, "mailbird/x/")

/** A new root key: 32 random bytes, base64url, as keys are copied and linked. */
export function newKey(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(32))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

/** Whether text is a whole key, as copied. */
export const isKey = (k: string) => /^[A-Za-z0-9_-]{43}$/.test(k.trim())

const keyBytes = (k: string) => fromBase64(k.trim().replaceAll("-", "+").replaceAll("_", "/") + "=")
const SALT = new TextEncoder().encode("mailbird-sealed-v1")

/** The key for one document, from a root key. */
export async function documentKey(root: string, name: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", keyBytes(root), "HKDF", false, ["deriveKey"])
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: SALT, info: new TextEncoder().encode(name) }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])
}

/** Encrypts bytes as base64: a fresh 12-byte IV, then the ciphertext. */
export async function seal(key: CryptoKey, bytes: Uint8Array): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes as Uint8Array<ArrayBuffer>))
  const out = new Uint8Array(12 + ct.length)
  out.set(iv)
  out.set(ct, 12)
  return toBase64(out)
}

/** Decrypts what `seal` made; throws if the key is wrong or it was changed. */
export async function unseal(key: CryptoKey, b64: string): Promise<Uint8Array> {
  const all = fromBase64(b64)
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: all.subarray(0, 12) }, key, all.subarray(12)))
}

/** An empty Yjs update: nothing to send. */
const empty = (u: Uint8Array) => u.length <= 2

/** Folds the log into one update once it's this long. */
const COMPACT_AT = 40

export const WRONG_KEY = "This encryption key doesn't open what's on the relay. Copy it again from a device that syncs."

export interface SealedOptions {
  websocketProvider: HocuspocusProviderWebsocket
  /** The plain name (`mailbird/note/<id>`); the relay sees its sealed name. */
  name: string
  document: Y.Doc
  token: string
  /** The root key: your sync key, or the share's. */
  rootKey: string
  onSynced?: () => void
  onAuthenticationFailed?: (data: { reason: string }) => void
  onClose?: () => void
}

type Message = { t: "log"; items: string[] } | { t: "u"; u: string } | { t: "p"; u: string } | { t: "ok" | "no"; id: number } | { t: "purged" }

/**
 * A sealed document's connection. It looks like a HocuspocusProvider to the
 * code that syncs (`synced`, `hasUnsyncedChanges`, `awareness`, `attach`,
 * `destroy`), so notes, shares, and their files don't care which they have.
 * Underneath it's one, on a placeholder document, speaking only in stateless
 * messages the relay keeps without reading.
 */
export class SealedProvider {
  readonly awareness: Awareness
  readonly document: Y.Doc
  private inner: HocuspocusProvider
  private key: Promise<CryptoKey>
  /** Messages and sends, one at a time and in order: decrypting takes a moment. */
  private chain: Promise<void> = Promise.resolve()
  private busy = 0
  private unacked = new Set<number>()
  private next = 0
  private ready = false
  private gone = false
  private o: SealedOptions

  constructor(o: SealedOptions) {
    this.o = o
    this.document = o.document
    this.key = documentKey(o.rootKey, sealedName(o.name))
    this.awareness = new Awareness(o.document)
    this.inner = new HocuspocusProvider({
      websocketProvider: o.websocketProvider,
      name: sealedName(o.name),
      document: new Y.Doc(),
      token: o.token,
      // Who's here travels sealed too, below.
      awareness: null,
      sessionAwareness: true,
      onSynced: () => this.pull(),
      onStateless: ({ payload }) => this.heard(payload),
      onAuthenticationFailed: (d) => o.onAuthenticationFailed?.(d),
      onClose: () => {
        this.ready = false
        this.unacked.clear()
        o.onClose?.()
      },
    })
    o.document.on("update", this.onUpdate)
    this.awareness.on("update", this.onAwareness)
  }

  get synced() {
    return this.ready
  }

  get hasUnsyncedChanges() {
    return this.busy > 0 || this.unacked.size > 0
  }

  attach() {
    this.inner.attach()
  }

  setAwarenessField(field: string, value: unknown) {
    this.awareness.setLocalStateField(field, value)
  }

  private send(o: object) {
    this.inner.sendStateless(JSON.stringify(o))
  }

  private run(work: () => Promise<void>) {
    this.busy++
    this.chain = this.chain
      .then(() => (this.gone ? undefined : work()))
      .catch(() => {})
      .finally(() => this.busy--)
  }

  private pull() {
    this.send({ t: "pull" })
  }

  private purged: (() => void) | null = null
  /**
   * Your sealed index only: asks the relay to drop every readable document
   * it has, for good. Your devices hold their own copies, so nothing is lost.
   */
  purge(): Promise<void> {
    return new Promise((resolve) => {
      this.purged = resolve
      this.send({ t: "purge" })
    })
  }

  private heard(payload: string) {
    let m: Message
    try {
      m = JSON.parse(payload)
    } catch {
      return
    }
    if (m.t === "ok" || m.t === "no") return void this.unacked.delete(m.id)
    if (m.t === "purged") return this.purged?.()
    this.run(async () => {
      const key = await this.key
      if (m.t === "log") return this.caughtUp(key, m.items)
      if (m.t === "u") return Y.applyUpdate(this.document, await unseal(key, m.u), this)
      if (m.t !== "p") return
      const had = new Set(this.awareness.getStates().keys())
      applyAwarenessUpdate(this.awareness, await unseal(key, m.u), this)
      // Someone new: tell them who's here (only then, or two devices would answer each other forever).
      if (this.ready && [...this.awareness.getStates().keys()].some((id) => !had.has(id))) await this.sendAwareness([this.document.clientID])
    })
  }

  /** The whole log arrived: merge it, send what it lacks, and tidy it if it's long. */
  private async caughtUp(key: CryptoKey, items: string[]) {
    let opened: Uint8Array[]
    try {
      opened = await Promise.all(items.map((i) => unseal(key, i)))
    } catch {
      return this.o.onAuthenticationFailed?.({ reason: WRONG_KEY })
    }
    const theirs = opened.length ? Y.mergeUpdates(opened) : new Uint8Array([0, 0])
    if (opened.length) Y.applyUpdate(this.document, theirs, this)
    const missing = Y.encodeStateAsUpdate(this.document, Y.encodeStateVectorFromUpdate(theirs))
    if (!empty(missing)) await this.push(key, missing)
    if (items.length >= COMPACT_AT) this.send({ t: "compact", upto: items.length, u: await seal(key, theirs) })
    this.ready = true
    await this.sendAwareness([this.document.clientID])
    this.o.onSynced?.()
  }

  private async push(key: CryptoKey, update: Uint8Array) {
    const id = ++this.next
    this.unacked.add(id)
    this.send({ t: "push", id, u: await seal(key, update) })
  }

  private onUpdate = (update: Uint8Array, origin: unknown) => {
    // Before the first catch-up, what's new here goes with it.
    if (origin === this || !this.ready) return
    this.run(async () => this.push(await this.key, update))
  }

  private onAwareness = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    if (origin === this || !this.ready) return
    const mine = [...added, ...updated, ...removed].filter((id) => id === this.document.clientID)
    if (mine.length) this.run(() => this.sendAwareness(mine))
  }

  private async sendAwareness(ids: number[]) {
    this.send({ t: "p", u: await seal(await this.key, encodeAwarenessUpdate(this.awareness, ids)) })
  }

  destroy() {
    if (this.gone) return
    this.o.document.off("update", this.onUpdate)
    this.awareness.off("update", this.onAwareness)
    // Say goodbye sealed, then let go.
    removeAwarenessStates(this.awareness, [this.document.clientID], this)
    const bye = this.ready ? this.sendAwareness([this.document.clientID]) : Promise.resolve()
    this.gone = true
    void bye.finally(() => {
      this.awareness.destroy()
      this.inner.destroy()
    })
  }
}

/** Either kind of connection, as the code that syncs uses them. */
export type DocProvider = HocuspocusProvider | SealedProvider
