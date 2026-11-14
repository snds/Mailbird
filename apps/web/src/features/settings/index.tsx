import { stepBack } from "@/app/places"
import { useScreenPlace } from "@/app/screen"
import { useUi } from "@/app/ui-store"
import { Button, Icon, Item, ItemContent, ItemMedia, ItemTitle } from "@unicron/ui"
import { MasterDetail } from "@/components/master-detail"
import { ScreenHead } from "@/components/page"
import { signOutOfGateway } from "@/core/client"
import { useCore } from "@/core/queries"

import { useSettingsSections } from "./sections"

/**
 * Settings as a page (ADR-0075): the sections down the left like a mailbox's
 * list, by name alone, and the one you pick beside them under its header. Replaces the accounts dialog and the
 * dialogs it opened. Sections that need an account show once there is one.
 * Which sections there are, and who has each, is `sections.ts` (ADR-0085).
 */
export function SettingsView() {
  const settings = useUi((s) => s.settings)
  const openSettings = useUi((s) => s.openSettings)
  const sections = useSettingsSections()
  const current = sections.find((s) => s.id === settings) ?? null
  const remote = useCore().data?.remote

  // The breadcrumb's last part (ADR-0083): SETTINGS // MAIL.
  useScreenPlace(current?.name ?? null)

  return (
    <MasterDetail
      section="Settings"
      pick="Pick a section to see its settings here."
      detailIsPlace
      // Back from a section to the list of sections: the browser's Back when the list is the place behind (ADR-0084).
      onBack={() => stepBack((behind) => behind.settings === "index", () => useUi.setState({ settings: "index" }))}
      header={<ScreenHead overline="Settings" title="Settings" />}
      list={
        <nav aria-label="Settings sections" className="flex flex-col gap-1 pb-4">
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
                <ItemTitle>{s.name}</ItemTitle>
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
          <section key={current.id} aria-label={current.name} className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-6 md:px-8">
            <current.body />
          </section>
        )
      }
    />
  )
}
