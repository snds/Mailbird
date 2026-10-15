import { toast } from "sonner"

import { useUi } from "@/app/ui-store"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Kbd } from "@/components/ui/kbd"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { useSetSwipeActions, useSwipeActions } from "@/core/queries"
import type { SwipeActionId, SwipeActions } from "@/core/types"

import { MAIL_SHORTCUTS } from "./mail/use-shortcuts"
import { SWIPE_CHOICES } from "./mail/vocabulary"

const SLOTS: { key: keyof SwipeActions; label: string; long: boolean }[] = [
  { key: "right", label: "Swipe right", long: false },
  { key: "rightLong", label: "Swipe right, all the way", long: true },
  { key: "left", label: "Swipe left", long: false },
  { key: "leftLong", label: "Swipe left, all the way", long: true },
]

/**
 * Shortcuts and gestures (ADR-0025): one vocabulary, two ways in. The swipe
 * mapping lives in the core, so it follows you across browsers and devices.
 */
export function GrammarDialog() {
  const open = useUi((s) => s.grammarOpen)
  const setOpen = useUi((s) => s.setGrammarOpen)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">{open && <Grammar />}</DialogContent>
    </Dialog>
  )
}

function Grammar() {
  const { data: swipes } = useSwipeActions()
  const save = useSetSwipeActions()
  const set = (key: keyof SwipeActions, id: SwipeActionId) => {
    if (!swipes) return
    save.mutate(
      { ...swipes, [key]: id },
      { onSuccess: () => toast.success("Swipes saved", { duration: 1500 }), onError: (e) => toast.error(e.message) },
    )
  }
  return (
    <div className="flex flex-col gap-5">
      <DialogHeader>
        <DialogTitle>Shortcuts and gestures</DialogTitle>
        <DialogDescription>The same actions three ways: a key, a swipe on a phone, or ⌘K. Every swipe also has a key or a button, so nothing is gesture-only.</DialogDescription>
      </DialogHeader>
      <section aria-label="Swipes" className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Swipes in the mail list</h3>
        {SLOTS.map((slot) => (
          <label key={slot.key} className="flex items-center justify-between gap-3 text-sm">
            <span className={slot.long ? "pl-4 text-muted-foreground" : ""}>{slot.label}</span>
            <NativeSelect
              aria-label={slot.label}
              className="w-56"
              value={swipes?.[slot.key] ?? "none"}
              disabled={!swipes}
              onChange={(e) => set(slot.key, e.target.value as SwipeActionId)}
            >
              {SWIPE_CHOICES.map((c) => (
                <NativeSelectOption key={c.id} value={c.id}>
                  {c.id === "none" && slot.long ? "Same as a short swipe" : c.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
        ))}
        <p className="text-xs text-muted-foreground">A short swipe acts once you pass a third of the row; “all the way” takes over past two thirds. The Screener keeps its own: right lets a sender in, left screens them out.</p>
      </section>
      <section aria-label="Keyboard" className="flex flex-col gap-1">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Keyboard in Mail</h3>
        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1.5 text-sm">
          {MAIL_SHORTCUTS.map((s) => (
            <div key={s.does} className="contents">
              <dt className="flex gap-1">
                {s.keys.map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </dt>
              <dd>{s.does}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  )
}
