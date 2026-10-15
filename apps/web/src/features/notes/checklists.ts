import { Extension } from "@tiptap/core"
import { Fragment, type Node as PMNode } from "@tiptap/pm/model"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Mapping, Transform } from "@tiptap/pm/transform"
import { updateYFragment, yXmlFragmentToProseMirrorRootNode, ySyncPluginKey } from "@tiptap/y-tiptap"

import type { CoreClient } from "@/core/client"
import type { NoteTask } from "@/core/types"

import { noteSchema } from "./extensions"
import { FIELD, isEmpty, loadDoc, markdownOf, seed, stateOf } from "./ydoc"

/**
 * Checklists (ADR-0028): checked items sink below unchecked ones, and a
 * task can be checked off from outside its note (the calendar's Tasks).
 * Both edit the note's Yjs document, so they sync like typing does.
 */

const sortKey = new PluginKey("sortChecked")

/** Puts a checklist's unchecked items first, keeping each group's order. */
function sortList(tr: Transform, listPos: number) {
  const list = tr.doc.nodeAt(listPos)
  if (list?.type.name !== "taskList") return
  const items: PMNode[] = []
  list.forEach((c) => items.push(c))
  const sorted = [...items.filter((c) => !c.attrs.checked), ...items.filter((c) => c.attrs.checked)]
  if (sorted.every((c, i) => c === items[i])) return
  tr.replaceWith(listPos + 1, listPos + 1 + list.content.size, Fragment.from(sorted))
}

/** Every checklist item in document order (nested ones included), with its list. */
function taskItems(doc: PMNode) {
  const out: { node: PMNode; pos: number; listPos: number }[] = []
  doc.descendants((node, pos) => {
    if (node.type.name === "taskItem") out.push({ node, pos, listPos: doc.resolve(pos).before() })
  })
  return out
}

/** Moves a checked item down its list as it's checked; turn off in Settings. */
export const SortChecked = Extension.create<{ enabled: () => boolean }>({
  name: "sortChecked",
  addOptions: () => ({ enabled: () => true }),
  addProseMirrorPlugins() {
    const enabled = this.options.enabled
    return [
      new Plugin({
        key: sortKey,
        appendTransaction(trs, old, state) {
          if (!enabled() || !trs.some((t) => t.docChanged)) return null
          // Our own sort, and other devices' edits (they sorted at their end).
          if (trs.some((t) => t.getMeta(sortKey) || t.getMeta(ySyncPluginKey)?.isChangeOrigin)) return null
          const back = new Mapping(trs.flatMap((t) => t.mapping.maps)).invert()
          const lists = new Set<number>()
          for (const { node, pos, listPos } of taskItems(state.doc)) {
            const before = old.doc.nodeAt(back.map(pos))
            if (before?.type.name === "taskItem" && before.attrs.checked !== node.attrs.checked) lists.add(listPos)
          }
          if (!lists.size) return null
          const tr = state.tr
          // Deepest first: sorting an inner list doesn't move the outer one's start.
          for (const p of [...lists].sort((a, b) => b - a)) sortList(tr, p)
          return tr.docChanged ? tr.setMeta(sortKey, true) : null
        },
      }),
    ]
  },
})

const words = (s: string) => s.trim().toLowerCase()

/**
 * Checks a task on or off in its note, from anywhere. The item is found by
 * its place, confirmed by its words (else the first item with those words),
 * so an edit elsewhere in the note doesn't tick the wrong one.
 */
export async function setTaskDone(core: CoreClient, task: NoteTask, done: boolean, sort: boolean) {
  const note = await core.getNote(task.noteId)
  const doc = loadDoc(note.ydoc)
  if (isEmpty(doc)) seed(doc, note.markdown, task.noteId)
  const fragment = doc.getXmlFragment(FIELD)
  const pm = yXmlFragmentToProseMirrorRootNode(fragment, noteSchema)
  const items = taskItems(pm)
  const same = (i: { node: PMNode }) => words(i.node.firstChild?.textContent ?? "") === words(task.text)
  const item = (items[task.index] && same(items[task.index]!) ? items[task.index] : items.find(same)) ?? null
  if (!item) throw new Error("That item changed in its note. Open the note to check it off.")
  const tr = new Transform(pm).setNodeMarkup(item.pos, undefined, { ...item.node.attrs, checked: done })
  if (sort) sortList(tr, item.listPos)
  updateYFragment(doc, fragment, tr.doc, { mapping: new Map(), isOMark: new Map() })
  await core.saveNoteBody(task.noteId, markdownOf(doc), stateOf(doc), true)
  doc.destroy()
}
