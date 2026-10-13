import { useUi } from "@/app/ui-store"
import { Icon } from "@/components/icon"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { Account, MessageDetail } from "@/core/types"
import { longTime } from "@/lib/time"

import type { useTriage } from "./actions"
import { displayName, forwardDraft, initials, replyDraft } from "./format"
import { HtmlBody } from "./html-body"
import { SnoozeMenu } from "./snooze-menu"

function ToolbarButton({ icon, label, shortcut, onClick, active }: { icon: Parameters<typeof Icon>[0]["name"]; label: string; shortcut?: string; onClick?: () => void; active?: boolean }) {
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

export function MessageView({
  message,
  account,
  showAccount,
  triage,
}: {
  message: MessageDetail | undefined
  account: Account | undefined
  showAccount: boolean
  triage: ReturnType<typeof useTriage>
}) {
  const openComposer = useUi((s) => s.openComposer)
  if (!message) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 md:px-8 md:pt-6">
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="h-10 w-1/2" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }
  // The core clears snoozedUntil when a snooze wakes, so set means still snoozed.
  const snoozed = message.snoozedUntil !== null

  return (
    <article className="mx-auto flex max-w-3xl flex-col gap-4 px-4 pb-8 md:px-8 md:pt-6">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <h2 className="min-w-0 flex-1 text-xl font-semibold tracking-tight break-words">
          {message.subject || "(no subject)"}
        </h2>
        <div className="-mr-2 flex shrink-0 items-center">
          <ToolbarButton
            icon={message.archived ? "unarchive" : "archive"}
            label={message.archived ? "Move to Inbox" : "Archive"}
            shortcut="E"
            onClick={() => triage.toggleArchive(message)}
          />
          {snoozed ? (
            <ToolbarButton icon="notifications_active" label="Unsnooze" onClick={() => triage.unsnooze(message)} active />
          ) : (
            <SnoozeMenu
              onSnooze={(until, label) => triage.snooze(message, until, label)}
              trigger={<Button variant="ghost" size="icon" aria-label="Snooze" />}
            >
              <Icon name="snooze" />
            </SnoozeMenu>
          )}
          <ToolbarButton icon="star" label={message.flagged ? "Unstar" : "Star"} shortcut="S" active={message.flagged} onClick={() => triage.toggleFlag(message)} />
          <ToolbarButton icon="mark_email_unread" label="Mark unread" shortcut="U" onClick={() => triage.markSeen(message, false)} />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Avatar size="lg">
          <AvatarFallback>{initials(message.from)}</AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">{displayName(message.from)}</span>
          <span className="truncate text-xs text-muted-foreground">
            {message.from.email} · to {message.to.map(displayName).join(", ") || "you"}
          </span>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="text-xs text-muted-foreground">{longTime(message.date)}</span>
          {showAccount && account && <Badge variant="secondary">{account.displayName}</Badge>}
        </div>
      </div>
      <Separator />

      {message.bodyHtml ? (
        <HtmlBody html={message.bodyHtml} />
      ) : (
        <div className="text-[15px] leading-relaxed break-words whitespace-pre-line">{message.bodyText}</div>
      )}

      <div className="flex gap-2 pt-2">
        <Button variant="outline" onClick={() => openComposer(replyDraft(message))}>
          <Icon name="reply" data-icon="inline-start" /> Reply
        </Button>
        <Button
          variant="outline"
          onClick={() => openComposer(forwardDraft(message))}
        >
          <Icon name="forward" data-icon="inline-start" /> Forward
        </Button>
      </div>
    </article>
  )
}
