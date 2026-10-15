import { useQueryClient } from "@tanstack/react-query"
import { useRef, useState } from "react"
import { toast } from "sonner"

import { Icon, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@unicron/ui"
import { getCoreClient } from "@/core/client"
import type { ImportFile, ImportReport } from "@/core/types"
import { toBase64 } from "@/lib/base64"
import { prepareImage } from "@/lib/image"

const TEXT = /\.(md|markdown|txt|json|html)$/i
const IMAGE = /\.(jpe?g|png|webp|gif|svg)$/i
/** Bigger "notes" are almost certainly not notes; skip reading them. */
const MAX_BYTES = 2_000_000
/** What one import call carries, so a big vault goes in several (ADR-0044). */
const BATCH_BYTES = 8_000_000

const SOURCES = [
  { icon: "laptop_mac", name: "Apple Notes", how: "Export your notes as Markdown on a Mac, then choose that folder." },
  { icon: "lightbulb", name: "Google Keep", how: "Download Keep from Google Takeout, unzip it, and choose the Keep folder." },
  { icon: "folder", name: "Obsidian, Bear, or any Markdown", how: "Choose a vault or export folder. Folders and #tags become tags." },
] as const

const pathOf = (f: File) => f.webkitRelativePath || f.name

/**
 * The picked files, in batches. Each note travels with the images it names
 * (by file name, as Markdown, Obsidian, and Keep write them), shrunk the way
 * the editor shrinks them. Other media is only counted, never read.
 */
async function read(list: FileList): Promise<ImportFile[][]> {
  const all = [...list]
  const texts: ImportFile[] = await Promise.all(
    all
      .filter((f) => !IMAGE.test(f.name))
      .map(async (f) => ({ path: pathOf(f), contents: TEXT.test(f.name) && f.size <= MAX_BYTES ? await f.text() : "", modified: Math.floor(f.lastModified / 1000) })),
  )
  const images = all.filter((f) => IMAGE.test(f.name))
  const named = (text: string, f: File) => {
    const t = text.toLowerCase()
    const n = f.name.toLowerCase()
    return t.includes(n) || t.includes(encodeURI(n))
  }
  const ready = new Map<File, ImportFile | null>()
  const prepared = async (f: File) => {
    if (!ready.has(f)) {
      // One that won't open (HEIC, say) is left out; the report counts it.
      // Sketches (SVG) go as they are; the core keeps only ones the app drew (ADR-0046).
      const data = /\.svg$/i.test(f.name) ? toBase64(new Uint8Array(await f.arrayBuffer())) : (await prepareImage(f).catch(() => null))?.dataBase64
      ready.set(f, data ? { path: pathOf(f), contents: "", dataBase64: data } : null)
    }
    return ready.get(f) ?? null
  }
  const batches: ImportFile[][] = []
  let batch: ImportFile[] = []
  let size = 0
  for (const t of texts) {
    const own: ImportFile[] = []
    for (const f of t.contents ? images.filter((i) => named(t.contents, i)) : []) {
      const img = await prepared(f)
      if (img) own.push(img)
    }
    const cost = t.contents.length + own.reduce((n, i) => n + (i.dataBase64?.length ?? 0), 0)
    if (batch.length && size + cost > BATCH_BYTES) {
      batches.push(batch)
      batch = []
      size = 0
    }
    batch.push(t, ...own.filter((i) => !batch.includes(i)))
    size += cost
  }
  if (batch.length) batches.push(batch)
  return batches
}

/** One report for every batch. */
const total = (rs: ImportReport[]): ImportReport =>
  rs.reduce((a, r) => ({
    imported: a.imported + r.imported,
    duplicates: a.duplicates + r.duplicates,
    trashed: a.trashed + r.trashed,
    attachmentsDropped: a.attachmentsDropped + r.attachmentsDropped,
    skipped: [...a.skipped, ...r.skipped],
  }))

export function ImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<ImportReport | null>(null)
  const filesRef = useRef<HTMLInputElement>(null)
  const folderRef = useRef<HTMLInputElement>(null)
  const qc = useQueryClient()

  const run = async (list: FileList | null) => {
    if (!list?.length) return
    setBusy(true)
    try {
      const core = await getCoreClient()
      const reports: ImportReport[] = []
      for (const batch of await read(list)) reports.push(await core.importNotes(batch))
      setReport(total(reports))
      void qc.invalidateQueries({ queryKey: ["notes"] })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      if (filesRef.current) filesRef.current.value = ""
      if (folderRef.current) folderRef.current.value = ""
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (onOpenChange(o), !o && setReport(null))}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Import notes</DialogTitle>
          <DialogDescription>Notes are copied in as Markdown, with their images. Nothing changes in the app they came from.</DialogDescription>
        </DialogHeader>

        {report ? (
          <div className="flex flex-col gap-2 text-sm" role="status">
            <p className="flex items-center gap-2 font-medium">
              <Icon name="check_circle" className="size-5 text-vertical-notes" />
              {report.imported === 1 ? "Imported 1 note" : `Imported ${report.imported} notes`}
            </p>
            <ul className="flex flex-col gap-1 pl-7 text-muted-foreground">
              {report.duplicates > 0 && <li>{report.duplicates} already imported before, left as they are</li>}
              {report.trashed > 0 && <li>{report.trashed} in the trash, skipped</li>}
              {report.attachmentsDropped > 0 && <li>{report.attachmentsDropped === 1 ? "1 image or recording" : `${report.attachmentsDropped} images or recordings`} not brought over: missing, or a kind notes can't show yet</li>}
              {report.skipped.length > 0 && <li title={report.skipped.join("\n")}>{report.skipped.length} files that weren’t notes</li>}
            </ul>
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {SOURCES.map((s) => (
              <li key={s.name} className="flex gap-3 text-sm">
                <Icon name={s.icon} className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                <span>
                  <span className="font-medium">{s.name}</span>
                  <span className="block text-muted-foreground">{s.how}</span>
                </span>
              </li>
            ))}
          </ul>
        )}

        <input ref={filesRef} type="file" multiple hidden accept=".md,.markdown,.txt,.json,.html,.jpg,.jpeg,.png,.webp,.gif" onChange={(e) => void run(e.target.files)} />
        {/* webkitdirectory: every engine we ship in supports picking a folder. */}
        <input ref={folderRef} type="file" hidden {...{ webkitdirectory: "" }} onChange={(e) => void run(e.target.files)} />

        <DialogFooter>
          {report ? (
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          ) : (
            <>
              <Button variant="outline" disabled={busy} onClick={() => filesRef.current?.click()}>
                <Icon name="description" data-icon="inline-start" /> Choose files…
              </Button>
              <Button disabled={busy} onClick={() => folderRef.current?.click()}>
                <Icon name="folder_open" data-icon="inline-start" /> {busy ? "Importing…" : "Choose a folder…"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
