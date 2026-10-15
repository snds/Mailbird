// Images in notes for the web demo (ADR-0044). Follows
// crates/core/src/note_files.rs and the image half of notes_import.rs.

import type { ImportFile, NoteFile, NoteFileData } from "./types"

export const NOTE_FILE = "note-file:"
const MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"])
const MAX = 10 * 1024 * 1024
const now = () => Math.floor(Date.now() / 1000)

export const mimeExt = (mime: string) => ({ "image/png": "png", "image/webp": "webp", "image/gif": "gif" })[mime] ?? "jpg"

export function extMime(name: string): string | null {
  const ext = name.split(".").pop()?.toLowerCase() ?? ""
  return ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" } as Record<string, string>)[ext] ?? null
}

/** The ids a note's Markdown points at, once each. */
export function noteFileIds(md: string): string[] {
  return [...new Set([...md.matchAll(/note-file:([A-Za-z0-9-]+)/g)].map((m) => m[1]!))]
}

interface Stored extends NoteFile {
  /** The bytes, or (sealed) a stand-in for them. */
  data: string
}

/** The demo's image store. `sealed` images keep their bytes behind a flag. */
export function createDemoFiles(isLocked: (noteId: string) => boolean, unlocked: () => boolean) {
  const files = new Map<string, Stored>()
  const info = ({ data: _d, ...f }: Stored): NoteFile => ({ ...f })
  const sizeOf = (b64: string) => Math.floor((b64.length * 3) / 4)

  const put = (noteId: string, mime: string, dataBase64: string, width: number | null, height: number | null, id: string = crypto.randomUUID(), at = now()) => {
    const f: Stored = { id, noteId, mime, width, height, size: sizeOf(dataBase64), sealed: isLocked(noteId), created: at, updated: at, data: dataBase64 }
    files.set(id, f)
    return info(f)
  }

  return {
    put,
    add(noteId: string, mime: string, dataBase64: string, width: number | null, height: number | null): NoteFile {
      const m = mime.trim().toLowerCase()
      if (!MIMES.has(m)) throw new Error("notes take JPEG, PNG, WebP, and GIF images")
      if (!dataBase64) throw new Error("that image is empty")
      if (sizeOf(dataBase64) > MAX) throw new Error("that image is over 10 MB")
      if (isLocked(noteId) && !unlocked()) throw new Error("Locked notes are locked. Enter your passphrase to add images.")
      return put(noteId, m, dataBase64, width, height)
    },
    get(id: string): NoteFileData {
      const f = files.get(id)
      if (!f) throw new Error("that image is gone")
      if (f.sealed && !unlocked()) throw new Error("Locked notes are locked. Enter your passphrase to see this image.")
      return { id, mime: f.mime, dataBase64: f.data, text: f.text ?? null }
    },
    of: (noteId: string) => [...files.values()].filter((f) => f.noteId === noteId).sort((a, b) => a.created - b.created).map(info),
    records: () => [...files.values()].map(info),
    raw(id: string) {
      const f = files.get(id)
      if (!f) throw new Error("that image is gone")
      return f.data
    },
    apply(f: NoteFile, raw: string) {
      const ours = files.get(f.id)
      if (ours && ours.updated >= f.updated) return false
      files.set(f.id, { ...f, data: raw })
      return true
    },
    /** Text in images (ADR-0045). */
    setText(id: string, text: string): NoteFile {
      const f = files.get(id)
      if (!f) throw new Error("that image is gone")
      if (f.sealed && !unlocked()) throw new Error("Locked notes are locked. Enter your passphrase first.")
      Object.assign(f, { text: text.trim().slice(0, 20_000), updated: Math.max(now(), f.updated + 1) })
      return info(f)
    },
    withoutText: (limit: number) => [...files.values()].filter((f) => f.text == null && !f.sealed).slice(0, limit).map(info),
    /** What search sees of a note's images: nothing while it's locked. */
    textOf: (noteId: string) => [...files.values()].filter((f) => f.noteId === noteId && !f.sealed && f.text).map((f) => f.text!).join("\n"),
    /** With its note's lock (ADR-0043). */
    reseal(noteId: string, sealed: boolean) {
      for (const f of files.values()) if (f.noteId === noteId) Object.assign(f, { sealed, updated: Math.max(now(), f.updated + 1) })
    },
  }
}

export type DemoFiles = ReturnType<typeof createDemoFiles>

// ── Import ───────────────────────────────────────────────────────────────

export interface ImportedImage {
  id: string
  mime: string
  data: string
}

/** The picked image files, by path and by lowercased file name (shortest path first). */
export function mediaOf(files: ImportFile[]) {
  const byPath = new Map<string, { mime: string; data: string }>()
  const byName = new Map<string, string[]>()
  for (const f of files) {
    const mime = extMime(f.path)
    if (!mime || !f.dataBase64) continue
    const path = f.path.replaceAll("\\", "/")
    // The bytes say what they are: a big PNG may have come in as JPEG.
    const sniffed = f.dataBase64.startsWith("/9j/") ? "image/jpeg" : f.dataBase64.startsWith("iVBOR") ? "image/png" : null
    byPath.set(path, { mime: sniffed ?? mime, data: f.dataBase64 })
    const name = path.split("/").pop()!.toLowerCase()
    byName.set(name, [...(byName.get(name) ?? []), path])
  }
  for (const v of byName.values()) v.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))
  const normalize = (p: string) => {
    const out: string[] = []
    for (const s of p.split("/")) {
      if (s === "" || s === ".") continue
      if (s === "..") out.pop()
      else out.push(s)
    }
    return out.join("/")
  }
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s)
    } catch {
      return s
    }
  }
  return {
    take(dir: string, target: string): ImportedImage | null {
      const t = decode(target.trim())
      const hit = byPath.get(normalize(dir ? `${dir}/${t}` : t)) ?? byPath.get(byName.get(t.split("/").pop()!.toLowerCase())?.[0] ?? "")
      return hit ? { id: crypto.randomUUID(), ...hit } : null
    },
  }
}

export type Media = ReturnType<typeof mediaOf>

/** Points a note's local images at its own copies; web images and code stay. */
export function takeImages(md: string, dir: string, media: Media): { markdown: string; images: ImportedImage[]; missing: number } {
  const images: ImportedImage[] = []
  let missing = 0
  let fenced = false
  const lines = md.split("\n").map((line) => {
    if (line.trimStart().startsWith("```")) fenced = !fenced
    if (fenced) return line
    return line
      .replace(/!\[\[([^\]|]+)(\|[^\]]*)?\]\]/g, (all, name: string) => {
        if (!extMime(name)) return all
        const img = media.take(dir, name)
        if (!img) return missing++, all
        images.push(img)
        const alt = name.split("/").pop()!.replace(/\.[^.]+$/, "")
        return `![${alt}](${NOTE_FILE}${img.id})`
      })
      .replace(/!\[([^\]\n]*)\]\(([^)]*)\)/g, (all, alt: string, raw: string) => {
        const r = raw.trim()
        const target = r.startsWith("<") ? r.slice(1).split(">")[0]! : r.split(' "')[0]!
        if (target.includes("://") || target.startsWith("data:") || target.startsWith(NOTE_FILE)) return all
        const img = media.take(dir, target)
        if (!img) return missing++, all
        images.push(img)
        return `![${alt}](${NOTE_FILE}${img.id})`
      })
  })
  return { markdown: lines.join("\n"), images, missing }
}

/**
 * A sample image for the demo's moodboard note: drawn once, when first
 * shown, so the bundle carries no binary.
 */
export async function sampleSwatches(): Promise<string> {
  const canvas = document.createElement("canvas")
  canvas.width = 960
  canvas.height = 540
  const g = canvas.getContext("2d")!
  const hues = [28, 62, 145, 200, 265, 330]
  hues.forEach((h, i) => {
    const grad = g.createLinearGradient(0, 0, 0, 540)
    grad.addColorStop(0, `oklch(0.88 0.08 ${h})`)
    grad.addColorStop(1, `oklch(0.55 0.14 ${h})`)
    g.fillStyle = grad
    g.fillRect(i * 160, 0, 160, 540)
  })
  const url = canvas.toDataURL("image/png")
  return url.slice(url.indexOf(",") + 1)
}
