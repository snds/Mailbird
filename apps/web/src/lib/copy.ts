import { createElement, useCallback, useEffect, useRef, useState } from "react"
import { toast, toastDurations } from "@unicron/ui"

/**
 * Copying, built once (ADR-0086; brief 4.0, cross-app decisions §1):
 *
 * - A COPY control shows "Copied" in its own place for 2 s and raises no
 *   toast: `useCopy`.
 * - A copy from a menu or a key raises the toast "Copied {what}": `copyText`.
 * - When the browser blocks the clipboard, either way, a toast shows the
 *   label and the value, selectable, for 6 s, so it can be copied by hand.
 */

/** How long a COPY control says "Copied". */
export const COPIED_MS = 2000

export interface CopyWhat {
  /** What it is, for the toast after a menu or a key: "link" gives "Copied link". */
  what: string
  /** The value's label when it has to be shown: "Booking link". Default: `what`, capitalized. */
  label?: string
}

const capitalized = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

async function write(value: string) {
  try {
    if (!navigator.clipboard) return false
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    return false
  }
}

/** The clipboard said no: the value itself, to select and copy by hand. */
function showValue(value: string, { what, label }: CopyWhat) {
  toast(label ?? capitalized(what), {
    description: createElement("span", { className: "break-all select-all", "data-role": "copy-value" }, value),
    duration: toastDurations.action,
  })
}

/** A copy from a menu or a key. Says "Copied {what}" in a toast; shows the value when the clipboard is blocked. */
export async function copyText(value: string, about: CopyWhat) {
  const ok = await write(value)
  if (ok) toast(`Copied ${about.what}`)
  else showValue(value, about)
  return ok
}

/**
 * A COPY control. `copy(value)` copies; `copied` is true for 2 s afterwards,
 * so the control can show "Copied" in place of its word. It raises no toast,
 * unless the clipboard is blocked: then the value shows in one.
 */
export function useCopy(about: CopyWhat) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const latest = useRef(about)
  useEffect(() => {
    latest.current = about
  })
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = useCallback(async (value: string) => {
    const ok = await write(value)
    if (!ok) {
      showValue(value, latest.current)
      return false
    }
    setCopied(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), COPIED_MS)
    return true
  }, [])
  return { copied, copy }
}
