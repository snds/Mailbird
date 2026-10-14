import { useState, type ReactElement, type ReactNode } from "react"

import { Icon } from "@/components/icon"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { useNowSecs } from "@/hooks/use-now"
import { FOLLOW_UP_OPTIONS, fromLocalInput, longTime, sendLaterOptions, snoozeOptions, toLocalInput } from "@/lib/time"

/**
 * Send-later presets plus "Pick a time…". Each preset shows its exact time,
 * like the snooze menu, so "Tomorrow morning" is never ambiguous.
 */
export function SendLaterMenu({ trigger, children, onPick }: { trigger: ReactElement; children: ReactNode; onPick: (at: number) => void }) {
  const [custom, setCustom] = useState(false)
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={trigger}>{children}</DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64 bg-popover">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Send later…</DropdownMenuLabel>
            {sendLaterOptions().map((o) => (
              <DropdownMenuItem key={o.label} onClick={() => onPick(o.until)}>
                <Icon name="schedule_send" />
                <span className="flex-1">{o.label}</span>
                <span className="text-xs text-muted-foreground">{o.detail}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setCustom(true)}>
            <Icon name="calendar_month" />
            Pick a time…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <PickTimeDialog
        open={custom}
        onOpenChange={setCustom}
        title="Send later"
        description="Mailbird sends it at this time. The desktop app sends it the next time it runs if it's closed then; a gateway sends it on time."
        action="Schedule"
        onPick={onPick}
      />
    </>
  )
}

/** "Remind me if no reply" for a message being written: a delay after it goes out. */
export function FollowUpAfterMenu({ trigger, children, value, onChange }: { trigger: ReactElement; children: ReactNode; value: number | null; onChange: (after: number | null) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={trigger}>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60 bg-popover">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Remind me if no reply in…</DropdownMenuLabel>
          {FOLLOW_UP_OPTIONS.map((o) => (
            <DropdownMenuItem key={o.label} onClick={() => onChange(o.after)}>
              <Icon name={value === o.after ? "check" : "notifications"} />
              {o.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        {value !== null && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onChange(null)}>
              <Icon name="notifications_off" />
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
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={trigger}>{children}</DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64 bg-popover">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Remind me if no reply…</DropdownMenuLabel>
            {snoozeOptions().map((o) => (
              <DropdownMenuItem key={o.label} onClick={() => onPick(o.until, o.label.toLowerCase())}>
                <Icon name="notifications" />
                <span className="flex-1">{o.label}</span>
                <span className="text-xs text-muted-foreground">{o.detail}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setCustom(true)}>
            <Icon name="calendar_month" />
            Pick a time…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <PickTimeDialog
        open={custom}
        onOpenChange={setCustom}
        title="Remind me if no reply"
        description="If nobody has replied by then, the conversation comes back to the top of your inbox."
        action="Set reminder"
        onPick={(at) => onPick(at, longTime(at))}
      />
    </>
  )
}

function PickTimeDialog({
  open,
  onOpenChange,
  title,
  description,
  action,
  onPick,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  action: string
  onPick: (at: number) => void
}) {
  // Starts an hour out, on the hour.
  const [value, setValue] = useState(() => toLocalInput(Math.ceil(Date.now() / 3_600_000 + 1) * 3600))
  const at = fromLocalInput(value)
  const now = useNowSecs(15_000)
  const tooSoon = at !== null && at <= now + 60
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <form
          className="flex flex-col gap-4"
          // React events cross portals: keep these from reaching a composer form around the menu.
          onKeyDown={(e) => e.stopPropagation()}
          onSubmit={(e) => {
            e.preventDefault()
            e.stopPropagation()
            if (at === null || tooSoon) return
            onOpenChange(false)
            onPick(at)
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="pick-time">Date and time</FieldLabel>
            <Input id="pick-time" type="datetime-local" required value={value} onChange={(e) => setValue(e.target.value)} />
            {tooSoon && <FieldDescription className="text-destructive">Pick a time at least a minute from now.</FieldDescription>}
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={at === null || tooSoon}>
              {action}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
