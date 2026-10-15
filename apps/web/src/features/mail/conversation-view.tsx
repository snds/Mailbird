import { useState } from "react"
import { toast } from "sonner"

import { useUi } from "@/app/ui-store"
import { Icon, type IconName } from "@/components/icon"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { AdaptiveSheetContent, Sheet, SheetTitle } from "@/components/ui/sheet"
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
import { FollowUpAtMenu } from "./send-later"
import { SenderProfile } from "./sender-profile"
import { SignatureSuggestion } from "./signature-suggestion"
import { SnoozeMenu } from "./snooze-menu"
import { UnsubscribeButton } from "./unsubscribe-button"
import { CATEGORIES } from "./lanes"
import { useSenderActions } from "./sender-actions"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { Category } from "@/core/types"
import { useContactPhotos, useMailAction } from "@/core/queries"
import { useNowSecs } from "@/hooks/use-now"

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
  const { data: photos } = useContactPhotos()
  const header = (
    <>
      <Avatar className={cn("shrink-0", mine && "bg-primary/10")}>
        {!mine && photos?.[message.from.email.trim().toLowerCase()] && <AvatarImage src={photos[message.from.email.trim().toLowerCase()]} alt="" />}
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
          {!mine && <SignatureSuggestion messageId={message.id} />}
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
  screening = false,
  onLeave,
  onOpenThread,
}: {
  /** The list row for this conversation (thread-level state). */
  row: MessageSummary | undefined
  thread: MessageDetail[] | undefined
  account: Account | undefined
  showAccount: boolean
  triage: ReturnType<typeof useTriage>
  /** Opened from the Screener: offer to let the sender in or screen them out. */
  screening?: boolean
  /** Close the reader: its conversation is leaving the list (screened out, blocked). */
  onLeave?: () => void
  /** Open another conversation in this reader (from the sender profile). */
  onOpenThread?: (row: MessageSummary) => void
}) {
  const openComposer = useUi((s) => s.openComposer)
  // Gmail/Apple Mail convention: open the newest and anything unread.
  const [expanded, setExpanded] = useState<Set<string> | null>(null)
  const now = useNowSecs()
  const senderActions = useSenderActions()
  // Screening out or blocking archives the conversation, so the reader closes, as it does for Archive.
  const senders = {
    move: senderActions.move,
    decide: (from: Parameters<typeof senderActions.decide>[0], d: Parameters<typeof senderActions.decide>[1]) => {
      senderActions.decide(from, d, d === "allowed" ? undefined : onLeave)
    },
  }
  const setFollowUp = useMailAction<{ threadId: string; at: number }>((c, a) => c.setFollowUp(a.threadId, a.at))
  const cancelFollowUp = useMailAction<string>((c, threadId) => c.cancelFollowUp(threadId))
  const remind = (threadId: string, at: number, label: string) =>
    setFollowUp.mutate({ threadId, at }, { onSuccess: () => toast.success(`If nobody replies, this comes back ${label}`), onError: (e) => toast.error(e.message) })

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
  // Follow-up reminders hang off mail you sent.
  const sentAny = thread.some((m) => m.mailbox === "Sent")
  const reminder = thread.map((m) => m.followUpAt).find((t) => t != null) ?? null
  const due = reminder !== null && reminder <= now
  // The person on the other side (ADR-0036): the newest message you didn't send.
  const other = thread.findLast((m) => m.mailbox !== "Sent" && m.from.email !== account?.address)?.from

  return (
    // A container, so the profile column depends on the reader's width, not the window's.
    <div className="@container">
    <div className="flex justify-center gap-2">
    <article className="flex w-full min-w-0 max-w-3xl flex-col gap-3 px-4 pb-8 md:px-8 md:pt-6">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 pb-1">
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-semibold tracking-tight break-words">{subject}</h2>
          <p className="flex flex-wrap items-center gap-2 pt-1 text-xs text-muted-foreground">
            {thread.length > 1 && <span>{thread.length} messages</span>}
            {showAccount && account && <Badge variant="secondary">{account.displayName}</Badge>}
            {reminder !== null && !due && (
              <span className="inline-flex items-center gap-1 text-vertical-mail">
                <Icon name="notifications" className="size-3.5" /> Reminder {longTime(reminder)} if nobody replies
              </span>
            )}
          </p>
        </div>
        <div className="-mr-2 flex shrink-0 items-center">
          {other && <AboutSender from={other} threadId={row.threadId} onOpenThread={onOpenThread} />}
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
          {target.mailbox !== "Sent" && (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="Sender options" />}>
                <Icon name="more_vert" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64 bg-popover">
                <DropdownMenuGroup>
                  <DropdownMenuLabel className="truncate">{displayName(target.from)}</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={row.category ?? "people"} onValueChange={(v) => senders.move(target.from, v as Category)}>
                    {CATEGORIES.map((c) => (
                      <DropdownMenuRadioItem key={c.id} value={c.id} closeOnClick>
                        Always in {c.label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => {
                    // A split for the sender's whole domain, unless it's a mailbox provider's.
                    const domain = target.from.email.split("@")[1]?.toLowerCase() ?? ""
                    const shared = /^(gmail|googlemail|outlook|hotmail|live|icloud|me|yahoo|proton|protonmail|fastmail)\./.test(domain)
                    const name = shared ? displayName(target.from) : domain.split(".").at(-2)?.replace(/^./, (c) => c.toUpperCase()) ?? domain
                    useUi.getState().openSplitEditor({ initial: { name, senders: [shared ? target.from.email.toLowerCase() : `@${domain}`], exclusive: true } })
                  }}
                >
                  <Icon name="tab_new_right" />
                  Make a split for {target.from.email.split("@")[1] && !/^(gmail|googlemail|outlook|hotmail|live|icloud|me|yahoo|proton|protonmail|fastmail)\./.test(target.from.email.split("@")[1]!.toLowerCase()) ? `@${target.from.email.split("@")[1]}` : "this sender"}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => senders.decide(target.from, "screened_out")}>
                  <Icon name="person_off" />
                  Screen out sender
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onClick={() => senders.decide(target.from, "blocked")}>
                  <Icon name="block" />
                  Block sender
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {reminder !== null ? (
            <ToolbarButton icon="notifications_active" label="Cancel reminder" active onClick={() => cancelFollowUp.mutate(row.threadId, { onSuccess: () => toast("Reminder cancelled") })} />
          ) : (
            sentAny && (
              <FollowUpAtMenu onPick={(at, label) => remind(row.threadId, at, label)} trigger={<Button variant="ghost" size="icon" aria-label="Remind me if no reply" />}>
                <Icon name="notifications" />
              </FollowUpAtMenu>
            )
          )}
        </div>
      </div>

      {screening && target.mailbox !== "Sent" && (
        <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border bg-accent/40 px-4 py-3 text-sm">
          <Icon name="waving_hand" className="size-5 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="font-medium">{displayName(target.from)}</span> is writing to you for the first time. Do you want their mail in your inbox?
          </span>
          <span className="flex gap-1">
            <Button variant="ghost" size="sm" onClick={() => senders.decide(target.from, "screened_out")}>
              <Icon name="person_off" data-icon="inline-start" /> Screen out
            </Button>
            <Button size="sm" onClick={() => senders.decide(target.from, "allowed")}>
              <Icon name="how_to_reg" data-icon="inline-start" /> Let in
            </Button>
          </span>
        </div>
      )}

      {due && (
        <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-vertical-mail/30 bg-vertical-mail/5 px-4 py-3 text-sm">
          <Icon name="notifications_active" className="size-5 text-vertical-mail" />
          <span className="min-w-0 flex-1">
            <span className="font-medium">No reply yet.</span> You asked to be reminded {longTime(reminder!)}.
          </span>
          <span className="flex gap-1">
            <FollowUpAtMenu onPick={(at, label) => remind(row.threadId, at, label)} trigger={<Button variant="ghost" size="sm" />}>
              Remind me again
            </FollowUpAtMenu>
            <Button variant="outline" size="sm" onClick={() => triage.toggleArchive(row)}>
              Done
            </Button>
          </span>
        </div>
      )}

      {target.mailbox !== "Sent" && target.unsubscribe && (
        <div className="flex">
          <UnsubscribeButton message={target} onArchive={() => !row.archived && triage.toggleArchive(row)} />
        </div>
      )}

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
    {other && (
      <aside aria-label="Sender" className="sticky top-0 hidden max-h-dvh w-72 shrink-0 overflow-y-auto pt-6 pr-6 pb-8 @4xl:block">
        <SenderProfile from={other} threadId={row.threadId} onOpenThread={onOpenThread} />
      </aside>
    )}
    </div>
    </div>
  )
}

/** Narrow readers: the same profile, a tap away in a sheet. */
function AboutSender({ from, threadId, onOpenThread }: { from: MessageDetail["from"]; threadId: string; onOpenThread?: (row: MessageSummary) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <span className="@4xl:hidden">
        <ToolbarButton icon="account_circle" label={`About ${displayName(from)}`} onClick={() => setOpen(true)} />
      </span>
      <Sheet open={open} onOpenChange={setOpen}>
        <AdaptiveSheetContent className="px-6 pb-6 sm:pt-6">
          <SheetTitle className="sr-only">About {displayName(from)}</SheetTitle>
          {open && (
            <SenderProfile
              from={from}
              threadId={threadId}
              onOpenThread={
                onOpenThread &&
                ((t) => {
                  setOpen(false)
                  onOpenThread(t)
                })
              }
            />
          )}
        </AdaptiveSheetContent>
      </Sheet>
    </>
  )
}
