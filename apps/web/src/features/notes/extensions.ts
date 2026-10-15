import { getSchema, type AnyExtension, type JSONContent } from "@tiptap/core"
import { TaskItem, TaskList } from "@tiptap/extension-list"
import { Markdown, MarkdownManager } from "@tiptap/markdown"
import StarterKit from "@tiptap/starter-kit"

import { NoteImage } from "./note-file"
import { WikiLink } from "./wikilink"

/** Only web and mail links; Tiptap's own check already refuses `javascript:`. */
export const SAFE_LINK = /^(https?:|mailto:)/i

/**
 * The note document: everything Markdown can say that people use in notes
 * (headings, lists, checklists, quotes, code, links, images, and `[[links]]`
 * to other notes). The same list builds
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
  WikiLink,
  NoteImage,
  Markdown,
]

export const noteSchema = getSchema(noteExtensions)

export const markdown = new MarkdownManager({ extensions: noteExtensions })

/** Block containers whose inline children must sit in a paragraph. */
const BLOCKS = new Set(["doc", "listItem", "taskItem", "blockquote"])
const INLINE = new Set(["text", "noteImage", "wikiLink", "hardBreak"])

/**
 * Tiptap lifts an image that is alone in its paragraph out of it, for block
 * image nodes. Ours is inline (ADR-0044), so two such images would merge
 * into one line; this puts each one back in a paragraph of its own.
 */
function wrapInline(node: JSONContent): JSONContent {
  const content = node.content?.map(wrapInline)
  if (!content) return node
  if (!BLOCKS.has(node.type ?? "")) return { ...node, content }
  return { ...node, content: content.map((c) => (INLINE.has(c.type ?? "") ? { type: "paragraph", content: [c] } : c)) }
}

/** A note's Markdown as a document. */
export const parseNote = (md: string) => wrapInline(markdown.parse(md))
