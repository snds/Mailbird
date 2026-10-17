import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"

import { useUi } from "@/app/ui-store"
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Field, FieldDescription, FieldError, FieldLabel, Icon, Input, ToggleGroup, ToggleGroupItem } from "@unicron/ui"
import { useAccounts, useNoteAction, useNotesRelay } from "@/core/queries"
import type { NoteSummary, ShareMode } from "@/core/types"

import { type ShareLink, parseShareUrl, shareToken, shareUrl } from "./share-link"
import { useAddShared } from "./use-add-shared"

const MODES: { value: ShareMode; label: string; hint: string }[] = [
  { value: "edit", label: "Can edit", hint: "Anyone with the link can change this note. Your edits and theirs merge as you type." },
  { value: "view", label: "Can view", hint: "Anyone with the link can read this note and see your changes as you make them." },
]

/** Share a note by link (ADR-0056): choose edit or view, copy or email the link, or stop sharing. */
export function ShareDialog({ note, open, onOpenChange, onSetUpSync }: { note: NoteSummary; open: boolean; onOpenChange: (open: boolean) => void; onSetUpSync: () => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Share “{note.title || "New note"}”</DialogTitle>
          <DialogDescription>People with the link see it in their Mailbird, and edits show up for everyone as they happen.</DialogDescription>
        </DialogHeader>
        {open && <ShareForm note={note} onSetUpSync={onSetUpSync} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

function ShareForm({ note, onSetUpSync, onDone }: { note: NoteSummary; onSetUpSync: () => void; onDone: () => void }) {
  const { data: relay, isPending } = useNotesRelay()
  const { data: accounts = [] } = useAccounts()
  const qc = useQueryClient()
  // The open note shows its share too, so it refreshes with the lists.
  const refreshNote = () => void qc.invalidateQueries({ queryKey: ["notes", "note", note.id] })
  const share = useNoteAction((c, mode: ShareMode) => c.shareNote(note.id, mode).finally(refreshNote))
  const stop = useNoteAction<void>((c) => c.unshareNote(note.id).finally(refreshNote))
  const openComposer = useUi((s) => s.openComposer)
  const live = note.share && note.share.role === "owner" && !note.share.revoked ? note.share : null
  const [mode, setMode] = useState<ShareMode>(live?.mode ?? "edit")
  const from = accounts[0] ? accounts[0].displayName || accounts[0].address : null
  const { data: link } = useQuery({
    queryKey: ["notes", "share-link", live?.id, live?.mode, relay?.url, note.title, from],
    enabled: !!live && !!relay,
    queryFn: async () => shareUrl({ relay: relay!.url, id: live!.id, mode: live!.mode, token: await shareToken(relay!.token, live!.id), title: note.title, from }),
  })

  if (isPending) return null
  // Shared notes live on your relay: without one, there's nowhere for the other person to reach.
  if (!relay) {
    return (
      <>
        <p className="text-sm text-muted-foreground">Sharing works through your notes relay, the same one that syncs your devices. Set one up first.</p>
        <DialogFooter>
          <Button
            onClick={() => {
              onDone()
              onSetUpSync()
            }}
          >
            Set up sync…
          </Button>
        </DialogFooter>
      </>
    )
  }

  const pick = (m: ShareMode) => {
    setMode(m)
    if (live && m !== live.mode) share.mutate(m, { onSuccess: () => toast.success(m === "edit" ? "People with the link can edit" : "People with the link can view", { duration: 2000 }), onError: (e) => toast.error(e.message) })
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
  const email = () => {
    if (!link) return
    onDone()
    openComposer({
      subject: note.title || "A shared note",
      body: `I shared a note with you${live?.mode === "view" ? " to read" : ""}: “${note.title || "New note"}”.\n\nOpen it in Mailbird: ${link}\n`,
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-1.5" aria-labelledby="share-mode">
        <h3 id="share-mode" className="text-sm font-medium">
          People with the link
        </h3>
        <ToggleGroup value={[mode]} onValueChange={(v) => v[0] && pick(v[0] as ShareMode)} variant="outline" size="sm" aria-labelledby="share-mode">
          {MODES.map((m) => (
            <ToggleGroupItem key={m.value} value={m.value}>
              {m.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {MODES.find((m) => m.value === mode)?.hint}
        </p>
      </section>

      {live ? (
        <>
          <Field>
            <FieldLabel htmlFor="share-link">Link</FieldLabel>
            <Input id="share-link" readOnly value={link ?? ""} onFocus={(e) => e.currentTarget.select()} />
            <FieldDescription>Anyone who has it can {live.mode === "edit" ? "edit" : "read"} this note until you stop sharing.</FieldDescription>
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void copy()} disabled={!link}>
              <Icon name="content_copy" data-icon="inline-start" /> Copy link
            </Button>
            <Button variant="outline" onClick={email} disabled={!link}>
              <Icon name="mail" data-icon="inline-start" /> Email it
            </Button>
          </div>
        </>
      ) : null}

      <p className="flex gap-2 text-xs text-muted-foreground [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0">
        <Icon name="info" />
        Images in the note stay with you for now. Your relay can read shared notes, as it can read the rest.
      </p>

      <DialogFooter>
        {live ? (
          <Button
            variant="ghost-destructive"
            onClick={() =>
              stop.mutate(undefined, {
                onSuccess: () => {
                  toast.success("Stopped sharing. The link no longer works.", { duration: 3000 })
                  onDone()
                },
                onError: (e) => toast.error(e.message),
              })
            }
          >
            Stop sharing
          </Button>
        ) : (
          <Button onClick={() => share.mutate(mode, { onError: (e) => toast.error(e.message) })} disabled={share.isPending}>
            <Icon name="link" data-icon="inline-start" /> Create link
          </Button>
        )}
      </DialogFooter>
    </div>
  )
}

/** Paste someone's link, see what it is, and add it to your notes. */
export function OpenSharedDialog({ open, onOpenChange, initial }: { open: boolean; onOpenChange: (open: boolean) => void; initial?: string }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Open a shared note</DialogTitle>
          <DialogDescription>Paste the link someone sent you. The note joins your notes and stays in step with theirs.</DialogDescription>
        </DialogHeader>
        {open && <OpenSharedForm initial={initial ?? ""} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

function OpenSharedForm({ initial, onDone }: { initial: string; onDone: () => void }) {
  const [text, setText] = useState(initial)
  const link = parseShareUrl(text)
  const add = useAddShared()
  const [busy, setBusy] = useState(false)
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        if (!link) return
        setBusy(true)
        void add(link).then((ok) => (ok ? onDone() : setBusy(false)))
      }}
    >
      <Field data-invalid={!!text.trim() && !link}>
        <FieldLabel htmlFor="shared-link">Link</FieldLabel>
        <Input id="shared-link" autoFocus autoComplete="off" placeholder="https://…/share#…" value={text} onChange={(e) => setText(e.target.value)} aria-invalid={!!text.trim() && !link} />
        {text.trim() && !link && <FieldError>That isn't a shared-note link. It looks like https://…/share#… </FieldError>}
      </Field>
      {link && <SharedPreview link={link} />}
      <DialogFooter>
        <Button type="submit" disabled={!link || busy}>
          {busy ? "Adding…" : "Add to my notes"}
        </Button>
      </DialogFooter>
    </form>
  )
}

/** What a link is, before you add it: the note, who shared it, and what you can do. */
export function SharedPreview({ link }: { link: ShareLink }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border p-3 [&>svg]:mt-0.5 [&>svg]:size-5 [&>svg]:shrink-0 [&>svg]:text-vertical-notes" data-slot="shared-preview">
      <Icon name="group" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-sm font-medium">{link.title || "A shared note"}</span>
        <span className="text-xs text-muted-foreground">
          {link.from ? `From ${link.from} · ` : ""}
          {link.mode === "edit" ? "You can edit" : "You can read"}
        </span>
      </div>
    </div>
  )
}
