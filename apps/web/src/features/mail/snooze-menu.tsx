import { useState, type ReactElement, type ReactNode } from "react"

import { Icon, DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@unicron/ui"
import { DateTimePicker, MenuAnchor } from "@/components/date-picker"
import { longTime, snoozeOptions } from "@/lib/time"

/** Snooze presets, each with its exact time, so "Tomorrow" is never ambiguous; then any date and time (brief M8). */
export function SnoozeMenu({
  trigger,
  children,
  onSnooze,
}: {
  trigger: ReactElement
  children: ReactNode
  onSnooze: (until: number, label: string) => void
}) {
  const options = snoozeOptions()
  const [custom, setCustom] = useState(false)
  return (
    <DropdownMenu>
      {/* The picker stands where the menu did: both open from the one button (ADR-0088). */}
      <DateTimePicker
        open={custom}
        onOpenChange={(open) => !open && setCustom(false)}
        trigger={<MenuAnchor menu={<DropdownMenuTrigger render={trigger}>{children}</DropdownMenuTrigger>} />}
        title="Snooze"
        action="Snooze"
        onPick={(at) => onSnooze(at, longTime(at))}
      />
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Snooze until…</DropdownMenuLabel>
          {options.map((o) => (
            <DropdownMenuItem key={o.label} onClick={() => onSnooze(o.until, o.label)}>
              <Icon name="time" />
              <span className="flex-1">{o.label}</span>
              <span className="text-xs text-muted-foreground">{o.detail}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => setCustom(true)}>
          <Icon name="calendar" />
          Pick date and time…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
