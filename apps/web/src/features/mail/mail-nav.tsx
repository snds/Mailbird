import { factTime } from "@/app/screen"
import { checkMail, useStatus } from "@/app/live-status"
import { useNavPicked } from "@/app/places"
import { FirstGroup } from "@/app/section-switcher"
import { useUi } from "@/app/ui-store"
import { FieldRow, FieldRowAction, NavItem, NavSection, SectionHeader, type IconName } from "@unicron/ui"
import { isMember } from "@/core/client"
import { useCore } from "@/core/queries"
import { startAddAccount } from "@/features/onboarding/start-add-account"

import { LANES, type MailTab } from "./lanes"
import { useMailPlace } from "./use-mail-place"

const ICONS: Record<MailTab, IconName> = {
  inbox: "email",
  screener: "user--admin",
  unread: "email--new",
  starred: "star",
  snoozed: "time",
  waiting: "notification",
  scheduled: "send--alt",
  archive: "archive",
  mine: "user",
  team: "user--multiple",
}
const lane = (id: MailTab) => LANES.find((l) => l.id === id)!

/**
 * Mail's second level (ADR-0084; brief X1): the folders, the team's two
 * lists, and the accounts as a filter. In the sidebar on a desktop; in the
 * page head's sheet or popover elsewhere (`layer`), where `more` adds the
 * phone's own last group.
 */
export function MailNav({ layer = false, more = false }: { layer?: boolean; more?: boolean }) {
  const { tab, account, accounts, folders, team, waiting } = useMailPlace()
  // Settings or Search stands in the section's place: then none of its rows is the current one.
  const settings = useUi((s) => !!s.settings || !!s.search)
  const picked = useNavPicked()
  const go = (id: MailTab) => {
    useUi.getState().setMailTab(id)
    picked()
  }
  const row = (id: MailTab) => (
    <NavItem
      key={id}
      label={lane(id).label}
      icon={ICONS[id]}
      current={!settings && tab === id}
      mark={id === "screener" && waiting > 0 ? { count: waiting, label: `${waiting} waiting` } : undefined}
      onClick={() => go(id)}
    />
  )
  return (
    <>
      <FirstGroup layer={layer} title="Mail // folders">
        {folders.map(row)}
      </FirstGroup>
      {team.length > 0 && <NavSection title="Team">{team.map(row)}</NavSection>}
      {accounts.length > 1 && (
        <div className="flex flex-col gap-1">
          {/* A filter, not a place: a radio group, so no row here is ever "current". */}
          <NavSection title="Accounts" count={accounts.length} checkable="single" aria-label="Account">
            <NavItem label="All" checked={account === null} onCheckedChange={() => useUi.getState().setMailAccount(null)} onClick={picked} />
            {accounts.map((a) => (
              <NavItem
                key={a.id}
                label={a.displayName}
                checked={account?.id === a.id}
                tone={a.lastError ? "critical" : undefined}
                toneLabel="sync problem"
                onCheckedChange={() => useUi.getState().setMailAccount(a.id)}
                onClick={picked}
              />
            ))}
          </NavSection>
          {/* The accounts are the gateway owner's: a team member works their mail and adds none (ADR-0063). */}
          {!isMember() && <NavItem
            label="Add an account…"
            icon="add"
            onClick={() => {
              picked()
              startAddAccount()
            }}
          />}
        </div>
      )}
      {more && <MailMore />}
    </>
  )
}

/** The phone sheet's last group: when mail was last checked, and the plain way to check again (pull to refresh has one too). */
function MailMore() {
  const { data: core } = useCore()
  const { account, accounts } = useMailPlace()
  const checking = useStatus((s) => s.checking > 0)
  // Only the desktop core checks the servers itself; a gateway keeps its own time.
  if (core?.kind !== "native") return null
  const shown = account ? [account] : accounts
  const checked = shown.length > 0 && shown.every((a) => a.lastSync !== null) ? factTime(Math.min(...shown.map((a) => a.lastSync!))) : "Not yet"
  return (
    <section className="flex flex-col gap-2">
      <SectionHeader title="More" level={3} />
      <FieldRow
        size="stacked"
        rule="none"
        label="Last checked"
        action={
          <FieldRowAction loading={checking} onClick={() => void checkMail()}>
            Check again
          </FieldRowAction>
        }
      >
        {checked}
      </FieldRow>
    </section>
  )
}
