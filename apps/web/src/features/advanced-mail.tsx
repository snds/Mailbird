import { toast } from "sonner"

import { useUi } from "@/app/ui-store"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, NativeSelect, NativeSelectOption, Switch, ToggleGroup, ToggleGroupItem } from "@unicron/ui"
import { useMailPrefs, useSetMailPrefs } from "@/core/queries"
import type { MailPrefs } from "@/core/types"

const IMAGES: { value: MailPrefs["images"]; label: string; hint: string }[] = [
  { value: "ask", label: "Ask", hint: "Blocked until you load them, message by message. Images can tell a sender you opened their mail, and when." },
  { value: "contacts", label: "From contacts", hint: "Loaded for people in your contacts; asked for everyone else." },
  { value: "always", label: "Always", hint: "Every message loads its images. Senders can see when you open their mail." },
]

const MARK_READ: { value: MailPrefs["markRead"]; label: string; hint: string }[] = [
  { value: "open", label: "On open", hint: "Opening a conversation marks it read." },
  { value: "delay", label: "After 3 s", hint: "It's marked read once it has been open for 3 seconds, so a glance doesn't count." },
  { value: "manual", label: "Manually", hint: "Only Mark read (or its swipe or shortcut) marks it read." },
]

const CHECK = [2, 5, 15, 30, 60]

/** Mail's power settings (ADR-0055): the choices most people never change, in one place. */
export function AdvancedMailDialog() {
  const open = useUi((s) => s.advancedMailOpen)
  const setOpen = useUi((s) => s.setAdvancedMailOpen)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Advanced mail settings</DialogTitle>
          <DialogDescription>The defaults keep your reading private. Change them here if you want more control.</DialogDescription>
        </DialogHeader>
        {open && <AdvancedMail />}
      </DialogContent>
    </Dialog>
  )
}

function AdvancedMail() {
  const { data: prefs } = useMailPrefs()
  const set = useSetMailPrefs()
  if (!prefs) return null
  const change = (p: Partial<MailPrefs>, said?: string) =>
    set.mutate({ ...prefs, ...p }, { onSuccess: () => said && toast.success(said, { duration: 2000 }), onError: (e) => toast.error(e.message) })

  return (
    <div className="flex flex-col gap-6">
      <Choice
        id="images"
        title="Remote images"
        value={prefs.images}
        options={IMAGES}
        onChange={(images) => change({ images }, images === "ask" ? "Images wait until you ask" : images === "contacts" ? "Images load for your contacts" : "Images always load")}
      />
      <Choice id="mark-read" title="Mark as read" value={prefs.markRead} options={MARK_READ} onChange={(markRead) => change({ markRead })} />

      <section className="flex flex-col gap-3" aria-labelledby="replies-heading">
        <h3 id="replies-heading" className="text-sm font-medium">
          Replies
        </h3>
        <Toggle id="reply-quote" title="Include the message you're replying to" hint="Quoted below an “On … wrote:” line." checked={prefs.quote} onChange={(quote) => change({ quote })} />
        <Toggle
          id="reply-below"
          title="Write below the quote"
          hint="The way mailing lists prefer it. Off: you write above, as most mail apps do."
          checked={prefs.quote && prefs.replyBelow}
          disabled={!prefs.quote}
          onChange={(replyBelow) => change({ replyBelow })}
        />
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="receipts-heading">
        <h3 id="receipts-heading" className="text-sm font-medium">
          Read receipts
        </h3>
        <Toggle
          id="request-receipts"
          title="Ask for a read receipt on everything I send"
          hint="Whether one comes back is up to the other person's app. You can still change it per message, in the composer. Mailbird never sends receipts for mail you read."
          checked={prefs.requestReceipts}
          onChange={(requestReceipts) => change({ requestReceipts })}
        />
      </section>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="check-minutes" className="text-sm font-medium">
          Check for new mail
        </label>
        <NativeSelect id="check-minutes" value={String(prefs.checkMinutes)} onChange={(e) => change({ checkMinutes: Number(e.target.value) })}>
          {CHECK.map((m) => (
            <NativeSelectOption key={m} value={String(m)}>
              {m === 60 ? "Every hour" : `Every ${m} minutes`}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <p className="text-xs text-muted-foreground">For accounts without push. With push, new mail arrives within seconds either way.</p>
      </div>
    </div>
  )
}

/** A three-way choice: the options in a row, and what the chosen one means under it. */
function Choice<T extends string>({ id, title, value, options, onChange }: { id: string; title: string; value: T; options: { value: T; label: string; hint: string }[]; onChange: (v: T) => void }) {
  return (
    <section className="flex flex-col gap-1.5" aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`} className="text-sm font-medium">
        {title}
      </h3>
      <ToggleGroup value={[value]} onValueChange={(v) => v[0] && onChange(v[0] as T)} variant="outline" size="sm" aria-labelledby={`${id}-heading`}>
        {options.map((o) => (
          <ToggleGroupItem key={o.value} value={o.value}>
            {o.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {options.find((o) => o.value === value)?.hint}
      </p>
    </section>
  )
}

function Toggle({ id, title, hint, checked, disabled, onChange }: { id: string; title: string; hint: string; checked: boolean; disabled?: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span id={`${id}-label`} className="text-sm">
          {title}
        </span>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </div>
      <Switch checked={checked} disabled={disabled} aria-labelledby={`${id}-label`} onCheckedChange={onChange} />
    </div>
  )
}
