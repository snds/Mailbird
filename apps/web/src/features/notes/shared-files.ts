import type { HocuspocusProviderWebsocket } from "@hocuspocus/provider"
import * as Y from "yjs"

import type { CoreClient } from "@/core/client"
import type { NoteFile } from "@/core/types"

import { rejoining } from "./shared-docs"

/**
 * Files that travel with a share (ADR-0061): a shared note's images, and the
 * attachments the owner of a shared conversation chooses to share. They live
 * beside the share's own document, in `mailbird/shared/<id>/files`, which
 * the same link opens. Kept apart so saving the text never re-saves the
 * images, and only held in memory: a note's images are saved as the note's
 * own, a conversation's files are downloaded when asked for.
 */
export const filesDocName = (shareId: string) => `mailbird/shared/${shareId}/files`

/** A shared note's image, as the core keeps it, with its bytes (base64). */
export interface SharedImage {
  file: NoteFile
  raw: string
}

/** An attachment the owner shared with the team. */
export interface SharedAttachment {
  id: string
  name: string
  mime: string
  size: number
  /** The message it came with, as its sender. */
  from: string
  at: number
  data: string
}

/** The biggest file a share carries: the size a note image may be. */
export const MAX_SHARED_FILE = 10 * 1024 * 1024

export class SharedFiles {
  readonly doc = new Y.Doc()
  private p: ReturnType<typeof rejoining>
  private stopped = false

  constructor(socket: HocuspocusProviderWebsocket, shareId: string, token: string, on: { synced?: () => void; denied?: () => void; key?: string | null }) {
    this.p = rejoining(socket, filesDocName(shareId), this.doc, token, { key: on.key, synced: on.synced, denied: () => on.denied?.() })
  }

  get images() {
    return this.doc.getMap<SharedImage>("images")
  }

  get attachments() {
    return this.doc.getMap<SharedAttachment>("attachments")
  }

  /** The owner's side: the note's images, as they are now. Unused ones leave. */
  async putImages(core: CoreClient, noteId: string) {
    if (this.stopped) return
    const files = (await core.noteFiles(noteId).catch(() => [] as NoteFile[])).filter((f) => !f.sealed && f.size <= MAX_SHARED_FILE)
    const have = this.images
    const add: SharedImage[] = []
    for (const f of files) {
      const was = have.get(f.id)
      if (was && was.file.updated >= f.updated) continue
      const raw = await core.noteFileRaw(f.id).catch(() => null)
      if (raw) add.push({ file: f, raw })
    }
    const keep = new Set(files.map((f) => f.id))
    const drop = [...have.keys()].filter((id) => !keep.has(id))
    if (!add.length && !drop.length) return
    this.doc.transact(() => {
      for (const i of add) have.set(i.file.id, i)
      for (const id of drop) have.delete(id)
    })
  }

  /** A guest's side: each image the owner shared becomes this note's own, so it shows and stays. */
  takeImages(core: CoreClient, noteId: string) {
    const take = () => {
      for (const { file, raw } of this.images.values()) void core.putNoteFile({ ...file, noteId, sealed: false }, raw).catch(() => {})
    }
    this.images.observe(take)
    take()
  }

  stop() {
    this.stopped = true
    this.p.destroy()
    this.doc.destroy()
  }
}

/** A shared attachment's bytes, ready to save. */
export function attachmentBlob(a: SharedAttachment): Blob {
  const bin = atob(a.data)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: a.mime || "application/octet-stream" })
}
