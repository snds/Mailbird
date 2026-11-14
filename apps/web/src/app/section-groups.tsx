import type { VerticalId } from "./verticals"

/**
 * The open section's own groups in the sidebar, under APPS (brief X1): mail
 * folders and accounts, calendars, contact groups, note folders and tags.
 * They scroll while the head and Settings stay put. Each returns
 * `NavSection`s of `NavItem`s; in the rail the frame leaves them out, and the
 * page head opens the same list instead.
 *
 * Empty until the lane that owns each section's second level fills it. One
 * item per nav list is current: once a group item is the current place
 * (Inbox, All contacts), the shell passes `current={null}` to the sidebar so
 * APPS marks none (shell.tsx, `current`).
 */
export function SectionGroups(_props: { section: VerticalId }) {
  return null
}
