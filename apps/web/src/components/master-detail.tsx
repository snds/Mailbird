import type { ReactNode } from "react"

import { Icon } from "@/components/icon"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import type { IconName } from "@/components/icon"
import { cn } from "@/lib/utils"

interface MasterDetailProps {
  /** Header for the list pane: title, search, filters. */
  header: ReactNode
  list: ReactNode
  detail: ReactNode | null
  onBack: () => void
  emptyIcon: IconName
  emptyLabel: string
}

/**
 * The list → detail pattern every vertical shares.
 * Phone: one pane at a time; selecting an item pushes the detail, Back pops it.
 * Tablet and up: both panes side by side; the detail shows an empty state.
 */
export function MasterDetail({ header, list, detail, onBack, emptyIcon, emptyLabel }: MasterDetailProps) {
  const hasDetail = detail !== null
  return (
    <div className="flex min-h-0 flex-1">
      <section
        className={cn(
          "flex min-w-0 flex-1 flex-col bg-surface-chrome md:w-(--c-shell-list-width) md:flex-none md:border-r",
          hasDetail && "hidden md:flex"
        )}
      >
        {header}
        <div data-scroll-root className="min-h-0 flex-1 overflow-y-auto">
          {list}
        </div>
      </section>
      <section className={cn("min-w-0 flex-1 flex-col", hasDetail ? "flex" : "hidden md:flex")}>
        {hasDetail ? (
          <>
            <div className="flex h-14 shrink-0 items-center gap-1 px-2 md:hidden">
              <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back">
                <Icon name="arrow_back" className="size-5" />
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">{detail}</div>
          </>
        ) : (
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Icon name={emptyIcon} />
              </EmptyMedia>
              <EmptyTitle>Nothing selected</EmptyTitle>
              <EmptyDescription>{emptyLabel}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </section>
    </div>
  )
}

export function PaneHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="flex shrink-0 flex-col gap-3 px-4 pt-4 pb-3">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <div className="flex items-center gap-1">{children}</div>
      </div>
    </header>
  )
}
