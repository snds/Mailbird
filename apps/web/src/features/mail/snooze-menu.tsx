import type { ReactElement, ReactNode } from "react"

import { Icon, DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@unicron/ui"
import { snoozeOptions } from "@/lib/time"

/** Snooze presets. Each shows the exact time, so "Tomorrow" is never ambiguous. */
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
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={trigger}>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuGroup>
        <DropdownMenuLabel>Snooze until…</DropdownMenuLabel>
        {options.map((o) => (
          <DropdownMenuItem key={o.label} onClick={() => onSnooze(o.until, o.label)}>
            <Icon name="schedule" />
            <span className="flex-1">{o.label}</span>
            <span className="text-xs text-muted-foreground">{o.detail}</span>
          </DropdownMenuItem>
        ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
