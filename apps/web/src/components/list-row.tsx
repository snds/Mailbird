import type { ReactNode } from "react"

import { Icon } from "@/components/icon"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { cn } from "@/lib/utils"

/**
 * Shared row anatomy for messages, contacts, and notes.
 * Slots: leading (avatar/icon) · title · meta (time) · supporting text · trailing.
 * Sized for a 44px+ touch target; density modes can retune the tier-3 tokens.
 */
export function ListRow({
  selected,
  onSelect,
  leading,
  title,
  meta,
  supporting,
  trailing,
  emphasized,
}: {
  selected?: boolean
  onSelect: () => void
  leading?: ReactNode
  title: ReactNode
  meta?: ReactNode
  supporting?: ReactNode
  trailing?: ReactNode
  /** Unread / needs-attention state: bolder title + indicator dot. */
  emphasized?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      data-selected={selected}
      className={cn(
        "relative flex w-full items-start gap-(--c-list-row-gap) px-(--c-list-row-padding-x) py-(--c-list-row-padding-y) text-left outline-none transition-colors",
        "hover:bg-accent/50 focus-visible:bg-accent/60 data-[selected=true]:bg-(--c-list-row-selected)"
      )}
    >
      {emphasized && (
        <span aria-hidden className="absolute top-1/2 left-1.5 size-2 -translate-y-1/2 rounded-full bg-(--c-list-row-unread-dot)" />
      )}
      {leading}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-baseline gap-2">
          <span className={cn("truncate text-sm", emphasized ? "font-semibold" : "font-medium")}>{title}</span>
          {meta && <span className="ml-auto shrink-0 text-xs text-muted-foreground">{meta}</span>}
        </span>
        {supporting && <span className="line-clamp-2 text-sm text-muted-foreground">{supporting}</span>}
      </span>
      {trailing}
    </button>
  )
}

export function SearchField({ placeholder, value, onChange }: { placeholder: string; value?: string; onChange?: (v: string) => void }) {
  return (
    <InputGroup className="h-10 rounded-xl bg-background">
      <InputGroupAddon>
        <Icon name="search" />
      </InputGroupAddon>
      <InputGroupInput type="search" placeholder={placeholder} aria-label={placeholder} value={value} onChange={onChange && ((e) => onChange(e.target.value))} />
    </InputGroup>
  )
}
