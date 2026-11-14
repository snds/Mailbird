import { useEffect } from "react"

import { useUi } from "@/app/ui-store"
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Kbd } from "@unicron/ui"
import { useKeyBindings } from "@/core/queries"
import { FIXED_KEYS, KEY_COMMANDS, type KeyArea, keyLabel, listedUnder } from "@/lib/keys"

const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+"

const GROUPS: { area: KeyArea | "everywhere"; heading: string }[] = [
  { area: "everywhere", heading: "Everywhere" },
  { area: "mail", heading: "Mail" },
  { area: "calendar", heading: "Calendar" },
]

/**
 * Every key, read-only (ADR-0075): ⌘K, ⌥N and ? everywhere, then each
 * area's keys as you've set them. `?` opens it from anywhere outside a text
 * field; changing a key is in Settings → Shortcuts and gestures.
 */
export function KeyboardShortcuts() {
  const open = useUi((s) => s.shortcutsOpen)
  const setOpen = useUi((s) => s.setShortcutsOpen)
  const { data: keys } = useKeyBindings()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "?" || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return
      const t = e.target as HTMLElement
      if (t.closest("input, textarea, select, [contenteditable=true], [role=dialog]")) return
      e.preventDefault()
      useUi.getState().setShortcutsOpen(true)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const rows = (area: KeyArea | "everywhere") => [
    ...FIXED_KEYS.filter((f) => f.area === area).map((f) => ({ does: f.does, keys: f.keys.map((k) => k.replace("⌘", MOD)) })),
    ...KEY_COMMANDS.filter((c) => listedUnder(c) === area && keys?.[c.id]).map((c) => ({ does: c.does, keys: [keyLabel(keys![c.id]!)] })),
  ]

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Keys work when you're not typing in a field.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-6 sm:grid-cols-2">
          {GROUPS.map(({ area, heading }) => (
            <section key={area} aria-label={heading} className={area === "everywhere" ? "sm:col-span-2" : undefined}>
              <h3 className="type-overline mb-1">{heading}</h3>
              <dl className="flex flex-col">
                {rows(area).map((r) => (
                  <div key={r.does} className="flex min-h-9 items-center justify-between gap-3 border-b text-sm last:border-b-0">
                    <dt>{r.does}</dt>
                    <dd className="flex gap-1">
                      {r.keys.map((k) => (
                        <Kbd key={k}>{k}</Kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => (setOpen(false), useUi.getState().openSettings("shortcuts"))}>
            Change keys and swipes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
