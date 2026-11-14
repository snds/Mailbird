import { createContext, useCallback, useContext, useId, useMemo, useState, type ComponentProps, type FormEvent, type KeyboardEvent, type ReactNode, type Ref } from "react"

import { FormStrip } from "@/app/status"
import { Banner, Button, ConfirmDialog, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogOverline, DialogTitle, FloatButton, Sheet, SheetBody, SheetContent, TopBar, useAppFrame, type IconName } from "@unicron/ui"
import { LayerGuardContext, answerLeave, createLayerGuard, useLeaveQuestion } from "@/lib/leave-guard"

/**
 * The form layer (ADR-0087; brief 3.2): where a form opens, the same in
 * every section.
 *
 * - **Desktop and medium width:** a dialog sized by name (form 640, compose
 *   720). Header: an overline, the item's name as typed, the close button.
 *   Footer: Cancel, then the one primary.
 * - **The phone's shells:** the whole screen. Top row: close, the title, the
 *   one primary as a float button.
 *
 * ⌘ or Ctrl + Enter runs the primary. Esc, the close button and Cancel
 * close it, and ask first when the form holds writing (`useLeaveGuard`).
 * A press outside never closes a form.
 *
 * `FormLayer` is the layer; the form inside it draws its header, fields and
 * actions with `FormLayerForm`, which knows the form's state.
 */

/** The field marked `data-form-focus` (or the composer's body) gets focus once the layer is open. */
const firstField = () => document.querySelector<HTMLElement>("[data-form-focus], [data-composer-focus]") ?? true

interface Layer {
  phone: boolean
  /** Close, asking first when the form holds writing. */
  close: () => void
  overlineId: string
  titleId: string
}
const LayerContext = createContext<Layer | null>(null)

type FinalFocus = ComponentProps<typeof DialogContent>["finalFocus"]

export function FormLayer({
  open,
  onClose,
  size = "form",
  finalFocus,
  children,
}: {
  open: boolean
  /** Closes it for good: run after a save, and after DISCARD. */
  onClose: () => void
  /** The dialog's width by name: `form` (640), or `compose` (720) for writing at length. */
  size?: "form" | "compose"
  finalFocus?: FinalFocus
  children: ReactNode
}) {
  const phone = useAppFrame().phone
  const [guard] = useState(createLayerGuard)
  const [asking, setAsking] = useState(false)
  const id = useId()
  const close = useCallback(() => {
    // While the question stands, Esc is the question's: it keeps editing, and is not a second request to close.
    if (asking) return
    if (guard.dirty()) setAsking(true)
    else onClose()
  }, [asking, guard, onClose])
  const layer = useMemo<Layer>(() => ({ phone, close, overlineId: `${id}-overline`, titleId: `${id}-title` }), [phone, close, id])
  // Named by what it is and what it is called: "New message, Saturday ferry". While the item has no name the
  // title says what it is, and the form leaves the overline's id out, so the name is not said twice.
  const labelledBy = `${layer.overlineId} ${layer.titleId}`
  const onOpenChange = (next: boolean) => {
    if (!next) close()
  }
  const inside = (
    <LayerGuardContext value={guard}>
      <LayerContext value={layer}>{children}</LayerContext>
    </LayerGuardContext>
  )
  // Beside the layer, not inside it: a layer of its own, so it dims the form behind it.
  const question = (
    <DiscardQuestion
      open={asking}
      onKeep={() => setAsking(false)}
      onDiscard={() => {
        setAsking(false)
        onClose()
      }}
    />
  )
  if (phone) {
    return (
      <>
        <Sheet open={open} onOpenChange={onOpenChange} closeOnOutsideClick={false}>
        <SheetContent
          side="bottom"
          height="full"
          showCloseButton={false}
          initialFocus={firstField}
          finalFocus={finalFocus}
          aria-labelledby={labelledBy}
          // Above the keyboard on iOS too, which covers the page instead of resizing it.
          className="data-[side=bottom]:bottom-(--keyboard-inset)"
        >
          {inside}
          {/* A send in its undo window shows on every phone screen, a full-screen form too (ADR-0086). */}
          <FormStrip />
        </SheetContent>
        </Sheet>
        {question}
      </>
    )
  }
  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange} closeOnOutsideClick={false}>
        <DialogContent size={size} initialFocus={firstField} finalFocus={finalFocus} aria-labelledby={labelledBy}>
          {inside}
        </DialogContent>
      </Dialog>
      {question}
    </>
  )
}

/** The form's one primary: its word, and its glyph on a phone. */
export interface FormPrimary {
  /** "Save", "Send", "Create split". The button's word on a desktop, its name on a phone. */
  label: string
  /** The phone's float button glyph: `checkmark` unless the form has its own (`send--alt` for mail). */
  icon?: IconName
  disabled?: boolean
  /** The save is running: the button keeps its word and shows it. */
  loading?: boolean
}

type FormProps = Omit<ComponentProps<"form">, "onSubmit" | "title" | "children" | "className" | "ref">

export function FormLayerForm({
  ref,
  overline,
  title,
  primary,
  primaryControl,
  footerStart,
  error,
  onSubmit,
  children,
  onKeyDown,
  ...form
}: FormProps & {
  ref?: Ref<HTMLFormElement>
  /** What the form is: "New event", "Edit split". Typed in sentence case; the role sets the capitals. */
  overline: string
  /** The item's name as typed; the overline's words while it has none. */
  title: string
  primary: FormPrimary
  /** A desktop primary of its own (the composer's Send with Send later). It must submit the form. */
  primaryControl?: ReactNode
  /** What else the form can do: the left of the footer on a desktop, a row at the foot on a phone (a text button "Delete", the composer's tools). */
  footerStart?: ReactNode
  /** A failed save, in the server's words: a compact critical banner above the actions. The form stays open. */
  error?: string | null
  onSubmit: () => void
  children: ReactNode
}) {
  const layer = useContext(LayerContext)
  if (!layer) throw new Error("FormLayerForm must be inside a FormLayer.")
  const { phone, close, titleId } = layer
  const overlineId = title.trim().toLowerCase() === overline.trim().toLowerCase() ? undefined : layer.overlineId
  const run = () => {
    if (!primary.disabled && !primary.loading) onSubmit()
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    run()
  }
  const keys = (e: KeyboardEvent<HTMLFormElement>) => {
    onKeyDown?.(e)
    // React's events cross portals: a key in a menu or a question the form opened is not the form's.
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && e.currentTarget.contains(e.target as Node)) {
      e.preventDefault()
      run()
    }
  }
  const failed = error ? <Banner size="compact" tone="critical" body={error} /> : null

  if (phone) {
    return (
      <form ref={ref} className="flex min-h-0 flex-1 flex-col gap-2" onSubmit={submit} onKeyDown={keys} {...form}>
        <div className="shrink-0 px-4">
          <TopBar
            titleAs="h2"
            title={<span id={titleId}>{title}</span>}
            start={<FloatButton type="button" label="Close" icon="close" size="l" tooltip={false} onClick={close} />}
            actions={<FloatButton type="submit" kind="primary" size="l" label={primary.label} icon={primary.icon ?? "checkmark"} disabled={primary.disabled || primary.loading} aria-keyshortcuts="Control+Enter Meta+Enter" />}
          />
          <span id={overlineId} hidden>
            {overline}
          </span>
        </div>
        <SheetBody>
          {children}
          {failed}
        </SheetBody>
        {footerStart && <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 pb-2">{footerStart}</div>}
      </form>
    )
  }
  return (
    <form ref={ref} className="contents" onSubmit={submit} onKeyDown={keys} {...form}>
      <DialogHeader>
        <DialogOverline id={overlineId}>{overline}</DialogOverline>
        <DialogTitle id={titleId}>{title}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        {/* The pinned footer takes the gap above it: this keeps the last field clear of its rule. */}
        <div className="flex min-w-0 flex-col gap-4 pb-4">
          {children}
          {failed}
        </div>
      </DialogBody>
      <DialogFooter sticky>
        {footerStart && <div className="mr-auto flex min-w-0 flex-wrap items-center gap-2">{footerStart}</div>}
        <Button type="button" variant="secondary" onClick={close}>
          Cancel
        </Button>
        {primaryControl ?? (
          <Button type="submit" disabled={primary.disabled} loading={primary.loading} aria-keyshortcuts="Control+Enter Meta+Enter">
            {primary.label}
          </Button>
        )}
      </DialogFooter>
    </form>
  )
}

/** "Discard changes?" (brief X6): KEEP EDITING is the no and takes focus. */
function DiscardQuestion({ open, onKeep, onDiscard }: { open: boolean; onKeep: () => void; onDiscard: () => void }) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onKeep()
      }}
      title="Discard changes?"
      confirmLabel="Discard"
      cancelLabel="Keep editing"
      tone="destructive"
      onConfirm={onDiscard}
    />
  )
}

/**
 * The same question for a form in the pane (a contact edited in the detail
 * column): mounted once at the root, it asks whenever a move away waits in
 * `lib/leave-guard`.
 */
export function LeaveQuestion() {
  const pending = useLeaveQuestion((s) => s.pending !== null)
  return <DiscardQuestion open={pending} onKeep={() => answerLeave(false)} onDiscard={() => answerLeave(true)} />
}
