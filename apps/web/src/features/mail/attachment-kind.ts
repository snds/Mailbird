import { useEffect, useState } from "react"

import { getCoreClient } from "@/core/client"
import type { AttachmentInfo } from "@/core/types"

/** Text previews stop here; bigger files open in their app. */
const TEXT_LIMIT = 1024 * 1024
/** Image chips only fetch a thumbnail below this. */
export const THUMB_LIMIT = 8 * 1024 * 1024

export type PreviewKind = "image" | "pdf" | "text"

/**
 * What we can show in-app. HTML (and anything that could run script) is never
 * previewed: images go through <img>, which doesn't run SVG script, PDFs are
 * checked for their magic bytes before they reach the viewer, and text is
 * decoded into a <pre>.
 */
export function previewKind(file: Pick<AttachmentInfo, "mimeType" | "size">): PreviewKind | null {
  const mime = file.mimeType.toLowerCase()
  if (mime.startsWith("image/")) return "image"
  if (mime === "application/pdf") return "pdf"
  if (mime.startsWith("text/") && mime !== "text/html" && file.size <= TEXT_LIMIT) return "text"
  if ((mime === "application/json" || mime === "application/xml") && file.size <= TEXT_LIMIT) return "text"
  return null
}

export const isPdf = (bytes: Uint8Array) => new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-"

/** Fetches the bytes once and hands back an object URL, revoked on unmount. */
export function useAttachmentUrl(id: string, enabled: boolean, mimeType: string) {
  const [url, setUrl] = useState<string>()
  useEffect(() => {
    if (!enabled) return
    let live = true
    let made: string | undefined
    getCoreClient()
      .then((c) => c.attachmentData(id))
      .then((data) => {
        if (!live) return
        made = URL.createObjectURL(new Blob([data], { type: mimeType }))
        setUrl(made)
      })
      .catch(() => {})
    return () => {
      live = false
      if (made) URL.revokeObjectURL(made)
    }
  }, [id, enabled, mimeType])
  return url
}
