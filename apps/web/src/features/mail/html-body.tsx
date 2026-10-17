import DOMPurify from "dompurify"
import { useMemo, useRef, useState } from "react"

import { Icon, Button } from "@unicron/ui"
import { useMailPrefs, useSenderProfile } from "@/core/queries"

/**
 * Renders untrusted email HTML.
 * - DOMPurify strips scripts, handlers, and forms.
 * - The iframe sandbox has no `allow-scripts`, so nothing can run even if
 *   something slipped through. `allow-same-origin` only lets us size it.
 * - A CSP blocks remote content by default: tracking pixels never load
 *   until the reader asks for images (Apple Mail / HEY behavior), unless
 *   Advanced settings say to load them always, or for contacts (ADR-0055).
 */
export function HtmlBody({ html, from }: { html: string; from?: string }) {
  const [asked, setRemote] = useState(false)
  const { data: prefs } = useMailPrefs()
  const forContacts = prefs?.images === "contacts"
  const { data: sender } = useSenderProfile(forContacts && from ? from : null)
  const remote = asked || prefs?.images === "always" || (forContacts && !!sender?.contact)
  const frame = useRef<HTMLIFrameElement>(null)

  const { doc, hasRemote } = useMemo(() => {
    // Second line of defense behind the CSP: until the reader consents, remote
    // URLs are removed from the markup, so no WebView ever attempts the fetch.
    let hasRemote = false
    const isRemote = (v: string | null) => !!v && /^\s*(https?:)?\/\//i.test(v)
    DOMPurify.addHook("afterSanitizeAttributes", (node) => {
      for (const attr of ["src", "srcset", "background", "poster"]) {
        if (isRemote(node.getAttribute(attr))) {
          hasRemote = true
          if (!remote) node.removeAttribute(attr)
        }
      }
      const style = node.getAttribute("style")
      if (style && /url\(\s*["']?(https?:)?\/\//i.test(style)) {
        hasRemote = true
        if (!remote) node.setAttribute("style", style.replace(/url\([^)]*\)/gi, "none"))
      }
    })
    const clean = DOMPurify.sanitize(html, {
      // <style> blocks can restyle our frame chrome; inline style attributes
      // carry most email layout, so those stay.
      FORBID_TAGS: ["form", "input", "button", "textarea", "select", "style"],
    })
    DOMPurify.removeHook("afterSanitizeAttributes")
    const img = remote ? "data: cid: https:" : "data: cid:"
    const doc = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src ${img}; font-src data:">
<base target="_blank">
<style>
  html,body{margin:0;padding:0;background:transparent;color:#1a1c1f;font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;overflow-wrap:anywhere}
  img{max-width:100%;height:auto} table{max-width:100%!important} a{color:#2563eb}
  @media (prefers-color-scheme: dark){html{filter:invert(.92) hue-rotate(180deg)} img,video{filter:invert(1) hue-rotate(180deg)}}
</style></head><body>${clean}</body></html>`
    return { doc, hasRemote }
  }, [html, remote])

  return (
    <div className="flex flex-col gap-2">
      {hasRemote && !remote && (
        <div className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
          <Icon name="shield" className="size-4" />
          <span className="flex-1">Remote images are blocked to stop tracking.</span>
          <Button size="sm" variant="ghost" onClick={() => setRemote(true)}>
            Load images
          </Button>
        </div>
      )}
      <iframe
        ref={frame}
        title="Message body"
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        srcDoc={doc}
        className="min-h-40 w-full border-0"
        onLoad={() => {
          const body = frame.current?.contentDocument?.body
          if (frame.current && body) frame.current.style.height = `${body.scrollHeight + 16}px`
        }}
      />
    </div>
  )
}
