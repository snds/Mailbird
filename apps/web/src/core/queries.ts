import { QueryClient, keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect } from "react"

import { getCoreClient, type CoreClient } from "./client"
import type { CollectionKind, MessageQuery, NoteQuery, NoteTarget, SwipeActions } from "./types"

export const queryClient = new QueryClient({
  defaultOptions: {
    // The core pushes change events, so polling and refetch-on-focus are unnecessary.
    queries: { staleTime: Infinity, refetchOnWindowFocus: false, retry: false },
  },
})

const keys = {
  core: ["core"] as const,
  accounts: ["accounts"] as const,
  messages: (q: MessageQuery) => ["messages", q] as const,
  thread: (id: string) => ["thread", id] as const,
  outbox: ["outbox"] as const,
  // Everything calendar and contacts lives under "pim", so one event refreshes it all.
  collections: (kind: CollectionKind) => ["pim", "collections", kind] as const,
  occurrences: (from: number, to: number) => ["pim", "occurrences", from, to] as const,
  event: (id: string, start: number | null) => ["pim", "event", id, start] as const,
  contacts: (search: string, label: string | null, group: string | null) => ["pim", "contacts", search, label, group] as const,
  smartGroups: ["pim", "smart-groups"] as const,
  interesting: ["pim", "interesting"] as const,
  contactLabels: ["pim", "contact-labels"] as const,
  calendarSets: ["pim", "calendar-sets"] as const,
  deletedContacts: ["pim", "contacts-deleted"] as const,
  // A message's signature against your contacts: refreshes with either.
  contactSuggestion: (messageId: string) => ["pim", "suggestion", messageId] as const,
  contact: (id: string) => ["pim", "contact", id] as const,
  // Mail and meetings with a contact: refreshes on "pim" and on mail changes.
  contactActivity: (id: string) => ["pim", "activity", id] as const,
  duplicates: ["pim", "duplicates"] as const,
  // Notes refresh on their own event; links read calendar/contact data, so
  // they refresh with "pim" too (see useCoreEvents).
  notes: (q: NoteQuery) => ["notes", "list", q] as const,
  note: (id: string) => ["notes", "note", id] as const,
  noteTags: ["notes", "tags"] as const,
  // Tasks read notes and their linked events: they refresh with both.
  noteTasks: (done: boolean) => ["notes", "tasks", done] as const,
  notesPrefs: ["notes", "prefs"] as const,
  noteLink: (t: NoteTarget) => ["notes", "link", t.kind, t.id] as const,
  relay: ["notes", "relay"] as const,
  // Templates and signatures refresh together on "compose:changed".
  templates: ["compose", "templates"] as const,
  signatures: ["compose", "signatures"] as const,
}

export function useCore() {
  return useQuery({ queryKey: keys.core, queryFn: getCoreClient })
}

async function call<T>(fn: (c: CoreClient) => Promise<T>) {
  return fn(await getCoreClient())
}

/** Wire core change events to cache invalidation. Mount once near the root. */
export function useCoreEvents() {
  const qc = useQueryClient()
  const { data: core } = useCore()
  useEffect(() => {
    if (!core) return
    const offs = [
      core.on("mail:changed", () => {
        void qc.invalidateQueries({ queryKey: ["messages"] })
        void qc.invalidateQueries({ queryKey: ["thread"] })
        void qc.invalidateQueries({ queryKey: ["pim", "activity"] })
        void qc.invalidateQueries({ queryKey: ["pim", "suggestion"] })
      }),
      core.on("outbox:changed", () => void qc.invalidateQueries({ queryKey: keys.outbox })),
      core.on("accounts:changed", () => void qc.invalidateQueries({ queryKey: keys.accounts })),
      core.on("pim:changed", () => {
        void qc.invalidateQueries({ queryKey: ["pim"] })
        // An invitation in a conversation shows your calendar (its clashes, your answer).
        void qc.invalidateQueries({ queryKey: ["thread"] })
        void qc.invalidateQueries({ queryKey: ["notes", "list"] })
        void qc.invalidateQueries({ queryKey: ["notes", "tasks"] })
      }),
      // The open note's own query stays put: its editor is the live copy.
      core.on("notes:changed", () => void qc.invalidateQueries({ queryKey: ["notes"], predicate: (q) => q.queryKey[1] !== "note" })),
      core.on("compose:changed", () => void qc.invalidateQueries({ queryKey: ["compose"] })),
    ]
    // All-day events sit on the device clock; tell the core which one that is.
    void core.setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone).then(() => qc.invalidateQueries({ queryKey: ["pim"] }))
    return () => offs.forEach((off) => off())
  }, [core, qc])
}

export function useAccounts() {
  return useQuery({ queryKey: keys.accounts, queryFn: () => call((c) => c.listAccounts()) })
}

/** Rows per page of a message list; the next page loads as the list nears its end. */
export const MESSAGE_PAGE = 200

export function useMessages(q: MessageQuery) {
  return useQuery({
    queryKey: keys.messages(q),
    queryFn: () => call((c) => c.listMessages(q)),
    placeholderData: keepPreviousData,
  })
}

/** A long list in pages: the mail list loads more as you scroll. */
export function useMessagePages(q: MessageQuery) {
  return useInfiniteQuery({
    queryKey: [...keys.messages(q), "pages"],
    queryFn: ({ pageParam }) => call((c) => c.listMessages({ ...q, limit: MESSAGE_PAGE, offset: pageParam })),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => (last.length === MESSAGE_PAGE ? pages.length * MESSAGE_PAGE : undefined),
    placeholderData: keepPreviousData, // keep the list on screen while a search refines
  })
}

export function useThread(threadId: string | null) {
  return useQuery({
    queryKey: keys.thread(threadId ?? ""),
    queryFn: () => call((c) => c.getThread(threadId!)),
    enabled: threadId !== null,
  })
}

export function useOutbox() {
  return useQuery({ queryKey: keys.outbox, queryFn: () => call((c) => c.listOutbox()) })
}

export function useTemplates() {
  return useQuery({ queryKey: keys.templates, queryFn: () => call((c) => c.listTemplates()) })
}

export function useSignatures() {
  return useQuery({ queryKey: keys.signatures, queryFn: () => call((c) => c.listSignatures()) })
}

/** Under "messages", so every mail change refreshes them. */
export function useScreener() {
  return useQuery({ queryKey: ["messages", "screener-status"], queryFn: () => call((c) => c.screenerStatus()) })
}

export function useSenders() {
  return useQuery({ queryKey: ["messages", "senders"], queryFn: () => call((c) => c.listSenders()) })
}

/** Messages scheduled to send later, soonest first. */
export function useScheduled() {
  return useQuery({
    queryKey: keys.outbox,
    queryFn: () => call((c) => c.listOutbox()),
    select: (items) => items.filter((i) => i.scheduled && i.state === "queued").sort((a, b) => a.sendAt - b.sendAt),
  })
}

/** A mutation that refreshes mail lists afterwards. */
export function useMailAction<A>(fn: (c: CoreClient, args: A) => Promise<unknown>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (args: A) => call((c) => fn(c, args)),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["messages"] })
      void qc.invalidateQueries({ queryKey: ["thread"] })
    },
  })
}

export function useCollections(kind: CollectionKind) {
  return useQuery({ queryKey: keys.collections(kind), queryFn: () => call((c) => c.listCollections(kind)) })
}

export function useOccurrences(from: number, to: number) {
  return useQuery({
    queryKey: keys.occurrences(from, to),
    queryFn: () => call((c) => c.listOccurrences(from, to)),
    placeholderData: (prev) => prev, // no flash while paging weeks
  })
}

export function useEvent(id: string | null, start: number | null) {
  return useQuery({
    queryKey: keys.event(id ?? "", start),
    queryFn: () => call((c) => c.getEvent(id!, start)),
    enabled: id !== null,
  })
}

export function useContacts(search: string, label: string | null = null, group: string | null = null) {
  return useQuery({
    queryKey: keys.contacts(search, label, group),
    queryFn: () => call((c) => c.listContacts(search || null, label, group)),
    placeholderData: (prev) => prev,
  })
}

// Under "messages", so mail changes refresh them too.
export function useSplits() {
  return useQuery({ queryKey: ["messages", "splits"], queryFn: () => call((c) => c.listSplits()) })
}

export function useInboxOverview(accountId: string | null) {
  return useQuery({ queryKey: ["messages", "overview", accountId], queryFn: () => call((c) => c.inboxOverview(accountId)) })
}

export function useCalendarSets() {
  return useQuery({ queryKey: keys.calendarSets, queryFn: () => call((c) => c.calendarSets()) })
}

export function useContactLabels() {
  return useQuery({ queryKey: keys.contactLabels, queryFn: () => call((c) => c.contactLabels()) })
}

/** Your swipe mapping; shared by every browser on the gateway (ADR-0025). */
export function useSwipeActions() {
  return useQuery({ queryKey: ["settings", "swipes"], queryFn: () => call((c) => c.swipeActions()), staleTime: Infinity })
}

export function useSetSwipeActions() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (a: SwipeActions) => call((c) => c.setSwipeActions(a)),
    onSuccess: (a) => qc.setQueryData(["settings", "swipes"], a),
  })
}

export function useBookingLinks() {
  return useQuery({ queryKey: ["pim", "booking-links"], queryFn: () => call((c) => c.bookingLinks()) })
}

export function useInterestingCalendars() {
  return useQuery({ queryKey: keys.interesting, queryFn: () => call((c) => c.interestingCalendars()) })
}

export function useSmartGroups() {
  return useQuery({ queryKey: keys.smartGroups, queryFn: () => call((c) => c.smartGroups()) })
}

export function useContactCopies(id: string) {
  return useQuery({ queryKey: ["pim", "contact-copies", id], queryFn: () => call((c) => c.contactCopies(id)) })
}

/** Faces for mail: contact photos by lowercase email address. */
export function useContactPhotos() {
  return useQuery({ queryKey: ["pim", "contact-photos"], queryFn: () => call((c) => c.contactPhotos()), staleTime: 60_000 })
}

export function useDeletedContacts() {
  return useQuery({ queryKey: keys.deletedContacts, queryFn: () => call((c) => c.deletedContacts()) })
}

export function useContactSuggestion(messageId: string | null) {
  return useQuery({ queryKey: keys.contactSuggestion(messageId ?? ""), queryFn: () => call((c) => c.contactSuggestion(messageId!)), enabled: messageId !== null })
}

export function useContact(id: string | null) {
  return useQuery({ queryKey: keys.contact(id ?? ""), queryFn: () => call((c) => c.getContact(id!)), enabled: id !== null })
}

export function useContactActivity(id: string) {
  return useQuery({ queryKey: keys.contactActivity(id), queryFn: () => call((c) => c.contactActivity(id)) })
}

export function useDuplicates() {
  return useQuery({ queryKey: keys.duplicates, queryFn: () => call((c) => c.duplicateContacts()) })
}

/** A mutation that refreshes calendars and contacts afterwards. */
export function usePimAction<A, R = unknown>(fn: (c: CoreClient, args: A) => Promise<R>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (args: A) => call((c) => fn(c, args)),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["pim"] }),
  })
}

export function useNotes(q: NoteQuery) {
  return useQuery({ queryKey: keys.notes(q), queryFn: () => call((c) => c.listNotes(q)), placeholderData: (prev) => prev })
}

/** Read once per open: after that, the editor (and its Yjs document) is the source of truth. */
export function useNote(id: string | null) {
  return useQuery({ queryKey: keys.note(id ?? ""), queryFn: () => call((c) => c.getNote(id!)), enabled: id !== null, gcTime: 0 })
}

export function useNoteTags() {
  return useQuery({ queryKey: keys.noteTags, queryFn: () => call((c) => c.noteTags()) })
}

/** Checklist items across notes (ADR-0028). */
export function useNoteTasks(done = false) {
  return useQuery({ queryKey: keys.noteTasks(done), queryFn: () => call((c) => c.noteTasks(done)) })
}

export function useNotesPrefs() {
  return useQuery({ queryKey: keys.notesPrefs, queryFn: () => call((c) => c.notesPrefs()), staleTime: Infinity })
}

/** Notes linked to an event, contact, or conversation. */
export function useLinkedNotes(target: NoteTarget | null) {
  return useQuery({
    queryKey: keys.notes({ linked: target }),
    queryFn: () => call((c) => c.listNotes({ linked: target })),
    enabled: target !== null,
  })
}

export function useNotesRelay() {
  return useQuery({ queryKey: keys.relay, queryFn: () => call((c) => c.getNotesRelay()) })
}

/** A mutation that refreshes note lists afterwards. */
export function useNoteAction<A, R = unknown>(fn: (c: CoreClient, args: A) => Promise<R>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (args: A) => call((c) => fn(c, args)),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["notes"], predicate: (q) => q.queryKey[1] !== "note" }),
  })
}
