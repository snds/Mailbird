import type { ReactNode } from "react"

import { Icon, Button, Tooltip, TooltipContent, TooltipTrigger } from "@unicron/ui"
import { cn } from "@/lib/utils"

import { useUi } from "./ui-store"

import { VERTICALS, type Vertical, type VerticalId } from "./verticals"

interface ShellProps {
  active: VerticalId
  onNavigate: (id: VerticalId) => void
  onCreate: () => void
  onSettings: () => void
  children: ReactNode
}

/**
 * Adaptive frame. One component tree, three postures:
 *   phone   (< md)  bottom tab bar + single stacked pane
 *   tablet  (md)    nav rail + list/detail split
 *   desktop (lg+)   nav rail + wider list + reading pane
 */
export function AppShell({ active, onNavigate, onCreate, onSettings, children }: ShellProps) {
  const current = VERTICALS.find((v) => v.id === active)!
  return (
    <div className="flex h-dvh overflow-hidden bg-surface-canvas">
      <NavRail active={active} onNavigate={onNavigate} onCreate={onCreate} onSettings={onSettings} current={current} />
      <main className="flex min-w-0 flex-1 flex-col pb-[calc(var(--c-shell-tabbar-height)+env(safe-area-inset-bottom))] md:pb-0">
        {children}
      </main>
      <Fab vertical={current} onClick={onCreate} />
      <TabBar active={active} onNavigate={onNavigate} />
    </div>
  )
}

function NavItem({
  vertical,
  active,
  onClick,
  orientation,
}: {
  vertical: Vertical
  active: boolean
  onClick: () => void
  orientation: "rail" | "tab"
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-active={active}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group/nav flex flex-1 flex-col items-center justify-center gap-1 text-xs font-medium text-muted-foreground outline-none transition-colors",
        "focus-visible:ring-3 focus-visible:ring-ring/50 rounded-xl",
        // Tier-3 tokens drive the icon axes; @property makes them animate.
        "[--c-icon-fill:var(--c-nav-icon-fill-rest)] [--c-icon-wght:var(--c-nav-icon-wght-rest)]",
        "data-[active=true]:text-foreground data-[active=true]:[--c-icon-fill:var(--c-nav-icon-fill-active)] data-[active=true]:[--c-icon-wght:var(--c-nav-icon-wght-active)]",
        orientation === "rail" ? "w-full flex-none py-1.5" : "h-full"
      )}
    >
      <span
        className={cn(
          "flex h-8 w-14 items-center justify-center rounded-full transition-colors",
          "group-hover/nav:bg-accent/60 group-data-[active=true]/nav:bg-accent"
        )}
      >
        <Icon
          name={vertical.icon}
          className={cn("size-6", active && vertical.accent)}
          opticalSize={24}
        />
      </span>
      {vertical.label}
    </button>
  )
}

function NavRail({
  active,
  onNavigate,
  onCreate,
  onSettings,
  current,
}: {
  active: VerticalId
  onNavigate: (id: VerticalId) => void
  onCreate: () => void
  onSettings: () => void
  current: Vertical
}) {
  return (
    <nav
      aria-label="Apps"
      className="hidden w-(--c-shell-rail-width) shrink-0 flex-col items-center gap-2 border-r bg-surface-chrome py-3 md:flex"
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Button size="icon-lg" className="mb-3 size-12 rounded-2xl" onClick={onCreate} aria-label={current.create.label} />
          }
        >
          <Icon name={current.create.icon} className="size-6" opticalSize={24} />
        </TooltipTrigger>
        <TooltipContent side="right">{current.create.label}</TooltipContent>
      </Tooltip>
      {VERTICALS.map((v) => (
        <NavItem key={v.id} vertical={v} active={v.id === active} onClick={() => onNavigate(v.id)} orientation="rail" />
      ))}
      <div className="mt-auto flex flex-col items-center gap-1">
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-lg" aria-label="Command menu" onClick={() => useUi.getState().setPaletteOpen(true)} />}>
            <Icon name="keyboard_command_key" className="size-6" opticalSize={24} />
          </TooltipTrigger>
          <TooltipContent side="right">
            Command menu <kbd className="ml-1 font-mono text-[11px] opacity-70">{/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl+K"}</kbd>
          </TooltipContent>
        </Tooltip>
        <Button variant="ghost" size="icon-lg" aria-label="Accounts and settings" onClick={onSettings}>
          <Icon name="settings" className="size-6" opticalSize={24} />
        </Button>
      </div>
    </nav>
  )
}

function TabBar({ active, onNavigate }: { active: VerticalId; onNavigate: (id: VerticalId) => void }) {
  return (
    <nav
      aria-label="Apps"
      className="fixed inset-x-0 bottom-0 z-20 flex h-[calc(var(--c-shell-tabbar-height)+env(safe-area-inset-bottom))] border-t bg-surface-chrome/95 px-2 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
    >
      {VERTICALS.map((v) => (
        <NavItem key={v.id} vertical={v} active={v.id === active} onClick={() => onNavigate(v.id)} orientation="tab" />
      ))}
    </nav>
  )
}

/** Phone-only primary action, placed in the thumb zone above the tab bar. */
function Fab({ vertical, onClick }: { vertical: Vertical; onClick: () => void }) {
  return (
    <Button
      onClick={onClick}
      aria-label={vertical.create.label}
      className="fixed right-4 bottom-[calc(var(--c-shell-tabbar-height)+env(safe-area-inset-bottom)+1rem)] z-20 size-14 rounded-2xl shadow-lg md:hidden"
    >
      <Icon name={vertical.create.icon} className="size-6" opticalSize={24} />
    </Button>
  )
}
