import type { ContactExport } from "@/core/types"

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
