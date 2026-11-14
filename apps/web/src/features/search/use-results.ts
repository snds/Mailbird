import { keepPreviousData, useInfiniteQuery, useQueries, useQuery } from "@tanstack/react-query"
import { useMemo } from "react"

import { getCoreClient, type CoreClient } from "@/core/client"
import { MESSAGE_PAGE, useScreener } from "@/core/queries"
import type { ContactSummary, Lane, MessageQuery, MessageSummary, NoteQuery, NoteSummary, Occurrence } from "@/core/types"
import { DAY, fromSecs, secs, startOfDay } from "@/features/calendar/dates"
import type { MailTab } from "@/features/mail/lanes"

/**
 * What Search finds, by kind (ADR-0085; brief X2). Every read is one the
 * sections already make, under the same cache keys, so a result list and its
 * section never disagree and a change event refreshes both. Each hook is
 * idle until it is `on`: nothing is read before there are words.
 */

/** One kind's results, as the Search screen lists them. */
export interface Results<T> {
  rows: T[]
  /** Reading for the first time, with nothing to show yet. */
  pending: boolean
  /** The read failed and there is nothing to show from before. */
  failed: boolean
  /** More rows are a fetch away (a lane with more than a page). */
  more?: () => void
  /** Every row the query has is in `rows`, so their number is the count. */
  complete: boolean
  again: () => void
}

const core = <T,>(fn: (c: CoreClient) => Promise<T>) => getCoreClient().then(fn)

/** Search inside one lane of Mail: the read the lane's own search field made. "Assigned to me" is the inbox, narrowed to you. */
export function useLaneResults(tab: MailTab | null, accountId: string | null, me: string, query: string, on: boolean): Results<MessageSummary> {
  const lane: Lane = tab === null || tab === "scheduled" || tab === "team" || tab === "mine" ? "inbox" : tab
  const q: MessageQuery = { lane, accountId, search: query || null, category: null, split: null, bundle: false, assignedTo: tab === "mine" ? me : null }
  const { data, isPending, isError, hasNextPage, isFetchingNextPage, fetchNextPage, refetch } = useInfiniteQuery({
    queryKey: ["messages", q, "pages"],
    queryFn: ({ pageParam }) => core((c) => c.listMessages({ ...q, limit: MESSAGE_PAGE, offset: pageParam })),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => (last.length === MESSAGE_PAGE ? pages.length * MESSAGE_PAGE : undefined),
    placeholderData: keepPreviousData,
    enabled: on,
  })
  const rows = useMemo(() => data?.pages.flat() ?? [], [data])
  return {
    rows,
    pending: on && isPending,
    failed: on && isError && !data,
    more: hasNextPage && !isFetchingNextPage ? () => void fetchNextPage() : undefined,
    complete: !!data && !hasNextPage,
    again: () => void refetch(),
  }
}

/** The lanes that between them hold every conversation. Unread is part of the Inbox; the Screener counts only while it is on. */
const EVERY_LANE: Lane[] = ["inbox", "snoozed", "archive", "waiting", "starred"]

/**
 * Search in all mail: the same read in each lane, joined newest first, one
 * row per conversation. Each lane gives its first page; a lane with more
 * leaves the count unknown.
 */
export function useMailResults(accountId: string | null, query: string, on: boolean): Results<MessageSummary> {
  const { data: screener } = useScreener()
  const lanes = screener?.enabled ? [...EVERY_LANE, "screener" as Lane] : EVERY_LANE
  return useQueries({
    queries: lanes.map((lane) => {
      const q: MessageQuery = { lane, accountId, search: query || null, limit: MESSAGE_PAGE }
      return { queryKey: ["messages", q], queryFn: () => core((c) => c.listMessages(q)), placeholderData: keepPreviousData, enabled: on }
    }),
    // Joined once per change of any lane's list (the query client keeps the result while they stand).
    combine: (found): Results<MessageSummary> => {
      const seen = new Set<string>()
      const rows = found
        .flatMap((f) => f.data ?? [])
        .sort((a, b) => b.sortAt - a.sortAt)
        .filter((m) => !seen.has(m.threadId) && seen.add(m.threadId))
      return {
        rows,
        pending: on && found.some((f) => f.isPending),
        failed: on && found.some((f) => f.isError) && rows.length === 0,
        complete: found.every((f) => f.data && f.data.length < MESSAGE_PAGE),
        again: () => found.forEach((f) => void f.refetch()),
      }
    },
  })
}

/** How far the calendar is searched: the core lists occurrences by range, so a range it is. */
export const EVENT_DAYS = { back: 30, ahead: 90 }

/** A text with case and accents set aside, to compare words. */
const plain = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()

/** Events whose title or place holds every word, from 30 days back to 90 ahead: what is coming first, soonest first, then what has passed. */
export function useEventResults(query: string, now: number, on: boolean): Results<Occurrence> {
  // The range moves with the day, not the minute, so the read is shared and kept.
  const today = secs(startOfDay(fromSecs(now)))
  const from = today - EVENT_DAYS.back * DAY
  const to = today + (EVENT_DAYS.ahead + 1) * DAY
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ["pim", "occurrences", from, to],
    queryFn: () => core((c) => c.listOccurrences(from, to)),
    placeholderData: keepPreviousData,
    enabled: on,
  })
  const rows = useMemo(() => {
    const words = plain(query).split(/\s+/).filter(Boolean)
    if (!data || !words.length) return []
    const hits = data.filter((o) => {
      const text = plain(`${o.title} ${o.location ?? ""}`)
      return words.every((w) => text.includes(w))
    })
    const coming = hits.filter((o) => o.end >= today).sort((a, b) => a.start - b.start)
    const passed = hits.filter((o) => o.end < today).sort((a, b) => b.start - a.start)
    return [...coming, ...passed]
  }, [data, query, today])
  return { rows, pending: on && isPending, failed: on && isError && !data, complete: !!data, again: () => void refetch() }
}

/** People by name, address, company: the read the contacts list's own search field made, across every group. */
export function useContactResults(query: string, on: boolean): Results<ContactSummary> {
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ["pim", "contacts", query, null, null],
    queryFn: () => core((c) => c.listContacts(query || null, null, null)),
    placeholderData: keepPreviousData,
    enabled: on,
  })
  return { rows: data ?? [], pending: on && isPending, failed: on && isError && !data, complete: !!data, again: () => void refetch() }
}

/**
 * Notes by their text, text found in their images included: the read the
 * notes list's own search field made, in every folder. Archived notes come
 * last, since the old field found them only inside the Archive.
 */
export function useNoteResults(query: string, on: boolean): Results<NoteSummary> {
  const read = (archived: boolean) => {
    const q: NoteQuery = { search: query || null, tag: null, archived, folder: null }
    return { queryKey: ["notes", "list", q], queryFn: () => core((c) => c.listNotes(q)), placeholderData: keepPreviousData, enabled: on }
  }
  const kept = useQuery(read(false))
  const archived = useQuery(read(true))
  const rows = useMemo(() => [...(kept.data ?? []), ...(archived.data ?? [])], [kept.data, archived.data])
  return {
    rows,
    pending: on && (kept.isPending || archived.isPending),
    failed: on && (kept.isError || archived.isError) && rows.length === 0,
    complete: !!kept.data && !!archived.data,
    again: () => (void kept.refetch(), void archived.refetch()),
  }
}
