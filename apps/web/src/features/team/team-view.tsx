import { useState } from "react"
import { toast } from "sonner"

import { useUi } from "@/app/ui-store"
import { ListRow } from "@/components/list-row"
import { Avatar, AvatarFallback, Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle, Field, FieldError, FieldLabel, Icon, Input, Skeleton } from "@unicron/ui"
import { getCoreClient } from "@/core/client"
import { useMailPrefs, useTeamThreads } from "@/core/queries"
import type { TeamThread } from "@/core/types"
import { longTime, shortTime } from "@/lib/time"

import { initials, replyDraft, replyTarget } from "../mail/format"
import { parseShareUrl } from "../notes/share-link"
import { ShareThreadDialog } from "./share-thread-dialog"
import { OwnerFiles, TeammateFiles } from "./team-files"
import { TeamPanel } from "./team-panel"
import { useTeamLive } from "./team-sync"
import { useOpenTeamLink } from "./use-open-team-link"
import { useHereIn, useTeamDoc } from "./use-team-doc"
import { PeopleHere } from "../notes/people-here"

const who = (t: TeamThread) => (t.role === "owner" ? "You shared" : `From ${t.from ?? "a teammate"}`)

/** Mail → Team: conversations you shared, and ones shared with you (ADR-0060). */
export function TeamList() {
  const { data: list = [], isPending } = useTeamThreads()
  const open = useUi((s) => s.teamOpen)
  const setOpen = useUi((s) => s.setTeamOpen)
  const [paste, setPaste] = useState(false)
  if (isPending) return null
  return (
    <>
      {list.length === 0 ? (
        <div className="py-16">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Icon name="group" />
            </EmptyMedia>
            <EmptyTitle>Write replies with your team</EmptyTitle>
            <EmptyDescription>Share a conversation from its toolbar, and teammates comment and write the reply with you. Conversations shared with you show up here too.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" onClick={() => setPaste(true)}>
              <Icon name="link" data-icon="inline-start" /> Open a link…
            </Button>
          </EmptyContent>
        </Empty>
        </div>
      ) : (
        <>
          <ul aria-label="Team" className="flex flex-col">
            {list.map((t) => (
              <li key={t.id}>
                <ListRow
                  selected={open === t.id}
                  onSelect={() => setOpen(t.id)}
                  leading={
                    <Avatar>
                      <AvatarFallback>{t.role === "owner" ? <Icon name="group" /> : initials({ name: t.from, email: t.from ?? "?" })}</AvatarFallback>
                    </Avatar>
                  }
                  title={t.title || "(no subject)"}
                  meta={shortTime(t.updated)}
                  supporting={t.revoked ? `${who(t)} · stopped` : who(t)}
                />
              </li>
            ))}
          </ul>
          <div className="flex justify-center p-4">
            <Button variant="ghost" size="sm" onClick={() => setPaste(true)}>
              <Icon name="link" data-icon="inline-start" /> Open a link…
            </Button>
          </div>
        </>
      )}
      <OpenTeamLinkDialog open={paste} onOpenChange={setPaste} />
    </>
  )
}

/** One shared conversation: its copy of the messages, and the team panel. */
export function TeamThreadView({ id }: { id: string }) {
  const { data: list = [] } = useTeamThreads()
  const t = list.find((x) => x.id === id)
  const { doc, data } = useTeamDoc(id)
  const live = useTeamLive((s) => !!s[id])
  useHereIn(id, live && !t?.revoked)
  const { data: mailPrefs } = useMailPrefs()
  const openComposer = useUi((s) => s.openComposer)
  const setOpen = useUi((s) => s.setTeamOpen)
  const [sharing, setSharing] = useState(false)

  if (!t || !doc || !data) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 md:px-8 md:pt-6 [&>*>*]:size-full">
        <div className="h-7 w-2/3">
          <Skeleton />
        </div>
        <div className="h-40 w-full [&>*]:rounded-2xl">
          <Skeleton />
        </div>
      </div>
    )
  }
  const owner = t.role === "owner"
  const subject = data.subject || t.title || "(no subject)"
  const remove = () =>
    void getCoreClient()
      .then(async (c) => {
        if (!owner && !t.revoked) await c.stopTeamThread(t.id)
        await c.removeTeamThread(t.id)
      })
      .then(
        () => {
          setOpen(null)
          toast.success(owner ? "Removed" : "You left the conversation", { duration: 2000 })
        },
        (e: Error) => toast.error(e.message),
      )
  // The owner's reply goes on their real conversation, quoted as Advanced settings say.
  const answerWith = async (html: string) => {
    const thread = t.threadId ? await getCoreClient().then((c) => c.getThread(t.threadId!)).catch(() => []) : []
    const target = replyTarget(thread)
    if (!target) return void toast.error("That conversation isn't in your mail any more.")
    openComposer(replyDraft(target, { quote: mailPrefs?.quote ?? true, replyBelow: mailPrefs?.replyBelow ?? false, openingHtml: html }))
  }

  return (
    <article className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 pb-8 md:px-8 md:pt-6">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 pb-1">
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-semibold tracking-tight break-words">{subject}</h2>
          <p className="flex flex-wrap items-center gap-2 pt-1 text-xs text-muted-foreground">
            <span>{owner ? "You shared this conversation" : `Shared by ${t.from ?? "a teammate"}`}</span>
            {t.revoked ? <Badge variant="secondary">Stopped</Badge> : live ? <Badge variant="secondary">Live</Badge> : <span>Connecting…</span>}
            {!t.revoked && <PeopleHere shareId={t.id} />}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {owner && !t.revoked && t.threadId && (
            <Button variant="outline" size="sm" onClick={() => setSharing(true)}>
              <Icon name="group_add" data-icon="inline-start" /> Sharing
            </Button>
          )}
          {(!owner || t.revoked) && (
            <Button variant="ghost" size="sm" onClick={remove}>
              {owner || t.revoked ? "Remove" : "Leave"}
            </Button>
          )}
        </div>
      </div>

      {t.revoked && !owner && (
        <div role="status" className="flex items-center gap-3 rounded-2xl border bg-muted/40 px-4 py-3 text-sm [&>svg]:size-5 [&>svg]:shrink-0 [&>svg]:text-muted-foreground">
          <Icon name="link_off" />
          <span>{t.from ?? "The owner"} stopped sharing. This is your copy, as it was then; only you can see it.</span>
        </div>
      )}

      <ol aria-label="Messages" className="flex flex-col gap-3">
        {data.messages.length === 0 && <li className="text-sm text-muted-foreground">{live ? "No messages yet." : "The messages arrive once the owner's relay can be reached."}</li>}
        {data.messages.map((m) => (
          <li key={m.id} className="flex flex-col gap-2 rounded-2xl border px-4 py-3" data-role="team-message">
            <div className="flex items-baseline gap-2">
              <span className="truncate text-sm font-medium">{m.from}</span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">{longTime(m.date)}</span>
            </div>
            <p className="text-sm break-words whitespace-pre-wrap">{m.text || "(no text)"}</p>
          </li>
        ))}
      </ol>

      <TeamPanel doc={doc} comments={data.comments} owner={owner} from={data.from || t.from} readOnly={t.revoked}
        onUseReply={owner ? (html) => void answerWith(html) : undefined}
        files={t.revoked ? null : owner && t.threadId ? <OwnerFiles shareId={t.id} threadId={t.threadId} /> : <TeammateFiles shareId={t.id} />}
      />

      {owner && t.threadId && <ShareThreadDialog threadId={t.threadId} subject={subject} open={sharing} onOpenChange={setSharing} />}
    </article>
  )
}

/** Paste a teammate's link to a conversation. */
export function OpenTeamLinkDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Open a shared conversation</DialogTitle>
          <DialogDescription>Paste the link a teammate sent you. You'll see the conversation, its comments, and the reply you're writing together.</DialogDescription>
        </DialogHeader>
        {open && <OpenTeamLinkForm onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

function OpenTeamLinkForm({ onDone }: { onDone: () => void }) {
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const link = parseShareUrl(text)
  const openLink = useOpenTeamLink()
  const wrong = !!text.trim() && (!link || link.kind !== "thread")
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        if (!link || link.kind !== "thread") return
        setBusy(true)
        void openLink(link).then((ok) => (ok ? onDone() : setBusy(false)))
      }}
    >
      <Field data-invalid={wrong}>
        <FieldLabel htmlFor="team-paste">Link</FieldLabel>
        <Input id="team-paste" autoFocus autoComplete="off" placeholder="https://…/share#…" value={text} onChange={(e) => setText(e.target.value)} aria-invalid={wrong} />
        {wrong && <FieldError>{link?.kind === "note" ? "That's a shared note. Open it in Notes, with Open a shared note…" : "That isn't a shared-conversation link. It looks like https://…/share#…"}</FieldError>}
      </Field>
      {link?.kind === "thread" && (
        <p className="text-sm">
          <span className="font-medium">{link.title || "A conversation"}</span>
          <span className="text-muted-foreground">{link.from ? ` · from ${link.from}` : ""}</span>
        </p>
      )}
      <DialogFooter>
        <Button type="submit" disabled={!link || link.kind !== "thread" || busy}>
          {busy ? "Opening…" : "Open"}
        </Button>
      </DialogFooter>
    </form>
  )
}
