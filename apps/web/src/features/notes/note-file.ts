import { Node, mergeAttributes } from "@tiptap/core"
import { ReactNodeViewRenderer } from "@tiptap/react"

import { NoteImageView } from "./note-image"

/** `]`, `\`, and line breaks would end the alt text early. */
const altText = (s: string) => s.replace(/[\\[\]]/g, "\\$&").replace(/\s*\n\s*/g, " ")

/**
 * An image in a note, written `![alt](note-file:ID)` in the Markdown so the
 * text stays small and mergeable while the bytes sync on their own. Web
 * images (`https:`) stay as they are and load only when asked, like
 * remote images in mail.
 */
export const NoteImage = Node.create({
  name: "noteImage",
  inline: true,
  group: "inline",
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      src: { default: "" },
      alt: { default: "" },
      title: { default: null },
    }
  },

  parseHTML() {
    const attrs = (el: HTMLElement, src: string | null) => ({ src: src ?? "", alt: el.getAttribute("alt") ?? "", title: el.getAttribute("title") })
    return [
      // Ours (copied within the app) first, then images pasted from elsewhere.
      { tag: "img[data-note-src]", getAttrs: (el) => attrs(el as HTMLElement, (el as HTMLElement).dataset.noteSrc ?? null) },
      { tag: "img[src]", getAttrs: (el) => attrs(el as HTMLElement, el.getAttribute("src")) },
    ]
  },

  renderHTML({ HTMLAttributes }) {
    // The address goes in a data attribute: as `src`, the browser would try to
    // load `note-file:` (or a web image nobody asked for) whenever the editor
    // writes HTML, for copying, say. The node view does the real showing.
    const { src, ...rest } = HTMLAttributes as { src?: string }
    return ["img", mergeAttributes(rest, { "data-note-src": src })]
  },

  renderText({ node }) {
    return node.attrs.alt ? `[${node.attrs.alt}]` : ""
  },

  markdownTokenName: "image",

  parseMarkdown: (token) => ({ type: "noteImage", attrs: { src: token.href ?? "", alt: token.text ?? "", title: token.title ?? null } }),

  renderMarkdown: (node) => {
    const { src, alt, title } = (node.attrs ?? {}) as { src?: string; alt?: string; title?: string | null }
    const at = /[\s()]/.test(src ?? "") ? `<${src}>` : src
    return `![${altText(alt ?? "")}](${at}${title ? ` "${title.replace(/"/g, '\\"')}"` : ""})`
  },

  addNodeView() {
    return ReactNodeViewRenderer(NoteImageView)
  },
})

