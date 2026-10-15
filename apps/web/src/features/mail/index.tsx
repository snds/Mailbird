import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react"

import { pendingJump, useUi } from "@/app/ui-store"
import { Icon } from "@/components/icon"
import { ListRow } from "@/components/list-row"
import { MasterDetail, PaneHeader } from "@/components/master-detail"
import { VirtualList } from "@/components/virtual-list"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAccounts, useCore, useInboxOverview, useMailAction, useMessagePages, useContactPhotos, useScreener, useSwipeActions, useThread } from "@/core/queries"
import type { Lane, MessageSummary } from "@/core/types"
import { shortTime } from "@/lib/time"

import { useTriage } from "./actions"
import { useNowSecs } from "@/hooks/use-now"

import { ConversationView } from "./conversation-view"
import { CATEGORIES, LANES, type MailTab } from "./lanes"
import { useSenderActions } from "./sender-actions"
import { displayName, initials } from "./format"
import { ScheduledList } from "./scheduled-list"
import { BundleRow, SplitChips } from "./splits"
import { SwipeRow } from "./swipe-row"
import { useMailVerbs } from "./vocabulary"
import { useMailShortcuts } from "./use-shortcuts"

export function MailView() {
  // In the UI store, so the command menu can switch it.
  const tab = useUi((s) => s.mailTab)
  const setTab = useUi((s) => s.setMailTab)
  const lane: Lane = tab === "scheduled" ? "inbox" : tab
  // People / Updates / Newsletters chips filter the inbox.
  const category = useUi((s) => s.mailCategory)
  const setCategory = useUi((s) => s.setMailCategory)
  const split = useUi((s) => s.mailSplit)
  const { data: screener } = useScreener()
  const senderActions = useSenderActions()
  const now = useNowSecs()
  const [accountId, setAccountId] = useState<string | null>(null)
  const search = useUi((s) => s.mailSearch)
  const setSearch = useUi((s) => s.setMailSearch)
  // Selection is a conversation. The row is remembered so the reader stays
  // open when the row leaves the current lane (e.g. read mail in "Unread").
  const [selected, setSelected] = useState<MessageSummary | null>(() => pendingJump("thread")?.row ?? null)
  useEffect(() => void useUi.getState().takeJump("thread"), [])
  const selectedId = selected?.threadId ?? null
  const searchRef = useRef<HTMLInputElement>(null)
  const deferredSearch = useDeferredValue(search.trim())

  const { data: core } = useCore()
  const { data: accounts = [] } = useAccounts()
  // All of the inbox (no chip, no search) folds newsletters into the bundle row.
  const bundling = tab === "inbox" && !category && !split && !deferredSearch
  const { data: pages, isPending, hasNextPage, isFetchingNextPage, fetchNextPage } = useMessagePages({
    lane,
    accountId,
    search: deferredSearch || null,
    category: tab === "inbox" ? category : null,
    split: tab === "inbox" ? split : null,
    bundle: bundling,
  })
  const { data: thread } = useThread(selectedId)
  const { data: overview } = useInboxOverview(accountId)
  const openComposer = useUi((s) => s.openComposer)
  const setAccountsOpen = useUi((s) => s.setAccountsOpen)
  const sync = useMailAction<void>((c) => c.syncNow())
  const triage = useTriage(() => setSelected(null))
  const verb = useMailVerbs(triage, senderActions)
  const { data: swipes = { right: "read", rightLong: "none", left: "archive", leftLong: "none" } } = useSwipeActions()
  const markSeen = triage.markSeen

  const list = useMemo(() => pages?.pages.flat() ?? [], [pages])
  const loadMore = () => hasNextPage && !isFetchingNextPage && void fetchNextPage()
  const row = list.find((m) => m.threadId === selectedId) ?? selected ?? undefined
  const select = (id: string | null) => setSelected(id ? (list.find((m) => m.threadId === id) ?? null) : null)

  // Opening a conversation reads it — once, so "Mark unread" sticks.
  const markedRef = useRef<string | null>(null)
  useEffect(() => {
    if (row && thread && thread.some((m) => !m.seen) && markedRef.current !== row.threadId) {
      markedRef.current = row.threadId
      markSeen(row, true)
    }
  }, [row, thread, markSeen])

  const multiAccount = accounts.length > 1
  const laneInfo = LANES.find((l) => l.id === tab)!
  // The Screener tab only exists while it's on (or still holds mail).
  const tabs = LANES.filter((l) => l.id !== "screener" || screener?.enabled || tab === "screener")
  const emptyText = tab === "inbox" && category ? CATEGORIES.find((c) => c.id === category)!.empty : laneInfo.empty

  useMailShortcuts({
    list,
    selectedId,
    select,
    compose: () => openComposer({ accountId: accountId ?? accounts[0]?.id }),
    focusSearch: () => searchRef.current?.focus(),
    triage,
    selected: row,
    verb,
  })

  return (
    <MasterDetail
      emptyIcon="mail"
      emptyLabel="Choose a conversation to read it here."
      onBack={() => setSelected(null)}
      header={
        <>
          <PaneHeader title={accountId ? (accounts.find((a) => a.id === accountId)?.displayName ?? "Inbox") : "All inboxes"}>
            {/* Phones have no nav rail, so accounts live here. */}
            <Button variant="ghost" size="icon" aria-label="Accounts and settings" className="md:hidden" onClick={() => setAccountsOpen(true)}>
              <Icon name="manage_accounts" />
            </Button>
            {multiAccount && (
              <NativeSelect
                size="sm"
                aria-label="Account"
                value={accountId ?? ""}
                onChange={(e) => (setAccountId(e.target.value || null), setSelected(null))}
                className="w-auto"
              >
                <NativeSelectOption value="">All</NativeSelectOption>
                {accounts.map((a) => (
                  <NativeSelectOption key={a.id} value={a.id}>
                    {a.displayName}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            )}
            {core?.kind === "native" && (
              <Button variant="ghost" size="icon" aria-label="Check for new mail" onClick={() => sync.mutate()} disabled={sync.isPending}>
                <Icon name="sync" className={sync.isPending ? "animate-spin" : undefined} />
              </Button>
            )}
          </PaneHeader>
          <div className="flex flex-col gap-3 px-4 pb-3">
            <InputGroup className="h-10 rounded-xl bg-background">
              <InputGroupAddon>
                <Icon name="search" />
              </InputGroupAddon>
              <InputGroupInput
                ref={searchRef}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && (setSearch(""), e.currentTarget.blur())}
                placeholder="Search mail"
                aria-label="Search mail"
              />
              {search && (
                <InputGroupAddon align="inline-end">
                  <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => setSearch("")}>
                    <Icon name="close" />
                  </InputGroupButton>
                </InputGroupAddon>
              )}
            </InputGroup>
            {/* Lanes scroll sideways when they don't fit; the edge fade says there's more. */}
            <div className="-mx-4 no-scrollbar overflow-x-auto px-4 [mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)]">
              <Tabs value={tab} onValueChange={(v) => (setTab(v as MailTab), setSelected(null))} className="w-max pr-6">
                <TabsList>
                  {tabs.map((l) => (
                    <TabsTrigger key={l.id} value={l.id}>
                      {l.label}
                      {l.id === "screener" && !!screener?.waiting && (
                        <span className="ml-1 rounded-full bg-vertical-mail px-1.5 text-[11px] leading-4 font-semibold text-white" aria-label={`${screener.waiting} waiting`}>
                          {screener.waiting}
                        </span>
                      )}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </div>
            {tab === "inbox" && (
              <div role="group" aria-label="Show" className="-mx-4 no-scrollbar flex gap-1.5 overflow-x-auto px-4">
                {[{ id: null, label: "All" } as const, ...CATEGORIES].map((c) => (
                  <Button
                    key={c.label}
                    size="xs"
                    variant={category === c.id ? "secondary" : "ghost"}
                    aria-pressed={category === c.id}
                    className="rounded-full px-3"
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
        </>
      }
      list={
        tab === "scheduled" ? (
          <ScheduledList />
        ) : isPending ? (
          <ListSkeleton />
        ) : accounts.length === 0 ? (
          <Empty className="py-16">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Icon name="alternate_email" />
              </EmptyMedia>
              <EmptyTitle>Add your first account</EmptyTitle>
              <EmptyDescription>Gmail, Outlook, iCloud, Fastmail, or any IMAP account.</EmptyDescription>
            </EmptyHeader>
            <Button onClick={() => setAccountsOpen(true)}>
              <Icon name="add" data-icon="inline-start" /> Add account
            </Button>
          </Empty>
        ) : list.length === 0 && bundling && overview?.bundle ? (
          <BundleRow accountId={accountId} onOpen={() => (setCategory("newsletters"), setSelected(null))} />
        ) : list.length === 0 ? (
          <Empty className="py-16">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Icon name={deferredSearch ? "search_off" : "done_all"} />
              </EmptyMedia>
              <EmptyTitle>{deferredSearch ? "No matches" : emptyText}</EmptyTitle>
              {deferredSearch && <EmptyDescription>Nothing in {laneInfo.label} matches “{deferredSearch}”.</EmptyDescription>}
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
              <SwipeRow
                // Your mapping (ADR-0025); Apple Mail's until changed: right toggles read, left archives.
                // In the Screener: right lets the sender in, left screens them out.
                {...(tab === "screener"
                  ? {
                      start: { icon: "how_to_reg", label: "Let in", tone: "bg-vertical-mail", onCommit: () => senderActions.decide(m.from, "allowed") },
                      end: { icon: "block", label: "Screen out", tone: "bg-destructive", onCommit: () => senderActions.decide(m.from, "screened_out") },
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
              </SwipeRow>
            )}
          />
          </>
        )
      }
      detail={
        selectedId && (
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
      <span className="inline-flex items-center gap-1 text-vertical-notes">
        <Icon name="snooze" className="size-3.5" />
        {shortTime(m.snoozedUntil)}
      </span>
    ) : lane === "waiting" && m.followUpAt ? (
      <span className="inline-flex items-center gap-1 text-vertical-mail">
        <Icon name="notifications" className="size-3.5" />
        {shortTime(m.followUpAt)}
      </span>
    ) : (
      shortTime(nudged ? Math.max(m.followUpAt!, m.sortAt) : m.sortAt)
    )
  return (
    <ListRow
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
              <span className="mr-1.5 inline-flex items-center gap-1 rounded-md bg-vertical-mail/10 px-1.5 text-xs font-medium text-vertical-mail">
                <Icon name="notifications_active" className="size-3.5" /> No reply yet
              </span>
            )}
            <span className="text-foreground">{m.subject || "(no subject)"}</span>
            {m.preview && <> — {m.preview}</>}
          </>
        }
        trailing={
          <span className="mt-0.5 flex shrink-0 flex-col items-end gap-1">
            {m.flagged && <Icon name="star" fill className="size-4 text-vertical-notes" label="Starred" />}
            {m.hasAttachments && <Icon name="attach_file" className="size-4 text-muted-foreground" label="Has attachments" />}
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
