import { useState } from "react"
import { toast } from "sonner"

import { useUi } from "@/app/ui-store"
import { Icon, type IconName } from "@/components/icon"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { getCoreClient } from "@/core/client"
import type { Account, AttachmentInfo, MessageDetail, MessageSummary } from "@/core/types"
import { cn } from "@/lib/utils"
import { longTime, shortTime } from "@/lib/time"

import type { useTriage } from "./actions"
import { THUMB_LIMIT, previewKind, useAttachmentUrl } from "./attachment-kind"
import { AttachmentPreview } from "./attachment-preview"
import { displayName, formatSize, forwardDraft, initials, replyDraft, replyTarget } from "./format"
import { HtmlBody } from "./html-body"
import { LinkedNotes } from "../notes/linked-notes"
import { InviteCard } from "./invite-card"
import { SnoozeMenu } from "./snooze-menu"

function ToolbarButton({ icon, label, shortcut, onClick, active }: { icon: IconName; label: string; shortcut?: string; onClick?: () => void; active?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon" aria-label={label} aria-pressed={active} onClick={onClick} />}>
        <Icon name={icon} fill={active} />
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {shortcut && <kbd className="ml-2 font-mono text-[11px] opacity-70">{shortcut}</kbd>}
      </TooltipContent>
    </Tooltip>
  )
}

function fileIcon(mime: string): IconName {
  if (mime === "application/pdf") return "picture_as_pdf"
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("audio/")) return "audio_file"
  if (mime.startsWith("video/")) return "video_file"
  if (/zip|compressed|tar|gzip/.test(mime)) return "folder_zip"
  if (/sheet|excel|csv/.test(mime)) return "table"
  if (/word|document|text/.test(mime)) return "description"
  return "draft"
}

function AttachmentChip({ file }: { file: AttachmentInfo }) {
  const [busy, setBusy] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const kind = previewKind(file)
  const thumb = useAttachmentUrl(file.id, kind === "image" && file.size <= THUMB_LIMIT, file.mimeType)
  const save = async () => {
    setBusy(true)
    try {
      const path = await (await getCoreClient()).openAttachment(file.id)
      if (path) toast.success(`Saved to ${path}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex max-w-full min-w-0 items-center rounded-xl border bg-card text-sm" data-slot="attachment-chip">
      <button
        type="button"
        onClick={kind ? () => setPreviewing(true) : save}
        disabled={busy}
        aria-label={kind ? `Preview ${file.filename}` : `Open ${file.filename}`}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-l-xl px-3 py-2 text-left transition-colors outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60"
      >
        {thumb ? (
          <img src={thumb} alt="" className="size-8 shrink-0 rounded-md object-cover" />
        ) : (
          <Icon name={fileIcon(file.mimeType)} className="size-6 shrink-0 text-muted-foreground" opticalSize={24} />
        )}
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{file.filename}</span>
          <span className="text-xs text-muted-foreground">{formatSize(file.size)}</span>
        </span>
      </button>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={save}
              disabled={busy}
              aria-label={`Save ${file.filename}`}
              className="flex self-stretch items-center rounded-r-xl border-l px-2.5 text-muted-foreground transition-colors outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60"
            />
          }
        >
          <Icon name={busy ? "progress_activity" : "download"} className={cn("size-4", busy && "animate-spin")} />
        </TooltipTrigger>
        <TooltipContent>Save and open</TooltipContent>
      </Tooltip>
      {kind && (
        <AttachmentPreview
          file={file}
          kind={kind}
          open={previewing}
          onOpenChange={setPreviewing}
          onSave={() => {
            setPreviewing(false)
            void save()
          }}
        />
      )}
    </div>
  )
}

function MessageCard({ message, expanded, onToggle, accountAddress }: { message: MessageDetail; expanded: boolean; onToggle: () => void; accountAddress?: string }) {
  const mine = message.mailbox === "Sent" || message.from.email === accountAddress
  const files = message.attachments.filter((a) => !a.inline)
  const header = (
    <>
      <Avatar className={cn("shrink-0", mine && "bg-primary/10")}>
        <AvatarFallback>{mine ? "Me" : initials(message.from)}</AvatarFallback>
      </Avatar>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2">
          <span className={cn("truncate text-sm", message.seen ? "font-medium" : "font-semibold")}>{mine ? "Me" : displayName(message.from)}</span>
          {message.mailbox === "Sent" && <Badge variant="outline" className="h-4 px-1.5 text-[10px]">Sent</Badge>}
          {files.length > 0 && !expanded && <Icon name="attach_file" className="size-3.5 text-muted-foreground" label="Has attachments" />}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {expanded ? `to ${message.to.map(displayName).join(", ") || "you"}` : message.preview}
        </span>
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">{expanded ? longTime(message.date) : shortTime(message.date)}</span>
    </>
  )

  return (
    <section className={cn("rounded-2xl border bg-card", expanded ? "shadow-xs" : "bg-transparent")} aria-label={`Message from ${displayName(message.from)}`}>
      <button type="button" onClick={onToggle} aria-expanded={expanded} className="flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        {header}
      </button>
      {expanded && (
        <div className="flex flex-col gap-4 px-4 pb-4">
          {message.invite && <InviteCard invite={message.invite} messageId={message.id} accountId={message.accountId} />}
          {message.bodyHtml ? (
            <HtmlBody html={message.bodyHtml} />
          ) : (
            <div className="text-[15px] leading-relaxed break-words whitespace-pre-line">{message.bodyText}</div>
          )}
          {files.length > 0 && (
            <div className="flex flex-wrap gap-2" aria-label="Attachments">
              {files.map((f) => (
                <AttachmentChip key={f.id} file={f} />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

export function ConversationView({
  row,
  thread,
  account,
  showAccount,
  triage,
}: {
  /** The list row for this conversation (thread-level state). */
  row: MessageSummary | undefined
  thread: MessageDetail[] | undefined
  account: Account | undefined
  showAccount: boolean
  triage: ReturnType<typeof useTriage>
}) {
  const openComposer = useUi((s) => s.openComposer)
  // Gmail/Apple Mail convention: open the newest and anything unread.
  const [expanded, setExpanded] = useState<Set<string> | null>(null)

  if (!thread || !row) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 md:px-8 md:pt-6">
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="h-16 w-full rounded-2xl" />
        <Skeleton className="h-40 w-full rounded-2xl" />
      </div>
    )
  }
  const open = expanded ?? new Set(thread.filter((m, i) => i === thread.length - 1 || !m.seen).map((m) => m.id))
  const toggle = (id: string) => {
    const next = new Set(open)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setExpanded(next)
  }
  const target = replyTarget(thread)!
  const latest = thread.at(-1)!
  const subject = target.subject || latest.subject || "(no subject)"
  // The core clears snoozedUntil when a snooze wakes, so set means still snoozed.
  const snoozed = row.snoozedUntil !== null

  return (
    <article className="mx-auto flex max-w-3xl flex-col gap-3 px-4 pb-8 md:px-8 md:pt-6">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 pb-1">
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-semibold tracking-tight break-words">{subject}</h2>
          <p className="flex items-center gap-2 pt-1 text-xs text-muted-foreground">
            {thread.length > 1 && <span>{thread.length} messages</span>}
            {showAccount && account && <Badge variant="secondary">{account.displayName}</Badge>}
          </p>
        </div>
        <div className="-mr-2 flex shrink-0 items-center">
          <ToolbarButton icon={row.archived ? "unarchive" : "archive"} label={row.archived ? "Move to Inbox" : "Archive"} shortcut="E" onClick={() => triage.toggleArchive(row)} />
          {snoozed ? (
            <ToolbarButton icon="notifications_active" label="Unsnooze" onClick={() => triage.unsnooze(row)} active />
          ) : (
            <SnoozeMenu onSnooze={(until, label) => triage.snooze(row, until, label)} trigger={<Button variant="ghost" size="icon" aria-label="Snooze" />}>
              <Icon name="snooze" />
            </SnoozeMenu>
          )}
          <ToolbarButton icon="star" label={row.flagged ? "Unstar" : "Star"} shortcut="S" active={row.flagged} onClick={() => triage.toggleFlag(row)} />
          <ToolbarButton icon="mark_email_unread" label="Mark unread" shortcut="U" onClick={() => triage.markSeen(row, false)} />
        </div>
      </div>

      {thread.map((m) => (
        <MessageCard key={m.id} message={m} expanded={open.has(m.id)} onToggle={() => toggle(m.id)} accountAddress={account?.address} />
      ))}

      <div className="flex gap-2 pt-2">
        <Button variant="outline" onClick={() => openComposer(replyDraft(target))}>
          <Icon name="reply" data-icon="inline-start" /> Reply
        </Button>
        <Button variant="outline" onClick={() => openComposer(forwardDraft(target))}>
          <Icon name="forward" data-icon="inline-start" /> Forward
        </Button>
      </div>
      <div className="pt-4">
        <LinkedNotes target={{ kind: "thread", id: row.threadId }} title={subject} />
      </div>
    </article>
  )
}
