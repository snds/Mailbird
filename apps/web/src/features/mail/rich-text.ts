/** Conversions between the composer's HTML and the plain-text part every email also carries. */

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
}

/** One paragraph per line, so plain drafts (old outbox items, Undo) load into the editor intact. */
export function textToHtml(text: string) {
  return text
    .split("\n")
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join("")
}

/**
 * The text/plain alternative: paragraphs become lines, quotes get `> `,
 * list items get `- ` or `1. `, and links keep their address in brackets.
 */
export function htmlToText(html: string) {
  const doc = new DOMParser().parseFromString(html, "text/html")
  return blocks(doc.body).join("\n").replace(/\n+$/, "")
}

function inline(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ""
  if (!(node instanceof Element)) return ""
  if (node.tagName === "BR") return "\n"
  const text = [...node.childNodes].map(inline).join("")
  if (node.tagName === "A") {
    const href = node.getAttribute("href") ?? ""
    const shown = href.replace(/^mailto:/, "")
    return href && shown !== text ? `${text} <${shown}>` : text
  }
  return text
}

function blocks(el: Element): string[] {
  const out: string[] = []
  let run = ""
  const flush = () => {
    if (run) out.push(...run.split("\n"))
    run = ""
  }
  for (const child of el.childNodes) {
    if (!(child instanceof Element)) {
      run += inline(child)
      continue
    }
    switch (child.tagName) {
      case "P":
      case "H1":
      case "H2":
      case "H3":
      case "PRE":
        flush()
        out.push(...inline(child).split("\n"))
        break
      case "BLOCKQUOTE":
        flush()
        out.push(...blocks(child).map((l) => (l ? `> ${l}` : ">")))
        break
      case "UL":
      case "OL": {
        flush()
        const ordered = child.tagName === "OL"
        let n = Number(child.getAttribute("start") ?? 1)
        for (const li of child.children) {
          const [first = "", ...rest] = blocks(li)
          const marker = ordered ? `${n++}. ` : "- "
          out.push(marker + first, ...rest.map((l) => " ".repeat(marker.length) + l))
        }
        break
      }
      case "HR":
        flush()
        out.push("---")
        break
      default:
        run += inline(child)
    }
  }
  flush()
  return out
}
