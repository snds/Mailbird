import { useState } from "react"

import { Button } from "@unicron/ui"

import { SharedPreview } from "./share-dialog"
import { useAddShared } from "./use-add-shared"
import { shareLinksIn } from "./share-link"

/** A shared-note link in a message (ADR-0056), as a card that opens it in Notes. */
export function SharedNoteCards({ text }: { text: string }) {
  const links = shareLinksIn(text)
  const add = useAddShared()
  const [busy, setBusy] = useState<string | null>(null)
  if (links.length === 0) return null
  return (
    <div className="flex flex-col gap-2" aria-label="Shared notes">
      {links.map((l) => (
        <div key={l.id} className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1">
            <SharedPreview link={l} />
          </div>
          <Button
            size="sm"
            disabled={busy === l.id}
            onClick={() => {
              setBusy(l.id)
              void add(l).finally(() => setBusy(null))
            }}
          >
            {busy === l.id ? "Opening…" : "Open in Notes"}
          </Button>
        </div>
      ))}
    </div>
  )
}
