import type {
  Account,
  AccountConfig,
  Address,
  Capabilities,
  Collection,
  CollectionKind,
  ContactDetail,
  ContactInput,
  ContactSummary,
  DavConfig,
  EditScope,
  Draft,
  EventDetail,
  EventInput,
  Invite,
  InviteResponse,
  Occurrence,
  MessageDetail,
  MessageQuery,
  MessageSummary,
  OutboxItem,
  Provider,
} from "./types"

/**
 * The one API the UI uses to reach the core, whatever the shell.
 * - Tauri (desktop now, mobile next): IPC into the Rust core in-process.
 * - Browser: an in-memory demo until the self-hosted gateway exists (ADR-0002).
 */
export interface CoreClient {
  /** "native" can connect real accounts; "demo" runs on sample data. */
  readonly kind: "native" | "demo"
  providerCapabilities(provider: Provider): Promise<Capabilities>
  listAccounts(): Promise<Account[]>
  /** `davPassword` only when CalDAV needs its own app password. */
  addAccount(config: AccountConfig, password: string, davPassword?: string | null): Promise<Account>
  /** Connect (or, with null, disconnect) calendars and contacts. */
  setAccountDav(id: string, dav: DavConfig | null, password?: string | null): Promise<Account>
  removeAccount(id: string): Promise<void>
  syncNow(): Promise<void>
  listMessages(query: MessageQuery): Promise<MessageSummary[]>
  /** A whole conversation, oldest first. */
  getThread(threadId: string): Promise<MessageDetail[]>
  // Triage acts on conversations, like Gmail and Apple Mail.
  setThreadSeen(threadId: string, seen: boolean): Promise<void>
  setThreadFlagged(threadId: string, flagged: boolean): Promise<void>
  setThreadArchived(threadId: string, archived: boolean): Promise<void>
  snoozeThread(threadId: string, until: number): Promise<void>
  unsnoozeThread(threadId: string): Promise<void>
  /** Save to Downloads and open it. Returns where it was saved, if anywhere. */
  openAttachment(id: string): Promise<string | null>
  /** The decoded bytes, for in-app preview. */
  attachmentData(id: string): Promise<ArrayBuffer>
  queueSend(draft: Draft, undoSecs: number): Promise<OutboxItem>
  cancelSend(id: string): Promise<Draft>
  listOutbox(): Promise<OutboxItem[]>
  // Calendars and contacts
  setTimeZone(tz: string): Promise<void>
  listCollections(kind: CollectionKind): Promise<Collection[]>
  setCollectionHidden(id: string, hidden: boolean): Promise<void>
  /** Occurrences overlapping [from, to), in seconds. */
  listOccurrences(from: number, to: number): Promise<Occurrence[]>
  /** One event at the occurrence starting at `start` (or its first). */
  getEvent(id: string, start?: number | null): Promise<EventDetail>
  createEvent(input: EventInput): Promise<EventDetail>
  /** For a series, `scope` picks the occurrences; `occurrence` is the one's `originalStart`. */
  updateEvent(id: string, input: EventInput, scope?: EditScope, occurrence?: number | null): Promise<EventDetail>
  deleteEvent(id: string, occurrence?: number | null, scope?: EditScope): Promise<void>
  /** Guests of an event you organize (you excluded). */
  eventGuests(id: string): Promise<Address[]>
  respondToInvite(messageId: string, response: InviteResponse, calendarId?: string | null): Promise<Invite>
  /** Applies a cancellation or a guest's reply. */
  applyInviteUpdate(messageId: string): Promise<Invite>
  listContacts(search?: string | null): Promise<ContactSummary[]>
  getContact(id: string): Promise<ContactDetail>
  createContact(input: ContactInput): Promise<ContactDetail>
  updateContact(id: string, input: ContactInput): Promise<ContactDetail>
  deleteContact(id: string): Promise<void>
  duplicateContacts(): Promise<ContactSummary[][]>
  mergeContacts(primary: string, others: string[]): Promise<ContactDetail>
  suggestRecipients(prefix: string): Promise<Address[]>
  syncPimNow(): Promise<void>
  /** Subscribe to core change events; returns an unsubscribe function. */
  on(event: CoreEvent, handler: (payload?: unknown) => void): () => void
}

export type CoreEvent = "mail:changed" | "outbox:changed" | "accounts:changed" | "pim:changed" | "reminder"

export const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window

async function createTauriClient(): Promise<CoreClient> {
  const { invoke } = await import("@tauri-apps/api/core")
  const { listen } = await import("@tauri-apps/api/event")
  // Tauri maps camelCase argument names to the Rust commands' snake_case.
  return {
    kind: "native",
    providerCapabilities: (provider) => invoke("provider_capabilities", { provider }),
    listAccounts: () => invoke("list_accounts"),
    addAccount: (config, password, davPassword) => invoke("add_account", { config, password, davPassword: davPassword ?? null }),
    setAccountDav: (id, dav, password) => invoke("set_account_dav", { id, dav, password: password ?? null }),
    removeAccount: (id) => invoke("remove_account", { id }),
    syncNow: () => invoke("sync_now"),
    listMessages: (query) => invoke("list_messages", { query }),
    getThread: (threadId) => invoke("get_thread", { threadId }),
    setThreadSeen: (threadId, seen) => invoke("set_thread_seen", { threadId, seen }),
    setThreadFlagged: (threadId, flagged) => invoke("set_thread_flagged", { threadId, flagged }),
    setThreadArchived: (threadId, archived) => invoke("set_thread_archived", { threadId, archived }),
    snoozeThread: (threadId, until) => invoke("snooze_thread", { threadId, until }),
    unsnoozeThread: (threadId) => invoke("unsnooze_thread", { threadId }),
    openAttachment: (id) => invoke("open_attachment", { id }),
    attachmentData: (id) => invoke<ArrayBuffer>("attachment_data", { id }),
    queueSend: (draft, undoSecs) => invoke("queue_send", { draft, undoSecs }),
    cancelSend: (id) => invoke("cancel_send", { id }),
    listOutbox: () => invoke("list_outbox"),
    setTimeZone: (tz) => invoke("set_time_zone", { tz }),
    listCollections: (kind) => invoke("list_collections", { kind }),
    setCollectionHidden: (id, hidden) => invoke("set_collection_hidden", { id, hidden }),
    listOccurrences: (from, to) => invoke("list_occurrences", { from, to }),
    getEvent: (id, start) => invoke("get_event", { id, start: start ?? null }),
    createEvent: (input) => invoke("create_event", { input }),
    updateEvent: (id, input, scope, occurrence) => invoke("update_event", { id, input, scope: scope ?? null, occurrence: occurrence ?? null }),
    deleteEvent: (id, occurrence, scope) => invoke("delete_event", { id, occurrence: occurrence ?? null, scope: scope ?? null }),
    eventGuests: (id) => invoke("event_guests", { id }),
    respondToInvite: (messageId, response, calendarId) => invoke("respond_to_invite", { messageId, response, calendarId: calendarId ?? null }),
    applyInviteUpdate: (messageId) => invoke("apply_invite_update", { messageId }),
    listContacts: (search) => invoke("list_contacts", { search: search ?? null }),
    getContact: (id) => invoke("get_contact", { id }),
    createContact: (input) => invoke("create_contact", { input }),
    updateContact: (id, input) => invoke("update_contact", { id, input }),
    deleteContact: (id) => invoke("delete_contact", { id }),
    duplicateContacts: () => invoke("duplicate_contacts"),
    mergeContacts: (primary, others) => invoke("merge_contacts", { primary, others }),
    suggestRecipients: (prefix) => invoke("suggest_recipients", { prefix }),
    syncPimNow: () => invoke("sync_pim_now"),
    on(event, handler) {
      let off: (() => void) | undefined
      let cancelled = false
      void listen(event, (e) => handler(e.payload)).then((unlisten) => {
        if (cancelled) unlisten()
        else off = unlisten
      })
      return () => {
        cancelled = true
        off?.()
      }
    },
  }
}

let clientPromise: Promise<CoreClient> | null = null

export function getCoreClient(): Promise<CoreClient> {
  clientPromise ??= isTauri()
    ? createTauriClient()
    : import("./demo").then((m) => m.createDemoClient())
  return clientPromise
}
