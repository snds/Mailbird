import type { JSONContent } from "@tiptap/core"
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap"
import * as Y from "yjs"

import { markdown, noteSchema } from "./extensions"

/** The Yjs field Tiptap's Collaboration extension edits. */
export const FIELD = "default"

export function toBase64(bytes: Uint8Array): string {
  let s = ""
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

/** A note's Yjs document from its saved state (or a new, empty one). */
export function loadDoc(state: string | null): Y.Doc {
  const doc = new Y.Doc()
  if (state) Y.applyUpdate(doc, fromBase64(state), "load")
  return doc
}

export const isEmpty = (doc: Y.Doc) => doc.getXmlFragment(FIELD).length === 0

/** A Yjs client id (a 32-bit number) that is the same for a note on every device. */
function seedClient(noteId: string): number {
  let h = 2166136261
  for (let i = 0; i < noteId.length; i++) h = Math.imul(h ^ noteId.charCodeAt(i), 16777619)
  return h >>> 0
}

/**
 * Gives a note that has never been opened in an editor (new, or imported)
 * its Yjs content, from its Markdown.
 *
 * The seed is written as one fixed client (from the note id), so seeding
 * the same Markdown twice, say by the background sync and the editor at
 * once, makes identical Yjs items that merge into one copy instead of two.
 */
export function seed(doc: Y.Doc, md: string, noteId: string) {
  if (!isEmpty(doc) || !md.trim()) return
  const own = doc.clientID
  doc.clientID = seedClient(noteId)
  try {
    doc.transact(() => prosemirrorJSONToYXmlFragment(noteSchema, markdown.parse(md), doc.getXmlFragment(FIELD)), "seed")
  } finally {
    doc.clientID = own
  }
}

export function markdownOf(doc: Y.Doc): string {
  const json = yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment(FIELD), noteSchema).toJSON() as JSONContent
  // The editor keeps an empty paragraph at the end to type into; it isn't
  // text (and would serialize as "&nbsp;").
  while (json.content?.length && json.content.at(-1)!.type === "paragraph" && !json.content.at(-1)!.content?.length) json.content.pop()
  return markdown.serialize(json).trim()
}

export const stateOf = (doc: Y.Doc) => toBase64(Y.encodeStateAsUpdate(doc))
