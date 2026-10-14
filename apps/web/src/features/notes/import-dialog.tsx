import { useQueryClient } from "@tanstack/react-query"
import { useRef, useState } from "react"
import { toast } from "sonner"

import { Icon } from "@/components/icon"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { getCoreClient } from "@/core/client"
import type { ImportFile, ImportReport } from "@/core/types"

const TEXT = /\.(md|markdown|txt|json|html)$/i
/** Bigger "notes" are almost certainly not notes; skip reading them. */
const MAX_BYTES = 2_000_000

const SOURCES = [
  { icon: "laptop_mac", name: "Apple Notes", how: "Export your notes as Markdown on a Mac, then choose that folder." },
  { icon: "lightbulb", name: "Google Keep", how: "Download Keep from Google Takeout, unzip it, and choose the Keep folder." },
  { icon: "folder", name: "Obsidian, Bear, or any Markdown", how: "Choose a vault or export folder. Folders and #tags become tags." },
] as const

async function read(list: FileList): Promise<ImportFile[]> {
  const files = await Promise.all(
    [...list].map(async (f) => ({
      path: f.webkitRelativePath || f.name,
      // Media is only counted, never read.
      contents: TEXT.test(f.name) && f.size <= MAX_BYTES ? await f.text() : "",
      modified: Math.floor(f.lastModified / 1000),
    })),
  )
  return files
}

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
      const r = await (await getCoreClient()).importNotes(await read(list))
      setReport(r)
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
          <DialogDescription>Notes are copied in as Markdown. Nothing changes in the app they came from.</DialogDescription>
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
              {report.attachmentsDropped > 0 && <li>{report.attachmentsDropped} images or recordings not brought over yet</li>}
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

        <input ref={filesRef} type="file" multiple hidden accept=".md,.markdown,.txt,.json,.html" onChange={(e) => void run(e.target.files)} />
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
