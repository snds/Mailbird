import { useState } from "react"
import { toast } from "sonner"

import { useUi } from "@/app/ui-store"
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Kbd, NativeSelect, NativeSelectOption } from "@unicron/ui"
import { useKeyBindings, useSetKeyBindings, useSetSwipeActions, useSwipeActions } from "@/core/queries"
import type { SwipeActionId, SwipeActions } from "@/core/types"
import { DEFAULT_KEYS, FIXED_KEYS, KEY_COMMANDS, type KeyArea, type KeyBindings, keyLabel, keyProblem, rebind } from "@/lib/keys"

import { SWIPE_CHOICES } from "./mail/vocabulary"

const SLOTS: { key: keyof SwipeActions; label: string; long: boolean }[] = [
  { key: "right", label: "Swipe right", long: false },
  { key: "rightLong", label: "Swipe right, all the way", long: true },
  { key: "left", label: "Swipe left", long: false },
  { key: "leftLong", label: "Swipe left, all the way", long: true },
]

const AREAS: { area: KeyArea; heading: string }[] = [
  { area: "mail", heading: "Keyboard in Mail" },
  { area: "calendar", heading: "Keyboard in Calendar" },
]

/** Keys that only modify another key; capture waits past them. */
const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn", "OS"])

/**
 * Shortcuts and gestures (ADR-0025, ADR-0032): one vocabulary, every way
 * in. Swipes and keys live in the core, so they follow you across browsers
 * and devices.
 */
export function GrammarDialog() {
  const open = useUi((s) => s.grammarOpen)
  const setOpen = useUi((s) => s.setGrammarOpen)
  // While a key is being captured, Esc cancels that, not the dialog.
  const [capturing, setCapturing] = useState<string | null>(null)
  return (
    <Dialog
      open={open}
      onOpenChange={(o, details) => {
        if (!o && capturing && details.reason === "escape-key") return details.cancel()
        setOpen(o)
        setCapturing(null)
      }}
    >
      <DialogContent size="lg">
        {open && <Grammar capturing={capturing} setCapturing={setCapturing} />}
      </DialogContent>
    </Dialog>
  )
}

function Grammar({ capturing, setCapturing }: { capturing: string | null; setCapturing: (id: string | null) => void }) {
  const { data: swipes } = useSwipeActions()
  const save = useSetSwipeActions()
  const { data: keys } = useKeyBindings()
  const saveKeys = useSetKeyBindings()
  const set = (key: keyof SwipeActions, id: SwipeActionId) => {
    if (!swipes) return
    save.mutate(
      { ...swipes, [key]: id },
      { onSuccess: () => toast.success("Swipes saved", { duration: 1500 }), onError: (e) => toast.error(e.message) },
    )
  }
  const store = (next: KeyBindings, message: string) =>
    saveKeys.mutate(next, { onSuccess: () => toast.success(message, { duration: 2500 }), onError: (e) => toast.error(e.message) })
  const assign = (id: string, key: string) => {
    if (!keys) return
    const { next, swapped } = rebind(keys, id, key)
    const does = KEY_COMMANDS.find((c) => c.id === id)!.does
    const old = keys[id] ?? ""
    store(
      next,
      key === ""
        ? `“${does}” has no key now`
        : swapped
          ? `${keyLabel(key)} now does “${does}”. “${swapped.does}” moved to ${old ? keyLabel(old) : "no key"}.`
          : `${keyLabel(key)} now does “${does}”`,
    )
  }
  const changed = keys && KEY_COMMANDS.some((c) => keys[c.id] !== DEFAULT_KEYS[c.id])

  return (
    <div className="flex flex-col gap-5">
      <DialogHeader>
        <DialogTitle>Shortcuts and gestures</DialogTitle>
        <DialogDescription>The same actions three ways: a key, a swipe on a phone, or ⌘K. Every swipe can also have a key, so nothing is gesture-only. Change any key below.</DialogDescription>
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
      {AREAS.map(({ area, heading }) => (
        <section key={area} aria-label={heading} className="flex flex-col gap-1">
          <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{heading}</h3>
          <ul className="flex flex-col">
            {KEY_COMMANDS.filter((c) => c.area === area).map((c) => (
              <KeyRow
                key={c.id}
                does={c.does}
                current={keys?.[c.id] ?? ""}
                disabled={!keys}
                capturing={capturing === c.id}
                onCapture={(on) => setCapturing(on ? c.id : null)}
                onKey={(k) => assign(c.id, k)}
              />
            ))}
            {FIXED_KEYS.filter((f) => f.area === area || (area === "mail" && f.area === "everywhere")).map((f) => (
              <li key={f.does} className="flex min-h-10 items-center gap-3 py-0.5 text-sm">
                <span className="flex-1">{f.does}</span>
                <span className="flex min-w-20 justify-center gap-1" title="These keys don't change">
                  {f.keys.map((k) => (
                    <Kbd key={k}>{k}</Kbd>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">Keys follow you to every browser and device signed in to your account.</p>
        <Button variant="outline" size="sm" disabled={!changed || saveKeys.isPending} onClick={() => store({}, "Keys reset to the defaults")}>
          Reset keys
        </Button>
      </div>
    </div>
  )
}

/**
 * One command. The key is the button: press it, then press the new key.
 * Removing a key is offered while choosing, so rows stay one control wide.
 */
function KeyRow(props: { does: string; current: string; disabled: boolean; capturing: boolean; onCapture: (on: boolean) => void; onKey: (key: string) => void }) {
  const { does, current, disabled, capturing, onCapture, onKey } = props
  const [problem, setProblem] = useState<string | null>(null)

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!capturing || MODIFIERS.has(e.key)) return
    if (e.key === "Tab") return onCapture(false)
    e.preventDefault()
    e.stopPropagation()
    if (e.key === "Escape") return onCapture(false)
    if (e.metaKey || e.ctrlKey || e.altKey) return setProblem("Single keys only (Shift is fine)")
    const why = keyProblem(e.key)
    if (why) return setProblem(why)
    onCapture(false)
    if (e.key !== current) onKey(e.key)
  }

  return (
    <li className="flex min-h-10 flex-wrap items-center gap-x-3 py-0.5 text-sm">
      <span className="min-w-0 flex-1">{does}</span>
      {/* One button for both states, so focus stays put after a key is chosen. */}
      <Button
        size="sm"
        variant={capturing ? "secondary" : "outline"}
        className="min-w-20"
        aria-label={capturing ? `Press a key for ${does}` : `Change the key for ${does}`}
        disabled={disabled}
        onKeyDown={onKeyDown}
        onBlur={() => capturing && onCapture(false)}
        onClick={() => (setProblem(null), onCapture(!capturing))}
      >
        {capturing ? "Press a key…" : current ? <Kbd>{keyLabel(current)}</Kbd> : <span className="text-muted-foreground">Add key</span>}
      </Button>
      {capturing && (
        <p className="flex basis-full items-center justify-end gap-2 pb-1 text-xs text-muted-foreground">
          <span role="status">{problem ?? "Press the new key. Esc cancels."}</span>
          {current && (
            // mousedown would blur the capture button and end the capture first.
            <Button size="xs" variant="link" className="h-auto p-0" aria-label={`Remove the key for ${does}`} onMouseDown={(e) => e.preventDefault()} onClick={() => (onCapture(false), onKey(""))}>
              Remove key
            </Button>
          )}
        </p>
      )}
    </li>
  )
}
