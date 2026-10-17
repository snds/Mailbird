import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { useUi } from "@/app/ui-store"
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Field, FieldDescription, FieldLabel, Icon, Input } from "@unicron/ui"
import { getCoreClient } from "@/core/client"
import { useNotesRelay, useThreadShare } from "@/core/queries"

import { shareToken, shareUrl } from "../notes/share-link"

/**
 * Share a conversation with teammates (ADR-0060): a link through your notes
 * relay. People with it see a copy of the conversation in their Mailbird,
 * comment beside it, and write the reply with you. You send it.
 */
export function ShareThreadDialog({ threadId, subject, open, onOpenChange }: { threadId: string; subject: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Share with teammates</DialogTitle>
          <DialogDescription>People with the link see “{subject}” in their Mailbird, comment beside it, and write the reply with you. Only you send it.</DialogDescription>
        </DialogHeader>
        {open && <ShareThreadForm threadId={threadId} subject={subject} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

function ShareThreadForm({ threadId, subject, onDone }: { threadId: string; subject: string; onDone: () => void }) {
  const { data: relay, isPending } = useNotesRelay()
  const { data: share, isPending: loading } = useThreadShare(threadId)
  const qc = useQueryClient()
  const openComposer = useUi((s) => s.openComposer)
  const refresh = () => void qc.invalidateQueries({ queryKey: ["team"] })
  const create = useMutation({ mutationFn: () => getCoreClient().then((c) => c.shareThread(threadId)), onSettled: refresh, onError: (e) => toast.error(e.message) })
  const stop = useMutation({ mutationFn: (id: string) => getCoreClient().then((c) => c.stopTeamThread(id)), onSettled: refresh, onError: (e) => toast.error(e.message) })
  const { data: link } = useQuery({
    queryKey: ["team", "link", share?.id, relay?.url],
    enabled: !!share && !!relay,
    queryFn: async () => shareUrl({ relay: relay!.url, id: share!.id, mode: "edit", token: await shareToken(relay!.token, share!.id), title: subject, from: share!.from, kind: "thread", ...(share!.key ? { k: share!.key } : {}) }),
  })

  if (isPending || loading) return null
  if (!relay) {
    return (
      <>
        <p className="text-sm text-muted-foreground">Sharing goes through your notes relay, the same one that syncs your notes. Set one up first, in Notes → Sync between devices.</p>
        <DialogFooter>
          <Button
            onClick={() => {
              onDone()
              useUi.getState().setVertical("notes")
            }}
          >
            Go to Notes
          </Button>
        </DialogFooter>
      </>
    )
  }

  const copy = async () => {
    if (!link) return
    try {
      await navigator.clipboard.writeText(link)
      toast.success("Link copied", { duration: 2000 })
    } catch {
      toast.error("Couldn't reach the clipboard")
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {share ? (
        <>
          <Field>
            <FieldLabel htmlFor="team-link">Link</FieldLabel>
            <Input id="team-link" readOnly value={link ?? ""} onFocus={(e) => e.currentTarget.select()} />
            <FieldDescription>Anyone who has it can read this conversation, comment, and help write the reply, until you stop sharing.</FieldDescription>
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void copy()} disabled={!link}>
              <Icon name="content_copy" data-icon="inline-start" /> Copy link
            </Button>
            <Button
              variant="outline"
              disabled={!link}
              onClick={() => {
                if (!link) return
                onDone()
                // A new message to a teammate, not a reply on the conversation itself.
                openComposer({ subject: `Can you help with “${subject}”?`, body: `I shared a conversation with you, so we can write the reply together: “${subject}”.\n\nOpen it in Mailbird: ${link}\n` })
              }}
            >
              <Icon name="mail" data-icon="inline-start" /> Email it
            </Button>
          </div>
        </>
      ) : null}

      <p className="flex gap-2 text-xs text-muted-foreground [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0">
        <Icon name="info" />
        Teammates get the text of each message, not attachments or images. Your relay can read it, as it can read your notes.
      </p>

      <DialogFooter>
        {share ? (
          <Button
            variant="ghost-destructive"
            onClick={() =>
              stop.mutate(share.id, {
                onSuccess: () => {
                  toast.success("Stopped sharing. The link no longer works.", { duration: 3000 })
                  onDone()
                },
              })
            }
          >
            Stop sharing
          </Button>
        ) : (
          <Button onClick={() => create.mutate()} disabled={create.isPending}>
            <Icon name="link" data-icon="inline-start" /> Create link
          </Button>
        )}
      </DialogFooter>
    </div>
  )
}
