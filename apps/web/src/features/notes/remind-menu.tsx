import { useState } from "react"

import { Icon, DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, IconButton } from "@unicron/ui"
import { PickTimeDialog } from "@/features/mail/send-later"
import { reminderLabel, snoozeOptions } from "@/lib/time"

/**
 * "Remind me": the snooze presets (each with its exact time, so "Tomorrow"
 * is never vague), any date and time, and removing one (ADR-0039).
 */
export function RemindMenu({ value, onPick }: { value: number | null; onPick: (at: number | null) => void }) {
  const [custom, setCustom] = useState(false)
  const label = value ? `Reminder: ${reminderLabel(value)}` : "Remind me"
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<IconButton label={label} />}>
          <Icon name={value ? "notifications_active" : "notification_add"} className="size-5" fill={!!value} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64 bg-popover">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Remind me…</DropdownMenuLabel>
            {snoozeOptions().map((o) => (
              <DropdownMenuItem key={o.label} onClick={() => onPick(o.until)}>
                <Icon name="schedule" />
                <span className="flex-1">{o.label}</span>
                <span className="text-xs text-muted-foreground">{o.detail}</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem onClick={() => setCustom(true)}>
              <Icon name="edit_calendar" /> Pick a date and time…
            </DropdownMenuItem>
          </DropdownMenuGroup>
          {value && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onPick(null)}>
                <Icon name="notifications_off" /> Remove reminder
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <PickTimeDialog
        open={custom}
        onOpenChange={setCustom}
        title="Remind me"
        description="The note comes back at this time, with a notification."
        action="Set reminder"
        onPick={(at) => onPick(at)}
      />
    </>
  )
}
