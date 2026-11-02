import { useState, type ComponentProps, type ReactElement, type ReactNode } from "react"

import { Icon, Button, Tooltip, TooltipContent, TooltipTrigger } from "@unicron/ui"
import { cn } from "@/lib/utils"

import { DemoBar } from "./demo-bar"

import { DEMO_APP, isMember } from "@/core/client"

import { VERTICALS, type Vertical, type VerticalId } from "./verticals"

/** A team member on a gateway works the mail; the rest is the owner's (ADR-0063). */
const shown = () => (isMember() ? VERTICALS.filter((v) => v.id === "mail") : VERTICALS)

interface ShellProps {
  active: VerticalId
  onNavigate: (id: VerticalId) => void
  onCreate: () => void
  onSettings: () => void
  /** Settings is open in place of the area (ADR-0075). */
  settingsOpen: boolean
  children: ReactNode
}

/** The rail's open state: labels beside the icons, or a column of icons. Kept per device. */
const RAIL_KEY = "vale.nav.expanded"
function useRailExpanded() {
  const [expanded, setExpanded] = useState(() => {
    try {
      const saved = localStorage.getItem(RAIL_KEY)
      if (saved !== null) return saved === "1"
    } catch {
      // Storage can be off; fall back to the window's width.
    }
    return window.matchMedia("(min-width: 64rem)").matches
  })
  const toggle = () =>
    setExpanded((was) => {
      try {
        localStorage.setItem(RAIL_KEY, was ? "0" : "1")
      } catch {
        // Not remembered this time; the rail still toggles.
      }
      return !was
    })
  return [expanded, toggle] as const
}

/**
 * Adaptive frame. One component tree, three postures:
 *   phone   (< md)  bottom tab bar + single stacked pane
 *   tablet  (md)    nav rail + list/detail split
 *   desktop (lg+)   nav rail + wider list + reading pane
 * The rail opens to labels beside its icons, or closes to a column of icons
 * (ADR-0073). "New" is a floating button at the content's bottom right that
 * makes whatever the open area makes. Settings opens as a page in place of
 * the open area (ADR-0075).
 */
export function AppShell({ active, onNavigate, onCreate, onSettings, settingsOpen, children }: ShellProps) {
  const current = VERTICALS.find((v) => v.id === active)!
  const [expanded, toggleRail] = useRailExpanded()
  return (
    <div className="flex h-dvh overflow-hidden bg-surface-canvas">
      <NavRail active={settingsOpen ? null : active} onNavigate={onNavigate} onSettings={onSettings} settingsOpen={settingsOpen} expanded={expanded} onToggle={toggleRail} />
      <main className="relative flex min-w-0 flex-1 flex-col pb-[calc(var(--c-shell-tabbar-height)+env(safe-area-inset-bottom))] md:pb-0">
        {DEMO_APP && <DemoBar />}
        {children}
        {!settingsOpen && <Fab vertical={current} onClick={onCreate} />}
      </main>
      <TabBar active={settingsOpen ? null : active} onNavigate={onNavigate} />
    </div>
  )
}

/** A rail row: a tooltip names it only while the rail shows icons alone. */
function RailTip({ label, expanded, children }: { label: ReactNode; expanded: boolean; children: ReactElement }) {
  if (expanded) return children
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  )
}

function NavItem({
  vertical,
  active,
  onClick,
  orientation,
  expanded = false,
  ...props
}: {
  vertical: Vertical
  active: boolean
  onClick: () => void
  orientation: "rail" | "tab"
  expanded?: boolean
} & ComponentProps<"button">) {
  const rail = orientation === "rail"
  return (
    <button
      type="button"
      {...props}
      onClick={onClick}
      data-active={active}
      aria-current={active ? "page" : undefined}
      aria-label={rail && !expanded ? vertical.label : undefined}
      className={cn(
        "group/nav flex text-xs font-medium text-muted-foreground outline-none transition-colors",
        "focus-visible:ring-3 focus-visible:ring-ring/50 rounded-full",
        // Tier-3 tokens drive the icon axes; @property makes them animate.
        "[--c-icon-fill:var(--c-nav-icon-fill-rest)] [--c-icon-wght:var(--c-nav-icon-wght-rest)]",
        "data-[active=true]:text-foreground data-[active=true]:[--c-icon-fill:var(--c-nav-icon-fill-active)] data-[active=true]:[--c-icon-wght:var(--c-nav-icon-wght-active)]",
        rail
          ? cn(
              "h-12 flex-none items-center gap-3 text-sm hover:bg-accent/60 data-[active=true]:bg-accent",
              expanded ? "w-full px-4" : "w-12 justify-center"
            )
          : "h-full flex-1 flex-col items-center justify-center gap-1 rounded-xl"
      )}
    >
      <span
        className={cn(
          "flex items-center justify-center",
          !rail && "h-8 w-14 rounded-full transition-colors group-hover/nav:bg-accent/60 group-data-[active=true]/nav:bg-accent"
        )}
      >
        <Icon name={vertical.icon} className={cn("size-6", active && vertical.accent)} opticalSize={24} />
      </span>
      {(!rail || expanded) && <span className="truncate">{vertical.label}</span>}
    </button>
  )
}

function NavRail({
  active,
  onNavigate,
  onSettings,
  settingsOpen,
  expanded,
  onToggle,
}: {
  /** The open area, or null while settings is open. */
  active: VerticalId | null
  onNavigate: (id: VerticalId) => void
  onSettings: () => void
  settingsOpen: boolean
  expanded: boolean
  onToggle: () => void
}) {
  const row = cn("h-12 justify-start gap-3 rounded-full text-sm font-medium text-muted-foreground [&_svg]:size-6!", expanded ? "w-full px-4" : "w-12 justify-center px-0")
  return (
    <nav
      aria-label="Apps"
      data-expanded={expanded}
      className={cn(
        "hidden shrink-0 flex-col gap-1 border-r bg-surface-chrome px-3 py-3 transition-[width] duration-(--g-duration-base) ease-(--g-ease-standard) md:flex",
        expanded ? "w-(--c-shell-rail-width-expanded)" : "w-(--c-shell-rail-width) items-center"
      )}
    >
      <RailTip label="Show labels" expanded={expanded}>
        <Button
          variant="ghost"
          className={cn(row, "mb-2")}
          aria-label={expanded ? "Hide labels" : "Show labels"}
          aria-expanded={expanded}
          onClick={onToggle}
        >
          <Icon name={expanded ? "left_panel_close" : "left_panel_open"} opticalSize={24} />
        </Button>
      </RailTip>
      {shown().map((v) => (
        <RailTip key={v.id} label={v.label} expanded={expanded}>
          <NavItem vertical={v} active={v.id === active} onClick={() => onNavigate(v.id)} orientation="rail" expanded={expanded} />
        </RailTip>
      ))}
      <div className="mt-auto flex flex-col gap-1">
        <RailTip label="Accounts and settings" expanded={expanded}>
          <Button
            variant="ghost"
            className={cn(row, "data-[active=true]:bg-accent data-[active=true]:text-foreground")}
            aria-label="Accounts and settings"
            data-active={settingsOpen}
            aria-current={settingsOpen ? "page" : undefined}
            onClick={onSettings}
          >
            <Icon name="settings" opticalSize={24} />
            {expanded && "Settings"}
          </Button>
        </RailTip>
      </div>
    </nav>
  )
}

function TabBar({ active, onNavigate }: { active: VerticalId | null; onNavigate: (id: VerticalId) => void }) {
  return (
    <nav
      aria-label="Apps"
      className="fixed inset-x-0 bottom-0 z-20 flex h-[calc(var(--c-shell-tabbar-height)+env(safe-area-inset-bottom))] border-t bg-surface-chrome/95 px-2 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
    >
      {shown().map((v) => (
        <NavItem key={v.id} vertical={v} active={v.id === active} onClick={() => onNavigate(v.id)} orientation="tab" />
      ))}
    </nav>
  )
}

/**
 * The open area's "new" action, floating at the content's bottom right: in
 * the thumb zone above the tab bar on a phone, and with its label beside the
 * icon from a tablet up, so it says what it makes.
 */
function Fab({ vertical, onClick }: { vertical: Vertical; onClick: () => void }) {
  return (
    <Button
      onClick={onClick}
      aria-label={vertical.create.label}
      className={cn(
        "z-20 size-14 rounded-2xl shadow-lg [&_svg]:size-6!",
        "fixed right-4 bottom-[calc(var(--c-shell-tabbar-height)+env(safe-area-inset-bottom)+1rem)]",
        "md:absolute md:right-6 md:bottom-6 md:size-auto md:h-14 md:gap-3 md:px-5 md:text-base"
      )}
    >
      <Icon name={vertical.create.icon} opticalSize={24} />
      <span className="hidden md:inline">{vertical.create.label}</span>
    </Button>
  )
}
