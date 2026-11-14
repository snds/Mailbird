import type { ReactNode } from "react"

import { AppFramePageHead, useAppFrame, type AppFramePageHeadProps } from "@unicron/ui"

interface ScreenHeadProps extends Pick<AppFramePageHeadProps, "overline" | "title" | "meta" | "count" | "size" | "switcher" | "gap"> {
  /**
   * The head's own controls: range chips, one text button, up to two icon
   * buttons. On a phone they wrap to a line under the title. On a short
   * screen the head is its small title alone, so they take a line of their
   * own under it and stay in reach.
   */
  actions?: ReactNode
  /** What belongs to the head and sits right under it: a search field, a chip row. */
  below?: ReactNode
  /** The title on a short screen, where the head is its small title alone: the place, when the large title says something else ("Today" over the Inbox). */
  short?: string
}

/**
 * The head of a list or a page in Vale (ADR-0083): unicron's page head with
 * the frame's spacing, wired to the phone's small title. It replaces the old
 * pane header. `switcher` makes the whole head the button that opens the
 * section's second level (brief X1).
 */
export function ScreenHead({ overline, title, meta, count, size, switcher, gap, actions, below, short }: ScreenHeadProps) {
  const frame = useAppFrame()
  // The short screen's head draws its title only (the frame collapses it), and a collapsed head has no
  // actions slot: there the controls take a line of their own under it.
  const rail = frame.layout === "rail"
  const under =
    rail && actions ? (
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
        {below}
      </div>
    ) : (
      below
    )
  return (
    <AppFramePageHead
      overline={overline}
      title={rail ? (short ?? title) : title}
      meta={meta}
      count={count}
      size={size}
      switcher={switcher}
      gap={gap}
      actions={rail ? undefined : actions}
      below={under}
    />
  )
}
