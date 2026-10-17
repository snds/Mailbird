import { toast } from "sonner"

import { useUi } from "@/app/ui-store"
import { Button, Icon, IconButton, Item, ItemContent, ItemMedia, Skeleton } from "@unicron/ui"
import type { SuggestedReplies, ThreadSummary } from "@/core/types"

import { byline, type useSuggestedReplies, type useThreadSummary } from "./use-ai-assist"

/** Placeholder bars while the model writes, sized by their wrappers (the library owns Skeleton's look). */
function Placeholder({ widths, label, pill }: { widths: string[]; label: string; pill?: boolean }) {
  return (
    <div role="status" aria-label={label} className={pill ? "flex flex-wrap gap-2 [&_[data-slot=skeleton]]:size-full [&_[data-slot=skeleton]]:rounded-full" : "flex flex-col gap-2 py-1 [&_[data-slot=skeleton]]:size-full"}>
      {widths.map((w, i) => (
        <div key={i} className={pill ? `h-8 ${w}` : `h-3.5 ${w}`}>
          <Skeleton />
        </div>
      ))}
    </div>
  )
}

/** Opens AI settings, where a failed answer can be fixed. */
const openSettings = () => useUi.getState().setAiSettingsOpen(true)

function Failed({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-start gap-x-3 gap-y-2 text-sm [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-destructive">
      <Icon name="error" />
      <span className="min-w-0 flex-1">{message}</span>
      <span className="flex gap-1">
        <Button variant="ghost" size="xs" onClick={openSettings}>
          Settings
        </Button>
        <Button variant="outline" size="xs" onClick={retry}>
          Try again
        </Button>
      </span>
    </div>
  )
}

/**
 * The summary above the messages: a few bullets, what wrote them, and how
 * much of the thread they cover. It goes when closed; asking again re-asks.
 */
export function SummaryCard({ summary, onClose }: { summary: ReturnType<typeof useThreadSummary>; onClose: () => void }) {
  if (summary.isIdle) return null
  const data: ThreadSummary | undefined = summary.data
  const copy = async () => {
    if (!data) return
    try {
      await navigator.clipboard.writeText(data.points.map((p) => `• ${p}`).join("\n"))
      toast.success("Summary copied", { duration: 2000 })
    } catch {
      toast.error("Couldn't reach the clipboard")
    }
  }
  return (
    <section aria-label="Summary" aria-busy={summary.isPending} className="flex flex-col gap-2 rounded-2xl border bg-muted/40 px-4 py-3" data-role="ai-summary">
      <div className="-mr-2 flex items-center gap-2">
        <h3 className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-medium [&_svg]:size-4 [&_svg]:text-muted-foreground">
          <Icon name="summarize" /> Summary
        </h3>
        {data && <IconButton icon="content_copy" label="Copy summary" size="icon-sm" onClick={() => void copy()} />}
        <IconButton icon="close" label="Close summary" size="icon-sm" onClick={onClose} />
      </div>
      {summary.isPending && (
        <Placeholder label="Summarizing" widths={["w-11/12", "w-4/5", "w-2/3"]} />
      )}
      {summary.isError && <Failed message={summary.error.message} retry={() => summary.mutate()} />}
      {data && (
        <>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm marker:text-muted-foreground">
            {data.points.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            {data.used < data.total ? `From the newest ${data.used} of ${data.total} messages. ` : ""}
            Written by {byline(data.provider, data.model)}. It can get things wrong, so check what matters.
          </p>
        </>
      )}
    </section>
  )
}

/**
 * Suggested replies under the conversation. Picking one opens the composer
 * with it, to change or send; nothing is ever sent from here.
 */
export function SuggestedRepliesRow({ replies, onPick }: { replies: ReturnType<typeof useSuggestedReplies>; onPick: (text: string) => void }) {
  if (replies.isIdle) return null
  const data: SuggestedReplies | undefined = replies.data
  return (
    <section aria-label="Suggested replies" aria-busy={replies.isPending} className="flex flex-col gap-2" data-role="ai-replies">
      {replies.isPending && (
        <Placeholder label="Thinking of replies" widths={["w-60", "w-72", "w-52"]} />
      )}
      {replies.isError && <Failed message={replies.error.message} retry={() => replies.mutate()} />}
      {data && (
        <>
          <div className="flex flex-col gap-2">
            {data.replies.map((r) => (
              <Item key={r} variant="outline" size="sm" render={<button type="button" onClick={() => onPick(r)} />}>
                <ItemMedia variant="icon">
                  <Icon name="reply" tone="muted" />
                </ItemMedia>
                <ItemContent>
                  <span className="text-sm">{r}</span>
                </ItemContent>
              </Item>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">By {byline(data.provider, data.model)}. Pick one to edit it before you send.</p>
        </>
      )}
    </section>
  )
}
