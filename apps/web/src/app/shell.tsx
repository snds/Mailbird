import { useEffect, useState, type ReactNode } from "react"

import { AppFrame, AppFrameMain, Toaster, useAppFrame } from "@unicron/ui"
import { isMember } from "@/core/client"

import { DemoBar } from "./demo-bar"
import { PhoneBottomRow, PhoneTopRow } from "./phone-chrome"
import { stepBack, watchPlaces } from "./places"
import { QuickCreateMenu, type CreateHandlers } from "./quick-create"
import { returnToRoot } from "./screen"
import { Sidebar } from "./sidebar"
import { StatusLine } from "./status-line"
import { VERTICALS, vertical, type VerticalId } from "./verticals"

interface ShellProps {
  /** The open section. Under Settings it is still the last one, so create keeps its label. */
  active: VerticalId
  onNavigate: (id: VerticalId) => void
  /** Makes the open section's item, where you are. */
  onCreate: () => void
  /** Each kind's create flow from anywhere, for quick create: it opens the section, then the form. */
  handlers: CreateHandlers
  /** Settings is open in place of the section (ADR-0075); on a phone it is a pushed screen. */
  settingsOpen: boolean
  /** Search is open in place of the section (ADR-0085): its item is the current one, and no section is. */
  searchOpen: boolean
  onSearch: () => void
  onLeaveSearch: () => void
  onSettings: () => void
  onCloseSettings: () => void
  children: ReactNode
}

/**
 * Vale's shell, as one tree of unicron's frame parts (ADR-0083). The frame
 * picks the shell from the window's width, so nothing here is a media query:
 *
 *   compact  (under 600)   the phone's floating rows: lockup and Settings on
 *                          top; Search, the tab bar and create at the foot
 *   medium   (600 to 1023) the sidebar as its rail, one content column, a
 *                          pushed detail with its way back in the status line
 *   expanded (1024 up)     the sidebar, the status line, list beside detail
 *
 * A short screen (a phone on its side) stands the bottom row as a column at
 * the trailing edge; that is the frame's rule too. Settings opens in place of
 * the section, and so does Search (ADR-0085).
 */
export function AppShell({ active, onNavigate, onCreate, handlers, settingsOpen, searchOpen, onSearch, onLeaveSearch, onSettings, onCloseSettings, children }: ShellProps) {
  const section = vertical(active)
  // A team member on a gateway works the mail; the rest is the owner's (ADR-0063).
  const sections = isMember() ? VERTICALS.filter((v) => v.id === "mail") : VERTICALS
  const [quickOpen, setQuickOpen] = useState(false)

  // A change of place is a history entry, so the browser's and the phone's Back go back one place (ADR-0084).
  useEffect(() => watchPlaces(), [])
  // Leaving Settings by its own Back is the same step when Settings was opened from here.
  const leaveSettings = () => stepBack((behind) => behind.settings === null, onCloseSettings)

  // ⌘, opens Settings, as it does in every app (cross-app decisions §6). ⌘\ is the sidebar's own.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "," || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
      e.preventDefault()
      onSettings()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onSettings])

  return (
    <AppFrame>
      <Sidebar
        sections={sections}
        active={section}
        current={settingsOpen ? "settings" : searchOpen ? "search" : active}
        onNavigate={onNavigate}
        onSettings={onSettings}
        onSearch={onSearch}
        onCreate={onCreate}
        quickOpen={quickOpen}
        onQuickCreate={() => setQuickOpen(true)}
      />
      <TopLine section={settingsOpen ? "Settings" : searchOpen ? "Search" : section.label} onSection={settingsOpen ? onSettings : searchOpen ? onSearch : returnToRoot} />
      <PhoneTopRow settingsOpen={settingsOpen} searchOpen={searchOpen} onSettings={onSettings} onCloseSettings={leaveSettings} onLeaveSearch={onLeaveSearch} />
      <AppFrameMain>{children}</AppFrameMain>
      <PhoneBottomRow sections={sections} active={section} onNavigate={onNavigate} settingsOpen={settingsOpen} searchOpen={searchOpen} onSearch={onSearch} onCreate={onCreate} handlers={handlers} />
      <QuickCreateMenu open={quickOpen} onOpenChange={setQuickOpen} handlers={handlers} />
      {/* Inside the frame, so a toast stands where the frame says: the content's bottom left, or the phone's strip slot. */}
      <Toaster />
    </AppFrame>
  )
}

/** The desktop's header cell: the demo's notice, pinned above the status line (brief X10), then the line itself. */
function TopLine({ section, onSection }: { section: string; onSection: () => void }) {
  const frame = useAppFrame()
  if (frame.phone) return null
  return (
    <div className="min-w-0 [grid-area:header]">
      <DemoBar in="frame" />
      <StatusLine section={section} onSection={onSection} />
    </div>
  )
}
