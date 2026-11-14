import type { ComponentType } from "react"

import type { IconName } from "@unicron/ui"
import { isMember, isTauri } from "@/core/client"
import { useAccounts, useCore } from "@/core/queries"

import { AboutBody, AccountsBody, AiBody, AppearanceBody, CalendarBody, GatewayBody, MailBody, NotesBody, NotificationsBody, ShortcutsBody, TeamBody, WritingBody } from "./section-bodies"

/**
 * The settings sections, in one place (ADR-0085; brief T0). The settings
 * page, the phone's list of sections and the command menu all read this
 * list, so a section added or renamed here shows in all three. The store
 * imports only the id type, so a lane that adds rows to a section, or shows
 * a hidden one, edits this folder and nothing else.
 */

/** A section's id: what `openSettings` takes and the store keeps. */
export type SettingsSection = "accounts" | "team" | "mail" | "writing" | "ai" | "notifications" | "calendar" | "notes" | "appearance" | "shortcuts" | "gateway" | "about"

/** The overline groups of brief T0, in order. A group with no section shown is left out. */
export type SettingsGroup = "Accounts" | "Mail" | "Calendar and notes" | "Vale"

/** What decides whether a person has a section. */
export interface SettingsContext {
  /** At least one mail account is set up. */
  hasAccount: boolean
  /** The core is a gateway's (or the demo standing in for one), not this device's own. */
  remote: boolean
  /** A team member on a gateway (ADR-0063): the mail is shared, the rest is the owner's. */
  member: boolean
  /** The desktop app, which updates itself (ADR-0076). */
  desktopApp: boolean
}

export interface SettingsSectionEntry {
  id: SettingsSection
  /** As the list, the breadcrumb and the command menu name it. "and", never "&". */
  name: string
  group: SettingsGroup
  icon: IconName
  /** Other words the command menu finds it by. */
  keywords: string[]
  /** Who has it. The conditions are the ones each section had before the list moved here. */
  when: (ctx: SettingsContext) => boolean
  body: ComponentType
}

export const SETTINGS_SECTIONS: SettingsSectionEntry[] = [
  { id: "accounts", name: "Accounts", group: "Accounts", icon: "user--settings", keywords: ["settings", "add account", "sign in"], when: () => true, body: AccountsBody },
  { id: "team", name: "Team members", group: "Accounts", icon: "user--multiple", keywords: ["settings", "people", "invite", "shared inbox"], when: (c) => c.remote && !c.member, body: TeamBody },
  { id: "mail", name: "Mail", group: "Mail", icon: "email", keywords: ["settings", "privacy", "images", "screener", "undo send"], when: (c) => c.hasAccount && !c.member, body: MailBody },
  { id: "writing", name: "Signatures and templates", group: "Mail", icon: "edit", keywords: ["settings", "signature", "template", "snippet"], when: (c) => c.hasAccount && !c.member, body: WritingBody },
  { id: "ai", name: "AI summaries and replies", group: "Mail", icon: "bot", keywords: ["settings", "model", "summary", "assistant"], when: (c) => c.hasAccount && !c.member, body: AiBody },
  // "New mail on your phone" until ADR-0085; the id was "phone".
  { id: "notifications", name: "Notifications", group: "Mail", icon: "mobile", keywords: ["settings", "push", "phone", "new mail", "alerts"], when: (c) => c.hasAccount && !c.remote && !c.member, body: NotificationsBody },
  { id: "calendar", name: "Calendar", group: "Calendar and notes", icon: "calendar", keywords: ["settings", "meetings", "menu bar", "time zone"], when: (c) => !c.member, body: CalendarBody },
  // Registered so its id is the store's already; hidden until the notes lane gives it rows.
  { id: "notes", name: "Notes", group: "Calendar and notes", icon: "notebook", keywords: ["settings"], when: () => false, body: NotesBody },
  // Everyone has it, a team member too: the theme is this device's, not the gateway's (ADR-0082).
  { id: "appearance", name: "Appearance", group: "Vale", icon: "contrast", keywords: ["settings", "theme", "stone", "graphite", "dark mode", "light mode"], when: () => true, body: AppearanceBody },
  { id: "shortcuts", name: "Shortcuts and gestures", group: "Vale", icon: "keyboard", keywords: ["settings", "keyboard", "swipe", "change keys", "change keys and swipes"], when: () => true, body: ShortcutsBody },
  // The gateway's own updates (ADR-0077), for its owner. It stays a section until About and Accounts take its rows.
  { id: "gateway", name: "Gateway updates", group: "Vale", icon: "bare-metal-server", keywords: ["settings", "server", "version", "image"], when: (c) => c.remote && !c.member, body: GatewayBody },
  // Updates are the desktop app's (ADR-0076): not on the web, a gateway, or Vale Demo.
  { id: "about", name: "About", group: "Vale", icon: "information", keywords: ["settings", "version", "updates"], when: (c) => c.desktopApp, body: AboutBody },
]

/** The sections this person has, in order: a team member only their own; most need an account. */
export function useSettingsSections(): SettingsSectionEntry[] {
  const { data: accounts = [] } = useAccounts()
  const { data: core } = useCore()
  const ctx: SettingsContext = { hasAccount: accounts.length > 0, remote: !!core?.remote, member: isMember(), desktopApp: isTauri() }
  return SETTINGS_SECTIONS.filter((s) => s.when(ctx))
}
