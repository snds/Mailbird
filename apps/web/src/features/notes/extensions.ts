import { getSchema, type AnyExtension } from "@tiptap/core"
import { TaskItem, TaskList } from "@tiptap/extension-list"
import { Markdown, MarkdownManager } from "@tiptap/markdown"
import StarterKit from "@tiptap/starter-kit"

/** Only web and mail links; Tiptap's own check already refuses `javascript:`. */
export const SAFE_LINK = /^(https?:|mailto:)/i

/**
 * The note document: everything Markdown can say that people use in notes
 * (headings, lists, checklists, quotes, code, links). The same list builds
 * the editor, the schema, and the headless Markdown converter that sync
 * uses, so all three always agree.
 */
export const noteExtensions: AnyExtension[] = [
  StarterKit.configure({
    // Yjs keeps the undo history (per person, across sync) instead.
    undoRedo: false,
    link: { openOnClick: false, autolink: true, defaultProtocol: "https", isAllowedUri: (url, ctx) => SAFE_LINK.test(url) && ctx.defaultValidate(url) },
  }),
  TaskList,
  TaskItem.configure({ nested: true }),
  Markdown,
]

export const noteSchema = getSchema(noteExtensions)

export const markdown = new MarkdownManager({ extensions: noteExtensions })
