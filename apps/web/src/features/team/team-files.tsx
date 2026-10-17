import { useState } from "react"
import { toast } from "sonner"

import { Button, Icon, Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@unicron/ui"
import { getCoreClient } from "@/core/client"
import { useThread } from "@/core/queries"
import { toBase64 } from "@/lib/base64"

import { displayName, formatSize } from "../mail/format"
import { MAX_SHARED_FILE, type SharedAttachment, attachmentBlob } from "../notes/shared-files"
import { teamSync, useTeamVersions } from "./team-sync"

/** What a shared conversation's files are: the attachments its owner chose to share. */
function useShared(id: string): SharedAttachment[] {
  useTeamVersions((s) => s[id] ?? 0)
  const files = teamSync()?.files(id)
  return files ? [...files.attachments.values()].sort((a, b) => a.at - b.at) : []
}

/**
 * The owner's side (ADR-0061): the conversation's attachments, each shared
 * with the team or not. Nothing goes until you choose it.
 */
export function OwnerFiles({ shareId, threadId }: { shareId: string; threadId: string }) {
  const { data: thread = [] } = useThread(threadId)
  const shared = useShared(shareId)
  const [busy, setBusy] = useState<string | null>(null)
  const all = thread.flatMap((m) => m.attachments.filter((a) => !a.inline).map((a) => ({ a, m })))
  if (all.length === 0) return null
  const share = async (a: (typeof all)[number]) => {
    const files = teamSync()?.files(shareId)
    if (!files) return
    if (a.a.size > MAX_SHARED_FILE) return void toast.error(`${a.a.filename} is over 10 MB, too big to share here.`)
    setBusy(a.a.id)
    try {
      const bytes = new Uint8Array((await getCoreClient().then((c) => c.attachmentData(a.a.id))) as ArrayBuffer)
      files.attachments.set(a.a.id, { id: a.a.id, name: a.a.filename, mime: a.a.mimeType, size: bytes.length, from: displayName(a.m.from), at: a.m.date, data: toBase64(bytes) })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="flex flex-col gap-2" aria-label="Files">
      <p className="text-xs font-medium text-muted-foreground">Files</p>
      {all.map(({ a, m }) => {
        const on = shared.some((s) => s.id === a.id)
        return (
          <Item key={a.id} variant="outline" size="xs" data-role="team-file">
            <ItemMedia variant="icon">
              <Icon name="attach_file" tone="muted" />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{a.filename}</ItemTitle>
              <ItemDescription>
                {formatSize(a.size)} · from {displayName(m.from)} · {on ? "the team can download it" : "only you have it"}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              {on ? (
                <Button variant="ghost" size="xs" onClick={() => teamSync()?.files(shareId)?.attachments.delete(a.id)}>
                  Stop sharing
                </Button>
              ) : (
                <Button variant="outline" size="xs" disabled={busy === a.id || a.size > MAX_SHARED_FILE} onClick={() => void share({ a, m })}>
                  {busy === a.id ? "Sharing…" : "Share"}
                </Button>
              )}
            </ItemActions>
          </Item>
        )
      })}
      <p className="text-xs text-muted-foreground">Attachments stay with you until you share them, up to 10 MB each.</p>
    </div>
  )
}

/** A teammate's side: the files shared with them, to download. */
export function TeammateFiles({ shareId }: { shareId: string }) {
  const shared = useShared(shareId)
  if (shared.length === 0) return null
  const save = (a: SharedAttachment) => {
    const url = URL.createObjectURL(attachmentBlob(a))
    const link = document.createElement("a")
    link.href = url
    link.download = a.name
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }
  return (
    <div className="flex flex-col gap-2" aria-label="Files">
      <p className="text-xs font-medium text-muted-foreground">Files</p>
      {shared.map((a) => (
        <Item key={a.id} variant="outline" size="xs" data-role="team-file">
          <ItemMedia variant="icon">
            <Icon name="attach_file" tone="muted" />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{a.name}</ItemTitle>
            <ItemDescription>
              {formatSize(a.size)} · from {a.from}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Button variant="outline" size="xs" onClick={() => save(a)}>
              <Icon name="download" data-icon="inline-start" /> Download
            </Button>
          </ItemActions>
        </Item>
      ))}
    </div>
  )
}
