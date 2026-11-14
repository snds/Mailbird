import type { ReactNode } from "react"

import { NavSection, Popover, PopoverContent, PopoverHeader, PopoverTrigger, Sheet, SheetBody, SheetContent, SheetHeader, SheetOverline, SheetTitle } from "@unicron/ui"

import { PickedContext, type SectionSwitch } from "./places"

/**
 * The page head as the way into a section's second level (ADR-0084; brief
 * X1, cross-app decisions §7). Where the sidebar shows the section's groups
 * (expanded, and not its rail), the head is a plain head. Everywhere else the
 * whole head, and the small title it collapses to, is one button: it opens
 * the same groups in a sheet on a phone, and in a popover under the head at
 * medium width or beside the rail.
 */
interface SectionSwitcherProps {
  state: SectionSwitch
  /** The section, then the filter in force: "Mail // Personal". */
  overline: string
  /** What the list holds: "Folders", "Calendars", "Groups". */
  title: string
  /** The section's nav list (`MailNav` …). */
  children: ReactNode
}

/**
 * The layer the page head opens. Render it first inside the head's `below`:
 * the popover stands under that point. Composed from unicron's sheet and
 * popover parts, as its AdaptivePopover is, because that one needs a trigger
 * element of its own and here the trigger is the page head.
 */
export function SectionSwitcher({ state, overline, title, children }: SectionSwitcherProps) {
  if (!state.switcher) return null
  const change = (open: boolean) => {
    state.setOpen(open)
    // Focus goes back to the head that opened it: the layer has no trigger of its own to return to.
    if (!open) requestAnimationFrame(() => [...document.querySelectorAll<HTMLElement>("[data-slot='page-head-switcher']")].find((el) => el.offsetParent !== null)?.focus())
  }
  const rows = <PickedContext.Provider value={() => state.setOpen(false)}>{children}</PickedContext.Provider>
  if (state.sheet) {
    return (
      <Sheet open={state.open} onOpenChange={change}>
        <SheetContent side="bottom" height="content">
          <SheetHeader>
            <SheetOverline>{overline}</SheetOverline>
            <SheetTitle>{title}</SheetTitle>
          </SheetHeader>
          <SheetBody>
            {/* A little clear of the header, so the first row's focus ring is not cut by the scroll edge. */}
            <div className="flex flex-col gap-7 pt-1">{rows}</div>
          </SheetBody>
        </SheetContent>
      </Sheet>
    )
  }
  return (
    <Popover open={state.open} onOpenChange={change}>
      {/* Only where the popover stands: out of the layout, unseen and never focused. */}
      <PopoverTrigger nativeButton={false} render={<span aria-hidden tabIndex={-1} className="pointer-events-none absolute size-0" />} />
      <PopoverContent side="bottom" align="start" aria-label={title}>
        <PopoverHeader overline={overline} title={title} />
        {/* The list scrolls inside the room the popover has under the head. */}
        <div className="-m-1 flex max-h-[calc(var(--available-height)-6rem)] flex-col gap-7 overflow-y-auto p-1">{rows}</div>
      </PopoverContent>
    </Popover>
  )
}

/**
 * A nav list's first group. In the sidebar it is a section under its
 * overline ("Mail // folders"). In the page head's layer the layer's own
 * header already names it ("Folders"), as Mobile / 05 draws it, so there the
 * rows stand alone.
 */
export function FirstGroup({ layer, title, count, children }: { layer: boolean; title: string; count?: number; children: ReactNode }) {
  if (layer) return <div className="flex flex-col gap-1">{children}</div>
  return (
    <NavSection title={title} count={count}>
      {children}
    </NavSection>
  )
}
