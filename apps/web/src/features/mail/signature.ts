import { generateHTML, generateJSON } from "@tiptap/core"

import { MAIL_EXTENSIONS } from "./use-rich-editor"

/**
 * A signature as the composer holds it: the standard `-- ` delimiter line,
 * then the signature, normalized through the editor's schema so it can be
 * found again in the editor's HTML (to swap it when the From account changes).
 */
export function signatureBlock(html: string | undefined): string {
  if (!html) return ""
  return generateHTML(generateJSON(`<p>-- </p>${html}`, MAIL_EXTENSIONS), MAIL_EXTENSIONS)
}

/**
 * Add a signature to a new draft. It goes under the first (empty) paragraph,
 * so replies and forwards keep it above the quoted message.
 */
export function withSignature(html: string, block: string): string {
  if (!block || html.includes(block)) return html
  if (!html.trim()) return `<p></p>${block}`
  if (html.startsWith("<p></p>")) return `<p></p>${block}${html.slice("<p></p>".length)}`
  return html
}
