import { AppFrameAccessory, AppFrameBottomRow, AppFrameTopRow, AppLockup, FloatButton, TabBar, TabBarItem, TopBar, useAppFrame } from "@unicron/ui"

import { QuickCreateButton, type CreateHandlers } from "./quick-create"
import { returnToRoot, useScreen } from "./screen"
import { useUpdateMark } from "./update-mark"
import type { Vertical, VerticalId } from "./verticals"

interface PhoneChromeProps {
  sections: Vertical[]
  active: Vertical
  onNavigate: (id: VerticalId) => void
  /** Settings is the screen: a pushed one, with no bottom row. */
  settingsOpen: boolean
  onSettings: () => void
  onCloseSettings: () => void
  onSearch: () => void
  onCreate: () => void
  handlers: CreateHandlers
}

/**
 * The phone's top row (ADR-0083; Mobile / 01, States / 02). On a section's
 * first screen: the lockup, and the Settings button with the update mark.
 * Once the page has scrolled the frame shows the mark alone, the place as a
 * small centred title and a hairline. A pushed screen (an open item,
 * Settings) gets the top bar instead: back, then what its lane adds.
 */
export function PhoneTopRow({ settingsOpen, onSettings, onCloseSettings }: Pick<PhoneChromeProps, "settingsOpen" | "onSettings" | "onCloseSettings">) {
  const frame = useAppFrame()
  const mark = useUpdateMark()
  const place = useScreen((s) => s.place)
  const pushed = useScreen((s) => s.pushed)
  if (frame.detailOpen || settingsOpen) {
    return (
      <AppFrameTopRow>
        {/* An open settings section goes back to the list of sections; the list goes back to the app. */}
        <TopBar onBack={frame.back?.onBack ?? (settingsOpen ? onCloseSettings : undefined)} backLabel={frame.back?.label} actions={frame.detailOpen ? pushed?.actions : undefined} />
      </AppFrameTopRow>
    )
  }
  return (
    <AppFrameTopRow
      lockup={<AppLockup name="Vale" />}
      title={place ?? undefined}
      // The small title is the page head collapsed: where the head is the section's switcher, so is it (ADR-0084).
      switcher={frame.head?.switcher}
      actions={<FloatButton label="Settings" icon="user--avatar" size="l" mark={mark} onClick={onSettings} />}
    />
  )
}

/**
 * The phone's bottom row (ADR-0083; Mobile / 01): Search, the tab bar of
 * sections, and the open section's create button. Scrolled, the frame
 * shrinks the bar to the active tab and the place strip joins the row
 * (States / 02). A pushed item gets the detail row its lane fills; Settings
 * has no row. A team member's one section draws no tab bar (brief X10).
 */
export function PhoneBottomRow({ sections, active, onNavigate, settingsOpen, onSearch, onCreate, handlers }: Omit<PhoneChromeProps, "onSettings" | "onCloseSettings">) {
  const frame = useAppFrame()
  const strip = useScreen((s) => s.strip)
  const pushed = useScreen((s) => s.pushed)
  if (settingsOpen) return null
  if (frame.detailOpen) {
    return pushed && (pushed.start || pushed.fill || pushed.end) ? <AppFrameBottomRow variant="detail" start={pushed.start} fill={pushed.fill} end={pushed.end} /> : null
  }
  return (
    <>
      {/* Nothing is live: once the page has scrolled, where you are and the newest item's name. */}
      {strip && <AppFrameAccessory scrolledOnly meta={strip.meta} title={strip.title} />}
      <AppFrameBottomRow
        variant="tabs"
        start={<FloatButton label="Search" icon="search" size="l" onClick={onSearch} />}
        tabs={
          <TabBar label="Sections" value={active.id} onValueChange={(id) => onNavigate(id as VerticalId)} onReselect={returnToRoot}>
            {sections.map((v) => (
              <TabBarItem key={v.id} value={v.id} icon={v.icon} label={v.label} />
            ))}
          </TabBar>
        }
        end={<QuickCreateButton section={active} onCreate={onCreate} handlers={handlers} />}
      />
    </>
  )
}
