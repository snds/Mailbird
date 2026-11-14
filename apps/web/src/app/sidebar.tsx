import { useState } from "react"

import { AppFrameSidebar, AppLockup, NavItem, NavSection } from "@unicron/ui"
import { useKeyBindings } from "@/core/queries"

import { SectionGroups } from "./section-groups"
import { useUpdateMark } from "./update-mark"
import { VERTICALS, type Vertical, type VerticalId } from "./verticals"

/** The sidebar by choice: full, or its rail (ADR-0073, kept per device). At medium width it is always the rail. */
const SIDEBAR_KEY = "vale.nav.expanded"
function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === "0"
    } catch {
      // Storage can be off: the sidebar starts full.
      return false
    }
  })
  const set = (next: boolean) => {
    try {
      localStorage.setItem(SIDEBAR_KEY, next ? "0" : "1")
    } catch {
      // Not remembered this time; it still collapses.
    }
    setCollapsed(next)
  }
  return [collapsed, set] as const
}

interface SidebarProps {
  /** The sections this person has: all four, or Mail alone for a team member. */
  sections: Vertical[]
  /** The open section. Its create action stays on the button on Search and Settings. */
  active: Vertical
  /** Which item is current: a section, Settings, or none (a place of the section's own group). */
  current: VerticalId | "settings" | null
  onNavigate: (id: VerticalId) => void
  onSettings: () => void
  onSearch: () => void
  onCreate: () => void
  /** Quick create is open: the create button shows close. */
  quickOpen: boolean
  onQuickCreate: () => void
}

/**
 * The desktop's navigation column (ADR-0083; brief 3.3), 204 wide: the
 * lockup, the open section's create button, Search, APPS, the section's own
 * groups, and Settings pinned at the foot beside the collapse control. At
 * medium width, or collapsed by choice (⌘\), the frame draws it as its rail.
 */
export function Sidebar({ sections, active, current, onNavigate, onSettings, onSearch, onCreate, quickOpen, onQuickCreate }: SidebarProps) {
  const [collapsed, setCollapsed] = useSidebarCollapsed()
  const mark = useUpdateMark()
  const { data: keys } = useKeyBindings()
  return (
    <AppFrameSidebar
      label="Vale"
      lockup={<AppLockup name="Vale" />}
      action={{
        label: quickOpen ? "Close" : active.create.label,
        icon: quickOpen ? "close" : active.create.icon,
        onClick: quickOpen ? undefined : onCreate,
        onLongPress: onQuickCreate,
        longPressLabel: "Quick create",
      }}
      footer={<NavItem label="Settings" icon="settings" current={current === "settings"} mark={mark} onClick={onSettings} />}
      collapsed={collapsed}
      onCollapsedChange={setCollapsed}
    >
      <NavItem label="Search" icon="search" mark={{ keys: keys?.["mail.search"] ?? "/" }} onClick={onSearch} />
      {/* A team member has Mail only, so there is nothing to list (brief X10). No counts: the core has none. */}
      {sections.length > 1 && (
        <NavSection title="Apps" count={VERTICALS.length}>
          {sections.map((v) => (
            <NavItem key={v.id} label={v.label} icon={v.icon} current={current === v.id} onClick={() => onNavigate(v.id)} />
          ))}
        </NavSection>
      )}
      <SectionGroups section={active.id} />
    </AppFrameSidebar>
  )
}
