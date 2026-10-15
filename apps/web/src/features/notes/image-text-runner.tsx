import { useEffect } from "react"

import type { CoreClient } from "@/core/client"
import { queryClient, useCore, useNotesPrefs } from "@/core/queries"
import { fromBase64 } from "@/lib/base64"
import { readText } from "@/lib/ocr"
import { rasterize, SVG_MIME } from "@/lib/sketch"

/** How long to wait after a change before looking, so a burst of saves is one look. */
const SETTLE = 1500

/**
 * Reads the text in images that no one has read yet, on this device, one at
 * a time while the app is idle (ADR-0045): new photos, scans, imports, and
 * images synced from a device that didn't read them. Mount once.
 */
export function ImageTextRunner() {
  const { data: core } = useCore()
  const { data: prefs } = useNotesPrefs()
  const on = prefs?.readImageText ?? true
  useEffect(() => {
    if (!core || !on) return
    let stopped = false
    let running = false
    let timer: ReturnType<typeof setTimeout> | undefined
    // An image that can't be read (damaged, or the reader failed) isn't retried this session.
    const failed = new Set<string>()
    const pass = async () => {
      if (running || stopped) return
      running = true
      try {
        await readPending(core, failed, () => stopped)
      } finally {
        running = false
      }
    }
    const soon = () => {
      clearTimeout(timer)
      timer = setTimeout(() => idle(() => void pass()), SETTLE)
    }
    soon()
    const off = core.on("notes:changed", soon)
    return () => {
      stopped = true
      clearTimeout(timer)
      off()
    }
  }, [core, on])
  return null
}

const idle = (fn: () => void) => (typeof requestIdleCallback === "function" ? requestIdleCallback(fn, { timeout: 5000 }) : setTimeout(fn, 0))

async function readPending(core: CoreClient, failed: Set<string>, stopped: () => boolean) {
  for (;;) {
    const pending = (await core.noteFilesWithoutText(5)).filter((f) => !failed.has(f.id))
    if (!pending.length) return
    for (const f of pending) {
      if (stopped()) return
      try {
        const img = await core.noteFile(f.id)
        const blob = new Blob([fromBase64(img.dataBase64)], { type: img.mime })
        // The reader takes pixels: a sketch is drawn onto white first.
        const text = await readText(img.mime === SVG_MIME ? await rasterize(blob) : blob)
        await core.setNoteFileText(f.id, text)
        // A shown image keeps its query; this one now has text to offer.
        void queryClient.invalidateQueries({ queryKey: ["notes", "file", f.id] })
      } catch {
        failed.add(f.id)
      }
    }
  }
}
