import { useRef, type ReactNode } from "react"

import { AppFrameDetail, AppFrameInset, AppFrameList, Button, EmptyState, Icon, useAppFrame } from "@unicron/ui"
import { DemoBar } from "@/app/demo-bar"
import { usePushedScreen } from "@/app/places"
import { useScreen, useScreenRoot } from "@/app/screen"

interface MasterDetailProps {
  /** The section, as the list column's name and the overline of an empty detail ("Mail"). */
  section: string
  /** The list column's head: the page head, then search and filters. It scrolls away with the list. */
  header: ReactNode
  list: ReactNode
  detail: ReactNode | null
  onBack: () => void
  /** Back to the section's first screen, when that is more than closing what is open (Mail returns to the Inbox). */
  onRoot?: () => void
  /** What to pick, under "Nothing open.": "Pick a conversation to see it here." */
  pick: string
  /** The list takes the whole width while nothing is open (a card grid);
   * then Back shows at every size, to return to it. */
  listFills?: boolean
  /** A background for the detail pane, edge to edge (a note's color). */
  detailTint?: string
  /** What opens in the detail is a place of its own (a Settings section), so its history entry is the place's. */
  detailIsPlace?: boolean
}

/**
 * The list → detail pattern every section shares, on the frame's own columns
 * (ADR-0083). Expanded: the list (432) beside the detail, which says "Nothing
 * open." until something is picked. Narrower: one column; picking an item
 * pushes the detail over the list, which keeps its place. The way back is the
 * phone's top bar, or the status line's leading slot at medium width.
 * With `listFills`, the list has the room until something opens.
 */
export function MasterDetail({ section, header, list, detail, onBack, onRoot, pick, listFills = false, detailTint, detailIsPlace = false }: MasterDetailProps) {
  const frame = useAppFrame()
  const hasDetail = !!detail
  // Pushed over the list (compact and medium): Back closes it and returns to the list where it was (ADR-0084).
  usePushedScreen(hasDetail && !detailIsPlace, onBack)
  const wide = listFills && !hasDetail
  const refresh = useScreen((s) => s.refresh)
  const body = useRef<HTMLDivElement>(null)
  useScreenRoot(() => {
    ;(onRoot ?? onBack)()
    body.current?.closest("[data-scroll-root]")?.scrollTo({ top: 0 })
  })
  return (
    <>
      <AppFrameList aria-label={section} data-scroll-root="" size={wide ? "fill" : "default"} onRefresh={refresh ?? undefined}>
        <DemoBar in="column" />
        {header}
        <div ref={body}>{list}</div>
      </AppFrameList>
      {!wide && (
        <AppFrameDetail open={hasDetail} onBack={onBack} aria-label={hasDetail ? `${section}: what is open` : `${section}: nothing open`}>
          <DemoBar in="column" />
          {hasDetail ? (
            // The tint reaches the pane's edges: its spread is cut by the column's own clip.
            <div className="flex min-h-full flex-col" style={detailTint ? { background: detailTint, boxShadow: `0 0 0 100vmax ${detailTint}` } : undefined}>
              {listFills && frame.split && (
                <div className="flex shrink-0 items-center">
                  <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back">
                    <Icon name="arrow--left" />
                  </Button>
                </div>
              )}
              {detail}
            </div>
          ) : (
            <AppFrameInset>
              <EmptyState size="sm" overline={section} title="Nothing open." body={pick} />
            </AppFrameInset>
          )}
        </AppFrameDetail>
      )}
    </>
  )
}
