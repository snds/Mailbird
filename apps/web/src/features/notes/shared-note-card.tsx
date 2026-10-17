import { useState } from "react"

import { Button, Icon } from "@unicron/ui"

import { useOpenTeamLink } from "../team/use-open-team-link"

import { SharedPreview } from "./share-dialog"
import { useAddShared } from "./use-add-shared"
import { shareLinksIn } from "./share-link"

/**
 * Share links in a message, as cards: a note opens in Notes (ADR-0056), a
 * conversation shared with teammates in Mail → Team (ADR-0060).
 */
export function SharedNoteCards({ text }: { text: string }) {
  const all = shareLinksIn(text)
  const links = all.filter((l) => l.kind === "note")
  const threads = all.filter((l) => l.kind === "thread")
  const add = useAddShared()
  const openTeam = useOpenTeamLink()
  const [busy, setBusy] = useState<string | null>(null)
  if (all.length === 0) return null
  return (
    <div className="flex flex-col gap-2" aria-label="Shared with you">
      {threads.map((l) => (
        <div key={l.id} className="flex flex-wrap items-center gap-2">
          <div className="flex min-w-0 flex-1 items-start gap-3 rounded-lg border p-3 [&>svg]:mt-0.5 [&>svg]:size-5 [&>svg]:shrink-0 [&>svg]:text-vertical-mail" data-role="shared-thread">
            <Icon name="group" />
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-sm font-medium">{l.title || "A shared conversation"}</span>
              <span className="text-xs text-muted-foreground">{l.from ? `From ${l.from} · ` : ""}Comment and write the reply together</span>
            </div>
          </div>
          <Button
            size="sm"
            disabled={busy === l.id}
            onClick={() => {
              setBusy(l.id)
              void openTeam(l).finally(() => setBusy(null))
            }}
          >
            {busy === l.id ? "Opening…" : "Open in Team"}
          </Button>
        </div>
      ))}
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
