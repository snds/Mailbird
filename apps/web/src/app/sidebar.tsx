import { AppFrameSidebar, AppLockup, NavItem, NavSection, useAppFrame } from "@unicron/ui"
import { useKeyBindings } from "@/core/queries"

import { placeIsGroupItem } from "./places"
import { SectionGroups } from "./section-groups"
import { useUi } from "./ui-store"
import { useUpdateMark } from "./update-mark"
import { VERTICALS, type Vertical, type VerticalId } from "./verticals"

interface SidebarProps {
  /** The sections this person has: all four, or Mail alone for a team member. */
  sections: Vertical[]
  /** The open section. Its create action stays on the button on Search and Settings. */
  active: Vertical
  /** Where you are: a section, or Settings. Which item says so is worked out here: one per nav list (brief 3.3). */
  current: VerticalId | "settings"
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
  // By choice (ADR-0073, kept per device); the store holds it, since the page head becomes the switcher beside a rail.
  const collapsed = useUi((s) => s.sidebarCollapsed)
  const setCollapsed = useUi((s) => s.setSidebarCollapsed)
  const frame = useAppFrame()
  // The groups are not in the rail (medium width, by choice, or when the frame asks for it): the page head opens them.
  const groups = !collapsed && frame.layout === "expanded" && !frame.sidebarRail
  const calendarPlace = useUi((s) => s.calendarPlace)
  // One current item: the place's own row in the section's group when it has one and the group shows;
  // otherwise the section under Apps. Settings marks itself alone.
  const inGroup = current !== "settings" && groups && placeIsGroupItem(current, calendarPlace)
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
            <NavItem key={v.id} label={v.label} icon={v.icon} current={current === v.id && !inGroup} onClick={() => onNavigate(v.id)} />
          ))}
        </NavSection>
      )}
      {groups && <SectionGroups section={active.id} />}
    </AppFrameSidebar>
  )
}
