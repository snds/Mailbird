import { useVirtualizer } from "@tanstack/react-virtual"
import { useLayoutEffect, useRef, useState, type ReactNode } from "react"

interface VirtualListProps<T> {
  items: T[]
  /** A stable key per item. */
  itemKey: (item: T) => string
  render: (item: T) => ReactNode
  /** First guess at a row's height; real heights are measured. */
  estimate: number
  /** Called as the list nears its end, to load the next page. */
  onEnd?: () => void
  label: string
}

/**
 * A long list that only renders the rows on screen (plus a few either side),
 * so ten thousand conversations scroll as smoothly as ten. It scrolls with
 * the nearest `data-scroll-root` ancestor, which keeps the pane's own
 * scrolling (and the header above it) unchanged. Rows keep list semantics:
 * each says where it sits in the whole list for screen readers.
 */
export function VirtualList<T>({ items, itemKey, render, estimate, onEnd, label }: VirtualListProps<T>) {
  // The virtualizer hands back fresh functions every render, which the React
  // Compiler can't memoize safely; this component opts out of it.
  "use no memo"
  const ref = useRef<HTMLDivElement>(null)
  const [root, setRoot] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => setRoot(ref.current?.closest<HTMLElement>("[data-scroll-root]") ?? null), [])
  // eslint-disable-next-line react/incompatible-library -- opted out of memoization above
  const v = useVirtualizer({
    count: items.length,
    getScrollElement: () => root,
    estimateSize: () => estimate,
    overscan: 8,
    getItemKey: (i) => itemKey(items[i]!),
    // The list may start below other content in the scroll root.
    scrollMargin: ref.current?.offsetTop ?? 0,
  })
  const rows = v.getVirtualItems()
  const last = rows.at(-1)?.index ?? -1
  const onEndRef = useRef(onEnd)
  useLayoutEffect(() => {
    onEndRef.current = onEnd
  })
  useLayoutEffect(() => {
    if (last >= items.length - 20) onEndRef.current?.()
  }, [last, items.length])

  return (
    <div ref={ref} role="list" aria-label={label} style={{ height: v.getTotalSize(), position: "relative" }}>
      {rows.map((r) => (
        <div
          key={r.key}
          data-index={r.index}
          ref={v.measureElement}
          role="listitem"
          aria-setsize={items.length}
          aria-posinset={r.index + 1}
          className="absolute inset-x-0 top-0"
          style={{ transform: `translateY(${r.start - v.options.scrollMargin}px)` }}
        >
          {render(items[r.index]!)}
        </div>
      ))}
    </div>
  )
}
