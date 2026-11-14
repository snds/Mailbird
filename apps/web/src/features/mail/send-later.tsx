import { useState, type ReactElement, type ReactNode } from "react"

import { Icon, DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@unicron/ui"
import { DateTimePicker, MenuAnchor } from "@/components/date-picker"
import { FOLLOW_UP_OPTIONS, longTime, sendLaterOptions, snoozeOptions } from "@/lib/time"

/** "9:00 AM for Priya", and when that is for you. */
export interface TheirMorning {
  label: string
  at: number
  detail: string
}

/**
 * Send-later presets plus "Pick a time…". Each preset shows its exact time,
 * like the snooze menu, so "Tomorrow morning" is never ambiguous.
 */
export function SendLaterMenu({
  trigger,
  children,
  onPick,
  theirs = [],
}: {
  trigger: ReactElement
  children: ReactNode
  onPick: (at: number) => void
  /** Recipients in another time zone: offers 9:00 AM on their next workday (ADR-0041). */
  theirs?: TheirMorning[]
}) {
  const [custom, setCustom] = useState(false)
  return (
      <DropdownMenu>
        {/* The picker stands where the menu did: both open from the one button (ADR-0088). */}
        <DateTimePicker
          open={custom}
          onOpenChange={(open) => !open && setCustom(false)}
          trigger={<MenuAnchor menu={<DropdownMenuTrigger render={trigger}>{children}</DropdownMenuTrigger>} />}
          title="Send later"
          note="If the desktop app is closed then, it sends when it next opens. A gateway sends on time."
          action="Schedule"
          onPick={onPick}
        />
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Send later…</DropdownMenuLabel>
            {sendLaterOptions().map((o) => (
              <DropdownMenuItem key={o.label} onClick={() => onPick(o.until)}>
                <Icon name="time" />
                <span className="flex-1">{o.label}</span>
                <span className="text-xs text-muted-foreground">{o.detail}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          {theirs.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel>Their time</DropdownMenuLabel>
                {theirs.map((t) => (
                  <DropdownMenuItem key={t.label} onClick={() => onPick(t.at)}>
                    <Icon name="time" />
                    <span className="flex-1">{t.label}</span>
                    <span className="text-xs text-muted-foreground">{t.detail}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setCustom(true)}>
            <Icon name="calendar" />
            Pick a time…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
  )
}

/** "Remind me if no reply" for a message being written: a delay after it goes out. */
export function FollowUpAfterMenu({ trigger, children, value, onChange }: { trigger: ReactElement; children: ReactNode; value: number | null; onChange: (after: number | null) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={trigger}>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Remind me if no reply in…</DropdownMenuLabel>
          {FOLLOW_UP_OPTIONS.map((o) => (
            <DropdownMenuItem key={o.label} onClick={() => onChange(o.after)}>
              <Icon name={value === o.after ? "checkmark" : "notification"} />
              {o.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        {value !== null && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onChange(null)}>
              <Icon name="notification--off" />
              Don't remind me
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** "Remind me if no reply" for a conversation already sent: a time. */
export function FollowUpAtMenu({ trigger, children, onPick }: { trigger: ReactElement; children: ReactNode; onPick: (at: number, label: string) => void }) {
  const [custom, setCustom] = useState(false)
  return (
      <DropdownMenu>
        <DateTimePicker
          open={custom}
          onOpenChange={(open) => !open && setCustom(false)}
          trigger={<MenuAnchor menu={<DropdownMenuTrigger render={trigger}>{children}</DropdownMenuTrigger>} />}
          title="Remind me if no reply"
          note="If nobody has replied by then, the conversation comes back to the top of your inbox."
          action="Set reminder"
          onPick={(at) => onPick(at, longTime(at))}
        />
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Remind me if no reply…</DropdownMenuLabel>
            {snoozeOptions().map((o) => (
              <DropdownMenuItem key={o.label} onClick={() => onPick(o.until, o.label.toLowerCase())}>
                <Icon name="notification" />
                <span className="flex-1">{o.label}</span>
                <span className="text-xs text-muted-foreground">{o.detail}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setCustom(true)}>
            <Icon name="calendar" />
            Pick a time…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
  )
}
