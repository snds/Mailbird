import { useDeferredValue, useEffect, useRef, useState } from "react"

import { useUi } from "@/app/ui-store"
import { Icon } from "@/components/icon"
import { ListRow } from "@/components/list-row"
import { MasterDetail, PaneHeader } from "@/components/master-detail"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAccounts, useCore, useMailAction, useMessages, useThread } from "@/core/queries"
import type { Lane, MessageSummary } from "@/core/types"
import { shortTime } from "@/lib/time"

import { useTriage } from "./actions"
import { ConversationView } from "./conversation-view"
import { displayName, initials } from "./format"
import { SwipeRow } from "./swipe-row"
import { useMailShortcuts } from "./use-shortcuts"

const LANES: { id: Lane; label: string; empty: string }[] = [
  { id: "inbox", label: "Inbox", empty: "You're all caught up." },
  { id: "unread", label: "Unread", empty: "Nothing unread." },
  { id: "starred", label: "Starred", empty: "Star messages to keep them close." },
  { id: "snoozed", label: "Snoozed", empty: "Snoozed mail waits here until it's time." },
  { id: "archive", label: "Archive", empty: "Archived mail shows up here." },
]

export function MailView() {
  const [lane, setLane] = useState<Lane>("inbox")
  const [accountId, setAccountId] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  // Selection is a conversation. The row is remembered so the reader stays
  // open when the row leaves the current lane (e.g. read mail in "Unread").
  const [selected, setSelected] = useState<MessageSummary | null>(null)
  const selectedId = selected?.threadId ?? null
  const searchRef = useRef<HTMLInputElement>(null)
  const deferredSearch = useDeferredValue(search.trim())

  const { data: core } = useCore()
  const { data: accounts = [] } = useAccounts()
  const { data: messages, isPending } = useMessages({ lane, accountId, search: deferredSearch || null })
  const { data: thread } = useThread(selectedId)
  const openComposer = useUi((s) => s.openComposer)
  const setAccountsOpen = useUi((s) => s.setAccountsOpen)
  const sync = useMailAction<void>((c) => c.syncNow())
  const triage = useTriage(() => setSelected(null))
  const markSeen = triage.markSeen

  const list = messages ?? []
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
  const laneInfo = LANES.find((l) => l.id === lane)!

  useMailShortcuts({
    list,
    selectedId,
    select,
    compose: () => openComposer({ accountId: accountId ?? accounts[0]?.id }),
    focusSearch: () => searchRef.current?.focus(),
    triage,
    selected: row,
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
              <Tabs value={lane} onValueChange={(v) => (setLane(v as Lane), setSelected(null))} className="w-max pr-6">
                <TabsList>
                  {LANES.map((l) => (
                    <TabsTrigger key={l.id} value={l.id}>
                      {l.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </div>
          </div>
        </>
      }
      list={
        isPending ? (
          <ListSkeleton />
        ) : accounts.length === 0 ? (
          <Empty className="py-16">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Icon name="alternate_email" />
              </EmptyMedia>
              <EmptyTitle>Add your first account</EmptyTitle>
              <EmptyDescription>iCloud, Fastmail, or any IMAP account. Gmail and Outlook are coming.</EmptyDescription>
            </EmptyHeader>
            <Button onClick={() => setAccountsOpen(true)}>
              <Icon name="add" data-icon="inline-start" /> Add account
            </Button>
          </Empty>
        ) : list.length === 0 ? (
          <Empty className="py-16">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Icon name={deferredSearch ? "search_off" : "done_all"} />
              </EmptyMedia>
              <EmptyTitle>{deferredSearch ? "No matches" : laneInfo.empty}</EmptyTitle>
              {deferredSearch && <EmptyDescription>Nothing in {laneInfo.label} matches “{deferredSearch}”.</EmptyDescription>}
            </EmptyHeader>
          </Empty>
        ) : (
          <div role="list" aria-label={laneInfo.label}>
            {list.map((m) => (
              <SwipeRow
                key={m.threadId}
                // Apple Mail mapping: swipe left to archive, right to toggle read.
                start={{ icon: m.seen ? "mark_email_unread" : "drafts", label: m.seen ? "Unread" : "Read", tone: "bg-vertical-mail", onCommit: () => triage.toggleSeen(m) }}
                end={{ icon: m.archived ? "unarchive" : "archive", label: m.archived ? "Inbox" : "Archive", tone: "bg-vertical-contacts", onCommit: () => triage.toggleArchive(m) }}
              >
                <MessageRow
                  message={m}
                  lane={lane}
                  selected={m.threadId === selectedId}
                  onSelect={() => setSelected(m)}
                  account={multiAccount && !accountId ? accounts.find((a) => a.id === m.accountId)?.displayName : undefined}
                />
              </SwipeRow>
            ))}
          </div>
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
          />
        )
      }
    />
  )
}

function MessageRow({
  message: m,
  lane,
  selected,
  onSelect,
  account,
}: {
  message: MessageSummary
  lane: Lane
  selected: boolean
  onSelect: () => void
  account?: string
}) {
  const meta = lane === "snoozed" && m.snoozedUntil ? (
    <span className="inline-flex items-center gap-1 text-vertical-notes">
      <Icon name="snooze" className="size-3.5" />
      {shortTime(m.snoozedUntil)}
    </span>
  ) : (
    shortTime(m.sortAt)
  )
  return (
    <ListRow
        selected={selected}
        onSelect={onSelect}
        emphasized={!m.seen}
        leading={
          <Avatar className="mt-0.5">
            <AvatarFallback>{initials(m.from)}</AvatarFallback>
          </Avatar>
        }
        title={
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate">{displayName(m.from)}</span>
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
