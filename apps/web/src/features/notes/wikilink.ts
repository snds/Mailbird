import { InputRule, Node, mergeAttributes, nodePasteRule } from "@tiptap/core"
import type { Node as PmNode } from "@tiptap/pm/model"
import type { EditorState, Transaction } from "@tiptap/pm/state"

/** `[[Note]]`, `[[Note|shown]]`, or `[[Note#Heading]]`: no brackets or line breaks inside. */
const WIKI = /^\[\[([^[\]|\n]+?)(?:\|([^[\]\n]+?))?\]\]/

/**
 * A link to another note by its title, written `[[Title]]` in the Markdown
 * as Obsidian and Bear do (ADR-0034). It's an inline atom, so the Markdown
 * keeps plain brackets instead of escaping them, and the whole link moves
 * as one piece while editing.
 */
export const WikiLink = Node.create({
  name: "wikiLink",
  inline: true,
  group: "inline",
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      target: { default: "" },
      label: { default: null },
    }
  },

  parseHTML() {
    return [{ tag: "a[data-wikilink]", getAttrs: (el) => ({ target: (el as HTMLElement).dataset.wikilink ?? "", label: (el as HTMLElement).dataset.label ?? null }) }]
  },

  renderHTML({ node, HTMLAttributes }) {
    const { target, label } = node.attrs as { target: string; label: string | null }
    return [
      "a",
      mergeAttributes(HTMLAttributes, { "data-wikilink": target, "data-label": label ?? undefined, href: "#", class: "wikilink", title: `Open “${target}”` }),
      label || target,
    ]
  },

  renderText({ node }) {
    return node.attrs.label || node.attrs.target
  },

  markdownTokenizer: {
    name: "wikiLink",
    level: "inline",
    start: (src: string) => src.indexOf("[["),
    tokenize: (src: string) => {
      const m = WIKI.exec(src)
      if (!m) return undefined
      return { type: "wikiLink", raw: m[0], target: m[1]!.trim(), label: m[2]?.trim() || null }
    },
  },

  parseMarkdown: (token) => ({ type: "wikiLink", attrs: { target: token.target, label: token.label ?? null } }),

  renderMarkdown: (node) => {
    const { target, label } = (node.attrs ?? {}) as { target?: string; label?: string | null }
    return label ? `[[${target}|${label}]]` : `[[${target}]]`
  },

  addPasteRules() {
    // Pasted `[[Title]]` text (from Obsidian, say) becomes links too.
    return [
      nodePasteRule({
        find: /\[\[([^[\]|\n]+?)(?:\|([^[\]\n]+?))?\]\]/g,
        type: this.type,
        getAttributes: (m) => ({ target: m[1]?.trim(), label: m[2]?.trim() || null }),
      }),
    ]
  },

  addInputRules() {
    // Typing the closing `]]` turns `[[Title]]` into a link.
    return [
      new InputRule({
        find: /\[\[([^[\]|\n]+?)(?:\|([^[\]\n]+?))?\]\]$/,
        handler: ({ state, range, match }) => {
          const target = match[1]?.trim()
          if (!target) return null
          state.tr.replaceWith(range.from, range.to, this.type.create({ target, label: match[2]?.trim() || null }))
        },
      }),
    ]
  },
})

/** The title a link opens: `Note#Heading` opens "Note". */
export const linkTitle = (target: string) => target.split("#")[0]!.trim()

/**
 * Turns `[[Title]]` that's still plain text into links: notes opened before
 * links existed, or synced from a device that hadn't updated yet. Skips code.
 * Returns null when there's nothing to change.
 */
export function linkPlainWikiText(state: EditorState): Transaction | null {
  const type = state.schema.nodes.wikiLink
  if (!type) return null
  const found: { from: number; to: number; target: string; label: string | null }[] = []
  state.doc.descendants((node: PmNode, pos: number, parent: PmNode | null) => {
    if (!node.isText || parent?.type.spec.code || node.marks.some((m) => m.type.spec.code)) return
    const re = /\[\[([^[\]|\n]+?)(?:\|([^[\]\n]+?))?\]\]/g
    for (const m of node.text!.matchAll(re)) {
      if (m[1]!.trim()) found.push({ from: pos + m.index, to: pos + m.index + m[0].length, target: m[1]!.trim(), label: m[2]?.trim() || null })
    }
  })
  if (!found.length) return null
  const tr = state.tr
  // From the end, so earlier positions stay valid.
  for (const f of found.reverse()) tr.replaceWith(f.from, f.to, type.create({ target: f.target, label: f.label }))
  return tr.setMeta("addToHistory", false)
}
