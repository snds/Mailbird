import type { ReactNode } from "react"

import { FormStrip } from "@/app/status"
import { Button, Dialog, DialogContent, DialogTitle, Sheet, SheetContent, SheetTitle, useAppFrame } from "@unicron/ui"

/** The field marked `data-editor-focus` gets focus once the frame is open. */
const firstField = () => document.querySelector<HTMLElement>("[data-editor-focus]") ?? true

/**
 * A full-screen sheet in the phone's shells (compact width, or a short
 * screen) and a dialog from medium width up, like the composer: editors are
 * tasks, so they take over the small screen. The frame's width class decides
 * (ADR-0083).
 */
export function EditorFrame({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const tabletUp = !useAppFrame().phone
  if (tabletUp) {
    return (
      <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
        <DialogContent size="lg" className="flex max-h-[min(46rem,calc(100dvh-2rem))] flex-col gap-0 [--c-dialog-padding:0]" showCloseButton={false} initialFocus={firstField}>
          <DialogTitle className="sr-only">{title}</DialogTitle>
          {children}
        </DialogContent>
      </Dialog>
    )
  }
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="bottom" fullscreen showCloseButton={false} initialFocus={firstField}>
        <SheetTitle className="sr-only">{title}</SheetTitle>
        {children}
        {/* A send in its undo window shows on every phone screen, a full-screen form too (ADR-0086). */}
        <FormStrip />
      </SheetContent>
    </Sheet>
  )
}

/** Cancel · title · primary action, the composer's header grammar. */
export function EditorHeader({ title, onCancel, action }: { title: string; onCancel: () => void; action: ReactNode }) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b px-2">
      <Button type="button" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
      <h2 className="flex-1 truncate text-center text-sm font-semibold">{title}</h2>
      {action}
    </header>
  )
}
