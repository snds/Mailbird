import type { ContactExport, ExportedNote } from "@/core/types"

import { zip } from "./zip"

/** A card saved through the browser (the gateway and the demo). */
export function downloadVcard(file: ContactExport) {
  const url = URL.createObjectURL(new Blob([file.vcf], { type: "text/vcard" }))
  const a = document.createElement("a")
  a.href = url
  a.download = file.fileName
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return "your browser's downloads"
}

/** Every note as a zip of Markdown files, for a browser (ADR-0034). */
export function downloadNotes(files: ExportedNote[]) {
  const day = new Date().toISOString().slice(0, 10)
  const folder = `Notes ${day}`
  const blob = zip(files.map((f) => ({ path: `${folder}/${f.path}`, data: new TextEncoder().encode(f.contents) })))
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `${folder}.zip`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return "your browser's downloads"
}
