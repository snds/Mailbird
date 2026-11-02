import type { ReactNode } from "react"

import { useUi, type SettingsSection } from "@/app/ui-store"
import { Button, Icon, type IconName, Item, ItemContent, ItemMedia, ItemTitle } from "@unicron/ui"
import { MasterDetail, PaneHeader } from "@/components/master-detail"
import { isMember, signOutOfGateway } from "@/core/client"
import { useAccounts, useCore } from "@/core/queries"
import { AccountsSection } from "@/features/accounts"
import { AdvancedMail } from "@/features/advanced-mail"
import { AiSettingsForm } from "@/features/ai-settings"
import { ShortcutSettings } from "@/features/grammar"
import { MeetingSettingsSection } from "@/features/meeting-settings"
import { MenuBarSettingsSection } from "@/features/menu-bar-settings"
import { PushSettingsSection } from "@/features/push-settings"
import { ScreenerSettingsSection } from "@/features/screener-settings"
import { Members } from "@/features/team-members"
import { WritingSettings } from "@/features/writing-settings"

import { SectionHeader } from "./section-header"

interface Section {
  id: SettingsSection
  icon: IconName
  title: string
  body: () => ReactNode
}

/**
 * Settings as a page (ADR-0075): the sections down the left like a mailbox's
 * list, by name alone, and the one you pick beside them under its header. Replaces the accounts dialog and the
 * dialogs it opened. Sections that need an account show once there is one.
 */
export function SettingsView() {
  const settings = useUi((s) => s.settings)
  const openSettings = useUi((s) => s.openSettings)
  const sections = useSections()
  const current = sections.find((s) => s.id === settings) ?? null
  const remote = useCore().data?.remote

  return (
    <MasterDetail
      emptyIcon="settings"
      emptyLabel="Choose a section to see its settings."
      onBack={() => useUi.setState({ settings: "index" })}
      header={<PaneHeader title="Settings" />}
      list={
        <nav aria-label="Settings sections" className="flex flex-col gap-1 px-2 pb-4">
          {sections.map((s) => (
            <Item
              key={s.id}
              size="sm"
              className="border-transparent"
              data-selected={s.id === current?.id}
              render={<button type="button" aria-current={s.id === current?.id ? "page" : undefined} onClick={() => openSettings(s.id)} />}
            >
              <ItemMedia>
                <Icon name={s.icon} tone="muted" />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{s.title}</ItemTitle>
              </ItemContent>
            </Item>
          ))}
          {remote && (
            <Button variant="ghost" className="mt-4 justify-start" onClick={() => void signOutOfGateway().then(() => location.reload())}>
              <Icon name="logout" data-icon="inline-start" /> Sign out of this gateway
            </Button>
          )}
        </nav>
      }
      detail={
        current && (
          <section key={current.id} aria-label={current.title} className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-6 md:px-8">
            {current.body()}
          </section>
        )
      }
    />
  )
}

/** The sections this person has: a team member only has their own; most need an account. */
function useSections(): Section[] {
  const { data: accounts = [] } = useAccounts()
  const { data: core } = useCore()
  const hasAccount = accounts.length > 0
  const remote = !!core?.remote
  const member = isMember()
  const all: (Section & { when: boolean })[] = [
    {
      id: "accounts",
      icon: "manage_accounts",
      title: "Accounts",
      when: true,
      body: () => <AccountsSection />,
    },
    {
      id: "writing",
      icon: "edit_note",
      title: "Signatures and templates",
      when: hasAccount && !member,
      body: () => (
        <>
          <SectionHeader title="Signatures and templates" description="Signatures go on new messages and replies. Templates are text you reuse, inserted from the composer." />
          <WritingSettings />
        </>
      ),
    },
    {
      id: "mail",
      icon: "mail",
      title: "Mail",
      when: hasAccount && !member,
      body: () => (
        <>
          <SectionHeader title="Mail" description="The defaults keep your reading private. Change them here if you want more control." />
          <AdvancedMail />
          <ScreenerSettingsSection />
        </>
      ),
    },
    {
      id: "calendar",
      icon: "calendar_month",
      title: "Calendar",
      when: !member,
      body: () => (
        <>
          <SectionHeader title="Calendar" description={remote ? "How meetings open." : "How meetings open, and what the menu bar shows."} />
          <MeetingSettingsSection />
          {/* The menu bar is the desktop's; the demo stands in for it. */}
          {!remote && <MenuBarSettingsSection />}
        </>
      ),
    },
    {
      id: "shortcuts",
      icon: "keyboard",
      title: "Shortcuts and gestures",
      when: true,
      body: () => (
        <>
          <SectionHeader
            title="Shortcuts and gestures"
            description="The same actions three ways: a key, a swipe on a phone, or the command menu. Every swipe can also have a key, so nothing is gesture-only."
          />
          <ShortcutSettings />
        </>
      ),
    },
    {
      id: "ai",
      icon: "wand_stars",
      title: "AI summaries and replies",
      when: hasAccount && !member,
      body: () => (
        <>
          <SectionHeader title="AI summaries and replies" description="Off unless you turn it on. A conversation goes to the model only when you ask for its summary or replies." />
          <AiSettingsForm />
        </>
      ),
    },
    {
      id: "phone",
      icon: "mobile",
      title: "New mail on your phone",
      when: hasAccount && !remote && !member,
      body: () => (
        <>
          <SectionHeader title="New mail on your phone" description="How mail reaches your phone while the app is closed. The desktop app keeps its own connection open while it runs." />
          <PushSettingsSection />
        </>
      ),
    },
    {
      id: "team",
      icon: "group",
      title: "Team members",
      when: remote && !member,
      body: () => (
        <>
          <SectionHeader
            title="Team members"
            description="People you add work this gateway's mail with you: they read and reply from its accounts, assign conversations, and leave each other notes. Your accounts, settings, calendars, contacts, and notes stay yours."
          />
          <Members />
        </>
      ),
    },
  ]
  return all.filter((s) => s.when)
}
