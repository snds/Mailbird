import { useLayoutEffect, useRef, useState, type CSSProperties, type TouchEvent } from "react"

import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger, FloatButton, Icon, useAppFrame } from "@unicron/ui"
import { isMember } from "@/core/client"

import { useUi } from "./ui-store"
import { VERTICALS, type Vertical, type VerticalId } from "./verticals"

/** Each kind's create flow, as the command menu runs it: it opens the section, then its form. */
export type CreateHandlers = Record<VerticalId, () => void>

/** How far a finger moves up on the create button before quick create opens. */
const SWIPE_UP = 24

/**
 * The rows of quick create (States / 03, brief X10): one per kind this person
 * can make, then Quick note, named for what is open. A team member has mail
 * only, and notes are the owner's, so they get neither Quick note nor the
 * other three kinds.
 */
function QuickCreateRows({ handlers }: { handlers: CreateHandlers }) {
  const member = isMember()
  const about = useUi((s) => s.quickContext?.label)
  const openQuickNote = useUi((s) => s.openQuickNote)
  const frame = useAppFrame()
  return (
    <DropdownMenuGroup>
      {/* The way in differs by device: a long press on touch, a right-click with a pointer. */}
      <DropdownMenuLabel>{frame.phone ? "Create // long press" : "Create // right-click"}</DropdownMenuLabel>
      {VERTICALS.filter((v) => !member || v.id === "mail").map((v) => (
        <DropdownMenuItem key={v.id} onClick={handlers[v.id]}>
          <Icon name={v.id === "mail" ? v.create.icon : v.icon} />
          {v.quick}
        </DropdownMenuItem>
      ))}
      {!member && (
        <DropdownMenuItem onClick={() => openQuickNote()}>
          <Icon name="pen" />
          {about ? `Quick note about ${about}` : "Quick note"}
        </DropdownMenuItem>
      )}
    </DropdownMenuGroup>
  )
}

/**
 * The phone's create button (ADR-0083). A tap makes the open section's item.
 * A long press or a swipe up opens quick create above it, over the menu
 * scrim; Shift+Enter, the Menu key and a right-click do the same, so it is
 * never gesture-only. While the menu is open the button shows close.
 */
export function QuickCreateButton({ section, onCreate, handlers }: { section: Vertical; onCreate: () => void; handlers: CreateHandlers }) {
  const [open, setOpen] = useState(false)
  const frame = useAppFrame()
  const from = useRef<number | null>(null)
  const swipe = {
    onTouchStart: (e: TouchEvent) => {
      from.current = e.touches[0]?.clientY ?? null
    },
    onTouchMove: (e: TouchEvent) => {
      const y = e.touches[0]?.clientY
      if (from.current === null || y === undefined || from.current - y < SWIPE_UP) return
      from.current = null
      setOpen(true)
    },
    onTouchEnd: () => {
      from.current = null
    },
  }
  return (
    <DropdownMenu
      open={open}
      // A press on the button makes the section's item; only a long press, a swipe or a key opens the menu.
      onOpenChange={(next, details) => (next && details.reason === "trigger-press" ? undefined : setOpen(next))}
    >
      <DropdownMenuTrigger
        render={
          <FloatButton
            label={open ? "Close quick create" : section.create.label}
            icon={open ? "close" : section.create.icon}
            kind="primary"
            size="l"
            onClick={open ? undefined : onCreate}
            onLongPress={() => setOpen(true)}
            longPressLabel="Quick create"
            {...swipe}
          />
        }
      />
      {/* On a short screen the button stands in the trailing column, so the menu opens beside it. */}
      <DropdownMenuContent width="auto" side={frame.layout === "rail" ? "left" : "top"} align="end" sideOffset={8} scrim aria-label="Quick create">
        <QuickCreateRows handlers={handlers} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The sidebar's create button, full width or icon-only in the rail. The frame draws it, so it is found, not held. */
const sidebarCreate = () => [...document.querySelectorAll<HTMLElement>('[data-slot="app-frame-sidebar-head"] button')].findLast((el) => el.offsetParent !== null) ?? null

/**
 * Quick create on a desktop and in the rail (ADR-0083): a right-click, the
 * Menu key or Shift+F10 on the sidebar's create button opens the same menu
 * under it. The sidebar draws that button itself and a menu here needs a
 * trigger to stand by, so an unseen trigger is laid over the button while the
 * menu is open; focus goes back to the real button.
 */
export function QuickCreateMenu({ open, onOpenChange, handlers }: { open: boolean; onOpenChange: (open: boolean) => void; handlers: CreateHandlers }) {
  const [box, setBox] = useState<CSSProperties | null>(null)
  // Out of the frame's own layout at all times; over the button while the menu is open.
  const away: CSSProperties = { position: "fixed", pointerEvents: "none" }
  const button = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (!open) return
    button.current = sidebarCreate()
    const r = button.current?.getBoundingClientRect()
    // Measured off the button the frame drew, so it holds for the sidebar, the rail and the drawer.
    setBox(r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null)
  }, [open])
  return (
    <DropdownMenu open={open && box !== null} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger nativeButton={false} render={<span aria-hidden tabIndex={-1} style={{ ...away, ...box }} />} />
      <DropdownMenuContent width="auto" side="bottom" align="start" sideOffset={8} scrim aria-label="Quick create" finalFocus={button}>
        <QuickCreateRows handlers={handlers} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
