import { QueryClient, keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect } from "react"

import { fromBase64 } from "@/lib/base64"

import { getCoreClient, type CoreClient } from "./client"
import type { CollectionKind, KeyBindings, MessageQuery, NoteQuery, NoteTarget, SwipeActions } from "./types"

export const queryClient = new QueryClient({
  defaultOptions: {
    // The core pushes change events, so polling and refetch-on-focus are unnecessary.
    queries: { staleTime: Infinity, refetchOnWindowFocus: false, retry: false },
  },
})

// Note images are blob URLs (ADR-0044): freed when their query leaves the cache.
queryClient.getQueryCache().subscribe((e) => {
  const k = e.query.queryKey
  if (e.type === "removed" && k[0] === "notes" && k[1] === "file") {
    const url = (e.query.state.data as { url?: string } | undefined)?.url
    if (url) URL.revokeObjectURL(url)
  }
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
  noteBacklinks: (id: string) => ["notes", "backlinks", id] as const,
  noteGraph: (q: NoteQuery) => ["notes", "graph", q] as const,
  noteTags: ["notes", "tags"] as const,
  // Tasks read notes and their linked events: they refresh with both.
  noteTasks: (done: boolean) => ["notes", "tasks", done] as const,
  notesPrefs: ["notes", "prefs"] as const,
  noteFolders: ["notes", "folders"] as const,
  notesLock: ["notes", "lock"] as const,
  lockedNote: (id: string) => ["notes", "locked", id] as const,
  noteFile: (id: string) => ["notes", "file", id] as const,
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
      // The open note's own query stays put: its editor is the live copy. A
      // shown image does too (ADR-0044): its bytes don't change with an edit,
      // and reloading would flicker. One that failed (not synced yet) retries.
      core.on("notes:changed", () =>
        void qc.invalidateQueries({ queryKey: ["notes"], predicate: (q) => q.queryKey[1] !== "note" && !(q.queryKey[1] === "file" && q.state.status === "success") }),
      ),
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

/** Your single keys; shared like swipes (ADR-0032). */
export function useKeyBindings() {
  return useQuery({ queryKey: ["settings", "keys"], queryFn: () => call((c) => c.keyBindings()), staleTime: Infinity })
}

export function useSetKeyBindings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (b: KeyBindings) => call((c) => c.setKeyBindings(b)),
    onSuccess: (b) => qc.setQueryData(["settings", "keys"], b),
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

/** The clocks of the people you're writing to (ADR-0041); refreshes with mail. */
export function useLocalTimes(emails: string[]) {
  return useQuery({
    queryKey: ["pim", "activity", "local-times", emails],
    queryFn: () => call((c) => c.localTimes(emails)),
    enabled: emails.length > 0,
    placeholderData: keepPreviousData,
  })
}

/** Who sent mail from an address (ADR-0036); refreshes with mail and contacts. */
export function useSenderProfile(email: string | null) {
  return useQuery({ queryKey: ["pim", "activity", "sender", email], queryFn: () => call((c) => c.senderProfile(email!)), enabled: !!email })
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

/** The notes `q` lists, as a map (ADR-0053). Only fetched while the map shows. */
export function useNoteGraph(q: NoteQuery, enabled: boolean) {
  return useQuery({ queryKey: keys.noteGraph(q), queryFn: () => call((c) => c.noteGraph(q)), enabled, placeholderData: (prev) => prev })
}

/** Read once per open: after that, the editor (and its Yjs document) is the source of truth. */
/** Notes that link to this one with `[[its title]]` (ADR-0034). */
export function useNoteBacklinks(id: string) {
  return useQuery({ queryKey: keys.noteBacklinks(id), queryFn: () => call((c) => c.noteBacklinks(id)) })
}

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

export function useMeetingPrefs() {
  return useQuery({ queryKey: ["pim", "meeting-prefs"], queryFn: () => call((c) => c.meetingPrefs()), staleTime: Infinity })
}

/** Whether locked notes have a passphrase and are open now (ADR-0043). */
export function useNotesLock() {
  return useQuery({ queryKey: keys.notesLock, queryFn: () => call((c) => c.notesLock()) })
}

/**
 * An image in a note, as a blob URL (ADR-0044). Images don't change once
 * stored, but a sealed one reads again when notes lock or unlock.
 */
export function useNoteFile(id: string | null) {
  return useQuery({
    queryKey: keys.noteFile(id ?? ""),
    queryFn: async () => {
      const f = await call((c) => c.noteFile(id!))
      return { mime: f.mime, text: f.text ?? null, url: URL.createObjectURL(new Blob([fromBase64(f.dataBase64)], { type: f.mime })) }
    },
    enabled: !!id,
    staleTime: Infinity,
    retry: false,
  })
}

/** A locked note's text while notes are unlocked; null while they're locked. */
export function useLockedNote(id: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.lockedNote(id),
    queryFn: () => call((c) => c.openLockedNote(id)),
    enabled,
    // Never kept past the moment it's needed: it's the note's plain text.
    gcTime: 0,
    staleTime: Infinity,
    retry: false,
  })
}

/** Smart folders with live counts (ADR-0042); refresh with notes. */
export function useNoteFolders() {
  return useQuery({ queryKey: keys.noteFolders, queryFn: () => call((c) => c.noteFolders()) })
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
