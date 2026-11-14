import { useCore } from "@/core/queries"
import { AccountsSection } from "@/features/accounts"
import { AdvancedMail } from "@/features/advanced-mail"
import { AiSettingsForm } from "@/features/ai-settings"
import { AppearanceSettings } from "@/features/appearance-settings"
import { GatewayUpdatesSection } from "@/features/gateway-updates"
import { ShortcutSettings } from "@/features/grammar"
import { MeetingSettingsSection } from "@/features/meeting-settings"
import { MenuBarSettingsSection } from "@/features/menu-bar-settings"
import { PushSettingsSection } from "@/features/push-settings"
import { ScreenerSettingsSection } from "@/features/screener-settings"
import { Members } from "@/features/team-members"
import { AboutSection } from "@/features/updates/about-section"
import { WritingSettings } from "@/features/writing-settings"

import { SecondZoneRow } from "./second-zone-row"
import { SettingsHeading } from "./section-header"

/**
 * What each settings section shows (ADR-0085): one component per section,
 * named by the registry in `sections.ts`. A lane that rebuilds a section
 * changes its body here, or points the registry at its own.
 */

export const AccountsBody = () => <AccountsSection />

export function TeamBody() {
  return (
    <>
      <SettingsHeading
        title="Team members"
        description="People you add work this gateway's mail with you: they read and reply from its accounts, assign conversations, and leave each other notes. Your accounts, settings, calendars, contacts, and notes stay yours."
      />
      <Members />
    </>
  )
}

export function MailBody() {
  return (
    <>
      <SettingsHeading title="Mail" description="The defaults keep your reading private. Change them here if you want more control." />
      <AdvancedMail />
      <ScreenerSettingsSection />
    </>
  )
}

export function WritingBody() {
  return (
    <>
      <SettingsHeading title="Signatures and templates" description="Signatures go on new messages and replies. Templates are text you reuse, inserted from the composer." />
      <WritingSettings />
    </>
  )
}

export function AiBody() {
  return (
    <>
      <SettingsHeading title="AI summaries and replies" description="Off unless you turn it on. A conversation goes to the model only when you ask for its summary or replies." />
      <AiSettingsForm />
    </>
  )
}

export function NotificationsBody() {
  return (
    <>
      <SettingsHeading title="Notifications" description="How mail reaches your phone while the app is closed. The desktop app keeps its own connection open while it runs." />
      <PushSettingsSection />
    </>
  )
}

export function CalendarBody() {
  const remote = !!useCore().data?.remote
  return (
    <>
      <SettingsHeading title="Calendar" description={remote ? "How meetings open." : "How meetings open, and what the menu bar shows."} />
      <MeetingSettingsSection />
      {/* The menu bar is the desktop's; the demo stands in for it. */}
      {!remote && <MenuBarSettingsSection />}
      {/* A choice for this device, beside the hours of the week and the day (it was in the calendar's side list). */}
      <SecondZoneRow />
    </>
  )
}

/** Registered and not shown yet: the notes lane gives it rows, and its `when`, without touching the store. */
export const NotesBody = () => null

export function AppearanceBody() {
  return (
    <>
      <SettingsHeading title="Appearance" description="How Vale looks on this device." />
      <AppearanceSettings />
    </>
  )
}

export function ShortcutsBody() {
  return (
    <>
      <SettingsHeading
        title="Shortcuts and gestures"
        description="The same actions three ways: a key, a swipe on a phone, or the command menu. Every swipe can also have a key, so nothing is gesture-only."
      />
      <ShortcutSettings />
    </>
  )
}

export function GatewayBody() {
  return (
    <>
      <SettingsHeading title="Gateway updates" description="This gateway's version, and whether a newer image is out. The gateway never restarts itself: you update it on its server." />
      <GatewayUpdatesSection />
    </>
  )
}

export function AboutBody() {
  return (
    <>
      <SettingsHeading title="About" description="This version of Vale, and its updates. A newer build downloads quietly, and Vale offers to restart for it." />
      <AboutSection />
    </>
  )
}
