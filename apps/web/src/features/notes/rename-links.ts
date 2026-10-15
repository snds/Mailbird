import * as Y from "yjs"

import { getCoreClient } from "@/core/client"
import { queryClient } from "@/core/queries"

import { linkTitle } from "./wikilink"
import { FIELD, isEmpty, loadDoc, markdownOf, seed, stateOf } from "./ydoc"

/** `Old#Heading` → `New#Heading`: keeps what follows the title. */
const renamed = (target: string, next: string) => {
  const hash = target.indexOf("#")
  return hash < 0 ? next : `${next}${target.slice(hash)}`
}

/** Points every `[[old]]` link element in a note's document at `next`. Returns how many changed. */
export function renameInDoc(doc: Y.Doc, old: string, next: string): number {
  const was = old.trim().toLowerCase()
  let n = 0
  const walk = (node: Y.XmlFragment | Y.XmlElement) => {
    for (const child of node.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue
      const target = child.getAttribute("target")
      if (child.nodeName === "wikiLink" && typeof target === "string" && linkTitle(target).toLowerCase() === was) {
        child.setAttribute("target", renamed(target, next))
        n++
      }
      walk(child)
    }
  }
  doc.transact(() => walk(doc.getXmlFragment(FIELD)), "rename")
  return n
}

/**
 * After a note is renamed, updates the `[[links]]` in other notes that still
 * name its old title (ADR-0035). Each edit goes through that note's own Yjs
 * document, like typing would, so it merges with edits on other devices and
 * syncs as an ordinary change. Returns how many notes changed.
 */
export async function renameLinks(old: string, next: string, except: string): Promise<number> {
  const core = await getCoreClient()
  let changed = 0
  for (const s of await core.notesLinkingTo(old, except)) {
    const note = await core.getNote(s.id)
    const doc = loadDoc(note.ydoc)
    if (isEmpty(doc)) seed(doc, note.markdown, note.id)
    if (renameInDoc(doc, old, next) > 0) {
      await core.saveNoteBody(note.id, markdownOf(doc), stateOf(doc), true)
      changed++
    }
  }
  await queryClient.invalidateQueries({ queryKey: ["notes"] })
  return changed
}
