import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { factTime, usePlaceStrip, useRefresh, useScreenFact, useScreenPlace } from "@/app/screen"
import { useSectionSwitcher } from "@/app/places"
import { SectionSwitcher } from "@/app/section-switcher"
import { pendingJump, useUi } from "@/app/ui-store"
import { vertical } from "@/app/verticals"
import { Icon, Avatar, AvatarFallback, AvatarImage, Button, Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle, Skeleton, type PageHeadSwipe } from "@unicron/ui"
import { EntryRow } from "@/components/list-row"
import { MasterDetail } from "@/components/master-detail"
import { ScreenHead } from "@/components/page"
import { VirtualList } from "@/components/virtual-list"
import { useCore, useInboxOverview, useMailAction, useMailPrefs, useMe, useMessagePages, useContactPhotos, useSwipeActions, useThread } from "@/core/queries"
import type { Lane, MessageSummary } from "@/core/types"
import { shortTime } from "@/lib/time"

import { useTriage } from "./actions"
import { useNowSecs } from "@/hooks/use-now"
import { startFirstRun } from "@/features/onboarding/start-add-account"

import { ConversationView } from "./conversation-view"
import { CATEGORIES, LANES } from "./lanes"
import { MailNav } from "./mail-nav"
import { useSenderActions } from "./sender-actions"
import { displayName, initials } from "./format"
import { ScheduledList } from "./scheduled-list"
import { TeamList, TeamThreadView } from "../team/team-view"
import { BundleRow, SplitChips } from "./splits"
import { RowSwipe } from "./swipe-row"
import { PRIMARY, useMailVerbs } from "./vocabulary"
import { useMailPlace } from "./use-mail-place"
import { useMailShortcuts } from "./use-shortcuts"

export function MailView() {
  // Mail's place (ADR-0084): the lane and the account, in the UI store, so the sidebar, the page head's
  // sheet and the command menu all switch them. A lane or an account that is gone falls back to the first.
  const { tab, account, accounts } = useMailPlace()
  const accountId = account?.id ?? null
  const lane: Lane = tab === "scheduled" || tab === "team" || tab === "mine" ? "inbox" : tab
  // A shared inbox (ADR-0063): "Assigned to me" lists what is yours.
  const me = useMe()
  // Mail → Team (ADR-0060): shared conversations open in their own view.
  const teamOpen = useUi((s) => s.teamOpen)
  const setTeamOpen = useUi((s) => s.setTeamOpen)
  // People / Updates / Newsletters chips filter the inbox.
  const category = useUi((s) => s.mailCategory)
  const setCategory = useUi((s) => s.setMailCategory)
  const split = useUi((s) => s.mailSplit)
  const senderActions = useSenderActions()
  const now = useNowSecs()
  // Selection is a conversation. The row is remembered so the reader stays
  // open when the row leaves the current lane (e.g. read mail in "Unread").
  const [selected, setSelected] = useState<MessageSummary | null>(() => pendingJump("thread")?.row ?? null)
  useEffect(() => void useUi.getState().takeJump("thread"), [])
  // Another lane or account, picked in the nav: what was open belongs to the place left behind.
  const placeKey = `${tab}/${accountId ?? ""}`
  const [placeSeen, setPlaceSeen] = useState(placeKey)
  if (placeSeen !== placeKey) {
    setPlaceSeen(placeKey)
    setSelected(null)
  }
  const selectedId = selected?.threadId ?? null

  const { data: core } = useCore()
  // All of the inbox (no chip) folds newsletters into the bundle row. Searching a lane is Search's (ADR-0085).
  const bundling = tab === "inbox" && !category && !split
  const { data: pages, isPending, hasNextPage, isFetchingNextPage, fetchNextPage, refetch } = useMessagePages({
    lane,
    accountId,
    search: null,
    category: tab === "inbox" ? category : null,
    split: tab === "inbox" ? split : null,
    bundle: bundling,
    assignedTo: tab === "mine" ? me.id : null,
  })
  const { data: thread } = useThread(selectedId)
  const { data: overview } = useInboxOverview(accountId)
  const openComposer = useUi((s) => s.openComposer)
  const sync = useMailAction<void>((c) => c.syncNow())
  const triage = useTriage(() => setSelected(null))
  const verb = useMailVerbs(triage, senderActions)
  const { data: swipes = { right: "read", rightLong: "none", left: "archive", leftLong: "none" } } = useSwipeActions()
  const markSeen = triage.markSeen

  const list = useMemo(() => pages?.pages.flat() ?? [], [pages])
  const loadMore = () => hasNextPage && !isFetchingNextPage && void fetchNextPage()
  const row = list.find((m) => m.threadId === selectedId) ?? selected ?? undefined
  const select = (id: string | null) => setSelected(id ? (list.find((m) => m.threadId === id) ?? null) : null)

  // Opening a conversation reads it — once, so "Mark unread" sticks. Advanced
  // settings can wait 3 seconds, so a glance doesn't count, or leave it to you (ADR-0055).
  const markedRef = useRef<string | null>(null)
  const { data: mailPrefs } = useMailPrefs()
  const markRead = mailPrefs?.markRead
  useEffect(() => {
    if (!markRead || markRead === "manual") return
    if (!row || !thread || !thread.some((m) => !m.seen) || markedRef.current === row.threadId) return
    const mark = () => {
      markedRef.current = row.threadId
      markSeen(row, true)
    }
    if (markRead === "open") return mark()
    const t = setTimeout(mark, 3000)
    return () => clearTimeout(t)
  }, [row, thread, markSeen, markRead])

  const multiAccount = accounts.length > 1
  const laneInfo = LANES.find((l) => l.id === tab)!
  const emptyText = tab === "inbox" && category ? CATEGORIES.find((c) => c.id === category)!.empty : laneInfo.empty

  // What the shell says about this screen (ADR-0083): the place, the newest
  // conversation for the phone's scrolled strip, and when mail last arrived.
  const where = [laneInfo.label, account ? account.displayName : multiAccount ? "All accounts" : null].filter(Boolean).join(" // ")
  useScreenPlace(laneInfo.label)
  usePlaceStrip(where, tab === "scheduled" || tab === "team" ? null : (list[0]?.subject ?? null))
  const synced = syncedAt(account ? [account] : accounts)
  useScreenFact(synced ? `Synced // ${synced}` : null)
  // Pull to refresh, and a second tap on Mail's tab: the desktop core checks the servers; a gateway's list is read again.
  useRefresh(() => (core?.kind === "native" ? sync.mutateAsync() : refetch()))

  // The page head is the way to the folders and accounts wherever the sidebar does not list them (brief X1).
  // A sideways swipe on it steps the account: All, then each (brief 3.6).
  const stepAccount = useCallback(
    (direction: PageHeadSwipe) => {
      const ids = [null, ...accounts.map((a) => a.id)]
      const at = ids.indexOf(accountId)
      useUi.getState().setMailAccount(ids[(at + (direction === "next" ? 1 : -1) + ids.length) % ids.length] ?? null)
    },
    [accounts, accountId],
  )
  const accountName = account ? account.displayName : multiAccount ? "All accounts" : null
  // After the title, which the head says first: "Today, Personal. Change folder or account." on the page head,
  // and "Inbox, Personal. Change folder or account." on the small title it collapses to.
  const switching = useSectionSwitcher(`${accountName ? `${accountName}. ` : ""}${multiAccount ? "Change folder or account." : "Change folder."}`, multiAccount ? stepAccount : undefined)

  useMailShortcuts({
    list,
    selectedId,
    select,
    compose: () => openComposer({ accountId: accountId ?? accounts[0]?.id }),
    triage,
    selected: row,
    verb,
  })

  return (
    <MasterDetail
      section="Mail"
      pick={vertical("mail").pick}
      onBack={() => (tab === "team" ? setTeamOpen(null) : setSelected(null))}
      onRoot={() => {
        useUi.getState().showMailTab("inbox")
        setTeamOpen(null)
        setSelected(null)
      }}
      header={
        <ScreenHead
          overline={where}
          // The Inbox keeps the drawn "Today" and its date; every other lane is named.
          title={tab === "inbox" ? "Today" : laneInfo.label}
          short={laneInfo.label}
          meta={tab === "inbox" ? folioDate(new Date(now * 1000)) : undefined}
          switcher={switching.switcher}
          actions={
            core?.kind === "native" && (
              <Button variant="ghost" size="icon" aria-label="Check for new mail" onClick={() => sync.mutate()} disabled={sync.isPending}>
                <Icon name="renew" className={sync.isPending ? "animate-spin" : undefined} />
              </Button>
            )
          }
          below={
            <div className="flex flex-col gap-3">
              <SectionSwitcher state={switching} overline={["Mail", accountName].filter(Boolean).join(" // ")} title="Folders">
                <MailNav layer more={switching.sheet} />
              </SectionSwitcher>
              {tab === "inbox" && (
                <div role="group" aria-label="Show" className="no-scrollbar flex gap-1.5 overflow-x-auto">
                  {[{ id: null, label: "All" } as const, ...CATEGORIES].map((c) => (
                    <Button
                      key={c.label}
                      size="xs"
                      variant={category === c.id ? "secondary" : "ghost"}
                      aria-pressed={category === c.id}
                      shape="pill"
                      onClick={() => (setCategory(c.id), setSelected(null))}
                    >
                      {c.label}
                    </Button>
                  ))}
                  <SplitChips accountId={accountId} onPick={() => setSelected(null)} />
                </div>
              )}
              {tab === "screener" && (
                <p className="text-xs text-muted-foreground">First-time senders wait here. Let them in and their mail goes to your inbox; screen them out and it never does.</p>
              )}
            </div>
          }
        />
      }
      list={
        tab === "scheduled" ? (
          <ScheduledList />
        ) : tab === "team" ? (
          <TeamList />
        ) : isPending ? (
          <ListSkeleton />
        ) : accounts.length === 0 ? (
          <Empty size="sm" className="py-16">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Icon name="at" />
              </EmptyMedia>
              <EmptyTitle>Add your first account</EmptyTitle>
              <EmptyDescription>Gmail, Outlook, iCloud, Fastmail, or any IMAP account.</EmptyDescription>
            </EmptyHeader>
            <Button onClick={startFirstRun}>
              <Icon name="add" data-icon="inline-start" /> Add account
            </Button>
          </Empty>
        ) : list.length === 0 && bundling && overview?.bundle ? (
          <BundleRow accountId={accountId} onOpen={() => (setCategory("newsletters"), setSelected(null))} />
        ) : list.length === 0 ? (
          <Empty size="sm" className="py-16">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Icon name="checkmark--double" />
              </EmptyMedia>
              <EmptyTitle>{emptyText}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
          {bundling && <BundleRow accountId={accountId} onOpen={() => (setCategory("newsletters"), setSelected(null))} />}
          <VirtualList
            items={list}
            itemKey={(m) => m.threadId}
            estimate={76}
            onEnd={loadMore}
            label={laneInfo.label}
            render={(m) => (
              <RowSwipe
                // Your mapping (ADR-0025); Apple Mail's until changed: right toggles read, left archives.
                // In the Screener: right lets the sender in, left screens them out.
                {...(tab === "screener"
                  ? {
                      start: { icon: "user--admin", label: "Let in", tone: PRIMARY, onCommit: () => senderActions.decide(m.from, "allowed") },
                      end: { icon: "user--minus", label: "Screen out", tone: "bg-critical-fill text-critical-on-fill", onCommit: () => senderActions.decide(m.from, "screened_out") },
                    }
                  : {
                      start: verb(swipes.right, m),
                      startLong: verb(swipes.rightLong, m),
                      end: verb(swipes.left, m),
                      endLong: verb(swipes.leftLong, m),
                    })}
              >
                <MessageRow
                  message={m}
                  lane={lane}
                  now={now}
                  selected={m.threadId === selectedId}
                  onSelect={() => setSelected(m)}
                  account={multiAccount && !accountId ? accounts.find((a) => a.id === m.accountId)?.displayName : undefined}
                />
              </RowSwipe>
            )}
          />
          </>
        )
      }
      detail={
        tab === "team" ? (
          teamOpen && <TeamThreadView key={teamOpen} id={teamOpen} />
        ) : selectedId && (
          <ConversationView
            key={selectedId}
            row={row}
            thread={thread}
            account={accounts.find((a) => a.id === row?.accountId)}
            showAccount={multiAccount}
            triage={triage}
            screening={tab === "screener"}
            onLeave={() => setSelected(null)}
            onOpenThread={setSelected}
          />
        )
      }
    />
  )
}

/** The date as the frames write it beside a title: `THU 11.12`. */
const folioDate = (d: Date) =>
  `${d.toLocaleDateString(undefined, { weekday: "short" }).toUpperCase()} ${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`

/** When the accounts shown last finished a sync: the oldest of them, so the line never claims more than is true. */
function syncedAt(accounts: { lastSync: number | null }[]) {
  if (!accounts.length || accounts.some((a) => a.lastSync === null)) return null
  return factTime(Math.min(...accounts.map((a) => a.lastSync!)))
}

function MessageRow({
  message: m,
  lane,
  now,
  selected,
  onSelect,
  account,
}: {
  message: MessageSummary
  lane: Lane
  now: number
  selected: boolean
  onSelect: () => void
  account?: string
}) {
  // A face for senders you have a card for (ADR-0027); initials otherwise.
  const { data: photos } = useContactPhotos()
  // Your own mail says who it went to.
  const sentTo = m.mailbox === "Sent" ? m.sentTo : null
  const face = sentTo ? undefined : photos?.[m.from.email.trim().toLowerCase()]
  // A follow-up that came due brings your own message back to the inbox.
  const nudged = lane === "inbox" && m.followUpAt != null && m.followUpAt <= now
  const meta =
    lane === "snoozed" && m.snoozedUntil ? (
      <span className="inline-flex items-center gap-1">
        <Icon name="time" size={14} />
        {shortTime(m.snoozedUntil)}
      </span>
    ) : lane === "waiting" && m.followUpAt ? (
      <span className="inline-flex items-center gap-1">
        <Icon name="notification" size={14} />
        {shortTime(m.followUpAt)}
      </span>
    ) : (
      shortTime(nudged ? Math.max(m.followUpAt!, m.sortAt) : m.sortAt)
    )
  return (
    <EntryRow
        selected={selected}
        onSelect={onSelect}
        emphasized={!m.seen}
        leading={
          <Avatar className="mt-0.5">
            {face && <AvatarImage src={face} alt="" />}
            <AvatarFallback>{sentTo ? initials({ name: sentTo, email: sentTo }) : initials(m.from)}</AvatarFallback>
          </Avatar>
        }
        title={
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate">{sentTo ? `To ${sentTo}` : displayName(m.from)}</span>
            {m.threadCount > 1 && (
              <span className="shrink-0 text-xs font-normal text-muted-foreground" aria-label={`${m.threadCount} messages`}>
                {m.threadCount}
              </span>
            )}
          </span>
        }
        meta={meta}
        supporting={
          <>
            {nudged && (
              <span className="mr-1.5 inline-flex items-center gap-1 rounded-md bg-accent px-1.5 text-xs font-medium text-foreground">
                <Icon name="notification--filled" size={14} /> No reply yet
              </span>
            )}
            <span className="text-foreground">{m.subject || "(no subject)"}</span>
            {m.preview && <> — {m.preview}</>}
          </>
        }
        trailing={
          <span className="mt-0.5 flex shrink-0 flex-col items-end gap-1">
            {m.flagged && <Icon name="star--filled" size="sm" label="Starred" />}
            {m.hasAttachments && <Icon name="attachment" tone="muted" size="sm" label="Has attachments" />}
            {account && <span className="text-[11px] text-muted-foreground">{account}</span>}
          </span>
        }
      />
  )
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-4 px-4 py-3" aria-busy>
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex gap-3">
          <Skeleton className="size-8 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-4 w-full" />
          </div>
        </div>
      ))}
    </div>
  )
}
