import { downloadVcard } from "@/lib/download"

import type {
  Account,
  AccountConfig,
  Address,
  Capabilities,
  Collection,
  CollectionKind,
  CalendarSet,
  InboxOverview,
  Split,
  SplitInput,
  ContactActivity,
  FindTimes,
  TimeSlot,
  ContactExport,
  ContactLabel,
  ContactsRestore,
  InterestingCalendar,
  SwipeActions,
  ContactsRestored,
  SmartGroup,
  SmartGroupInput,
  ContactSuggestion,
  DeletedContact,
  SignatureCard,
  DueReminder,
  ContactDetail,
  ContactInput,
  ContactSummary,
  DavConfig,
  EditScope,
  Draft,
  EventDetail,
  EventInput,
  ImportFile,
  ImportReport,
  Invite,
  InviteResponse,
  NoteDetail,
  OAuthClientInfo,
  OAuthIssuer,
  PushSettings,
  PushSettingsInput,
  NoteInput,
  NoteLink,
  NoteMeta,
  NoteQuery,
  NoteRecord,
  NoteSummary,
  NoteTarget,
  RelayConfig,
  TagCount,
  Occurrence,
  MessageDetail,
  MessageQuery,
  MessageSummary,
  OutboxItem,
  Provider,
  ScreenerStatus,
  Sender,
  SenderDecision,
  Category,
  Signature,
  Template,
  TemplateInput,
  UnsubscribeMethod,
} from "./types"

/**
 * The one API the UI uses to reach the core, whatever the shell.
 * - Tauri (desktop now, mobile next): IPC into the Rust core in-process.
 * - Browser on a web gateway: the same commands over HTTPS (ADR-0016).
 * - Browser anywhere else: an in-memory demo on sample mail.
 */
export interface CoreClient {
  /** "native" can connect real accounts; "demo" runs on sample data. */
  readonly kind: "native" | "demo"
  /** Talking to a web gateway over HTTPS rather than an in-process core (ADR-0016). */
  readonly remote: boolean
  providerCapabilities(provider: Provider): Promise<Capabilities>
  listAccounts(): Promise<Account[]>
  /** `davPassword` only when CalDAV needs its own app password. */
  addAccount(config: AccountConfig, password: string, davPassword?: string | null): Promise<Account>
  /** Connect (or, with null, disconnect) calendars and contacts. */
  setAccountDav(id: string, dav: DavConfig | null, password?: string | null): Promise<Account>
  removeAccount(id: string): Promise<void>
  // Browser sign-in (OAuth)
  getOAuthClient(issuer: OAuthIssuer): Promise<OAuthClientInfo | null>
  /** Sets this app's own OAuth client; null goes back to the built-in one. */
  setOAuthClient(issuer: OAuthIssuer, client: { clientId: string; clientSecret?: string | null } | null): Promise<void>
  /** Opens the provider's sign-in page in the browser and waits for it. */
  addOAuthAccount(issuer: OAuthIssuer, loginHint?: string | null): Promise<Account>
  reauthOAuthAccount(id: string): Promise<Account>
  cancelOAuthSignIn(): Promise<void>
  // New mail on phones: periodic checks, or a self-hosted push relay
  getPushSettings(): Promise<PushSettings>
  setPushSettings(input: PushSettingsInput): Promise<PushSettings>
  sendTestPush(): Promise<void>
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
  /** With `sendAt` (seconds), the message is scheduled instead of waiting out the undo window. */
  queueSend(draft: Draft, undoSecs: number, sendAt?: number | null): Promise<OutboxItem>
  cancelSend(id: string): Promise<Draft>
  listOutbox(): Promise<OutboxItem[]>
  /** Move a waiting message to another time; null sends it now. */
  rescheduleSend(id: string, sendAt: number | null): Promise<OutboxItem>
  // Follow-ups, unsubscribe, templates, signatures (ADR-0017)
  setFollowUp(threadId: string, dueAt: number): Promise<void>
  cancelFollowUp(threadId: string): Promise<void>
  unsubscribe(messageId: string): Promise<UnsubscribeMethod>
  listTemplates(): Promise<Template[]>
  saveTemplate(input: TemplateInput): Promise<Template>
  deleteTemplate(id: string): Promise<void>
  listSignatures(): Promise<Signature[]>
  /** An empty signature removes it. */
  setSignature(accountId: string, html: string): Promise<void>
  // The Screener and senders (ADR-0018)
  screenerStatus(): Promise<ScreenerStatus>
  setScreener(enabled: boolean): Promise<ScreenerStatus>
  /** null forgets the decision. */
  decideSender(email: string, decision: SenderDecision | null): Promise<void>
  /** null goes back to what the headers say. */
  setSenderCategory(email: string, category: Category | null): Promise<void>
  listSenders(): Promise<Sender[]>
  // Calendars and contacts
  setTimeZone(tz: string): Promise<void>
  listCollections(kind: CollectionKind): Promise<Collection[]>
  setCollectionHidden(id: string, hidden: boolean): Promise<void>
  interestingCalendars(): Promise<InterestingCalendar[]>
  swipeActions(): Promise<SwipeActions>
  setSwipeActions(actions: SwipeActions): Promise<SwipeActions>
  addInterestingCalendar(id: string): Promise<void>
  removeInterestingCalendar(id: string): Promise<void>
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
  listContacts(search?: string | null, label?: string | null, group?: string | null): Promise<ContactSummary[]>
  smartGroups(): Promise<SmartGroup[]>
  saveSmartGroup(id: string | null, input: SmartGroupInput): Promise<SmartGroup>
  deleteSmartGroup(id: string): Promise<void>
  /** `since` (Unix seconds) or `after` (a restore's mark, to undo it). */
  contactsRestorePreview(point: { since?: number; after?: number }): Promise<ContactsRestore>
  restoreContacts(point: { since?: number; after?: number }): Promise<ContactsRestored>
  contactLabels(): Promise<ContactLabel[]>
  /** Recently deleted, newest first (30 days). */
  deletedContacts(): Promise<DeletedContact[]>
  restoreContact(id: string): Promise<ContactDetail>
  contactVcard(id: string): Promise<ContactExport>
  /** Saves the card as a .vcf file; says where it went. */
  saveContactVcard(id: string): Promise<string>
  /** An SVG QR code of a short card. */
  contactQr(id: string): Promise<string>
  /** A new contact, or missing details, from a message's signature. */
  contactSuggestion(messageId: string): Promise<ContactSuggestion | null>
  parseSignature(text: string): Promise<SignatureCard>
  getContact(id: string): Promise<ContactDetail>
  /** Recent conversations and meetings with this contact. */
  contactActivity(id: string): Promise<ContactActivity>
  /** Reminders that came due while the app was closed; each is returned once. */
  takeMissedReminders(): Promise<DueReminder[]>
  listSplits(): Promise<Split[]>
  /** Adds a split, or changes the one with `id`. */
  saveSplit(id: string | null, input: SplitInput): Promise<Split>
  deleteSplit(id: string): Promise<Split[]>
  moveSplit(id: string, index: number): Promise<Split[]>
  /** Split tab counts and the newsletter bundle. */
  inboxOverview(accountId?: string | null): Promise<InboxOverview>
  bundleMarkRead(accountId?: string | null): Promise<number>
  /** Archives the bundle; returns the message ids for Undo. */
  bundleArchive(accountId?: string | null): Promise<string[]>
  unarchiveBundle(keys: string[]): Promise<void>
  /** Sends the organizer another time (iTIP COUNTER). */
  proposeTime(messageId: string, start: number, end: number, comment?: string | null): Promise<Invite>
  /** Takes a guest's proposed time: moves your event and tells everyone. */
  acceptCounter(messageId: string): Promise<Invite>
  /** Keeps the original time and tells the guest. */
  declineCounter(messageId: string): Promise<Invite>
  /** Free times in your visible calendars. */
  findTimes(q: FindTimes): Promise<TimeSlot[]>
  calendarSets(): Promise<CalendarSet[]>
  /** Saves the calendars showing now under `name` (replacing a set with that name). */
  saveCalendarSet(name: string): Promise<CalendarSet[]>
  deleteCalendarSet(id: string): Promise<CalendarSet[]>
  /** Shows exactly the set's calendars. */
  applyCalendarSet(id: string): Promise<void>
  createContact(input: ContactInput): Promise<ContactDetail>
  updateContact(id: string, input: ContactInput): Promise<ContactDetail>
  deleteContact(id: string): Promise<void>
  duplicateContacts(): Promise<ContactSummary[][]>
  mergeContacts(primary: string, others: string[]): Promise<ContactDetail>
  suggestRecipients(prefix: string): Promise<Address[]>
  syncPimNow(): Promise<void>
  // Notes
  listNotes(query: NoteQuery): Promise<NoteSummary[]>
  getNote(id: string): Promise<NoteDetail>
  createNote(input: NoteInput): Promise<NoteDetail>
  /** Markdown plus the editor's Yjs state. `touch: false` stores another device's text without marking it edited. */
  saveNoteBody(id: string, markdown: string, ydoc: string | null, touch: boolean): Promise<void>
  setNoteMeta(id: string, meta: NoteMeta): Promise<NoteSummary>
  deleteNote(id: string): Promise<void>
  restoreNote(id: string): Promise<void>
  noteTags(): Promise<TagCount[]>
  /** The link to put on a note for something on this device. */
  noteLinkFor(target: NoteTarget): Promise<NoteLink | null>
  importNotes(files: ImportFile[]): Promise<ImportReport>
  noteRecords(): Promise<NoteRecord[]>
  /** Applies newer records from other devices; returns the ids that changed. */
  applyNoteRecords(records: NoteRecord[]): Promise<string[]>
  getNotesRelay(): Promise<RelayConfig | null>
  setNotesRelay(relay: RelayConfig | null): Promise<void>
  /** Subscribe to core change events; returns an unsubscribe function. */
  on(event: CoreEvent, handler: (payload?: unknown) => void): () => void
}

export type CoreEvent = "mail:changed" | "outbox:changed" | "accounts:changed" | "pim:changed" | "notes:changed" | "compose:changed" | "reminder"

export const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window

/** Calls one core command by name (Rust's snake_case) with camelCase arguments. */
type Call = <T>(name: string, args?: Record<string, unknown>) => Promise<T>

/** Every command, over whichever transport `call` uses (ADR-0016). */
function commands(call: Call): Omit<CoreClient, "kind" | "remote" | "on"> {
  return {
    providerCapabilities: (provider) => call("provider_capabilities", { provider }),
    listAccounts: () => call("list_accounts"),
    addAccount: (config, password, davPassword) => call("add_account", { config, password, davPassword: davPassword ?? null }),
    setAccountDav: (id, dav, password) => call("set_account_dav", { id, dav, password: password ?? null }),
    removeAccount: (id) => call("remove_account", { id }),
    getOAuthClient: (issuer) => call("get_oauth_client", { issuer }),
    setOAuthClient: (issuer, client) => call("set_oauth_client", { issuer, client }),
    addOAuthAccount: (issuer, loginHint) => call("add_oauth_account", { issuer, loginHint: loginHint ?? null }),
    reauthOAuthAccount: (id) => call("reauth_oauth_account", { id }),
    cancelOAuthSignIn: () => call("cancel_oauth_sign_in"),
    getPushSettings: () => call("get_push_settings"),
    setPushSettings: (input) =>
      call("set_push_settings", { mode: input.mode, relayUrl: input.relayUrl ?? null, relayToken: input.relayToken ?? null, unifiedPushEndpoint: input.unifiedPushEndpoint ?? null }),
    sendTestPush: () => call("send_test_push"),
    syncNow: () => call("sync_now"),
    listMessages: (query) => call("list_messages", { query }),
    getThread: (threadId) => call("get_thread", { threadId }),
    setThreadSeen: (threadId, seen) => call("set_thread_seen", { threadId, seen }),
    setThreadFlagged: (threadId, flagged) => call("set_thread_flagged", { threadId, flagged }),
    setThreadArchived: (threadId, archived) => call("set_thread_archived", { threadId, archived }),
    snoozeThread: (threadId, until) => call("snooze_thread", { threadId, until }),
    unsnoozeThread: (threadId) => call("unsnooze_thread", { threadId }),
    openAttachment: (id) => call("open_attachment", { id }),
    attachmentData: (id) => call<ArrayBuffer>("attachment_data", { id }),
    queueSend: (draft, undoSecs, sendAt) => call("queue_send", { draft, undoSecs, sendAt: sendAt ?? null }),
    cancelSend: (id) => call("cancel_send", { id }),
    listOutbox: () => call("list_outbox"),
    rescheduleSend: (id, sendAt) => call("reschedule_send", { id, sendAt }),
    setFollowUp: (threadId, dueAt) => call("set_follow_up", { threadId, dueAt }),
    cancelFollowUp: (threadId) => call("cancel_follow_up", { threadId }),
    unsubscribe: (messageId) => call("unsubscribe", { id: messageId }),
    listTemplates: () => call("list_templates"),
    saveTemplate: (input) => call("save_template", { input }),
    deleteTemplate: (id) => call("delete_template", { id }),
    listSignatures: () => call("list_signatures"),
    setSignature: (accountId, html) => call("set_signature", { accountId, html }),
    screenerStatus: () => call("screener_status"),
    setScreener: (enabled) => call("set_screener", { enabled }),
    decideSender: (email, decision) => call("decide_sender", { email, decision }),
    setSenderCategory: (email, category) => call("set_sender_category", { email, category }),
    listSenders: () => call("list_senders"),
    setTimeZone: (tz) => call("set_time_zone", { tz }),
    listCollections: (kind) => call("list_collections", { kind }),
    setCollectionHidden: (id, hidden) => call("set_collection_hidden", { id, hidden }),
    interestingCalendars: () => call("interesting_calendars"),
    swipeActions: () => call("swipe_actions"),
    setSwipeActions: (actions) => call("set_swipe_actions", { actions }),
    addInterestingCalendar: (id) => call("add_interesting_calendar", { id }),
    removeInterestingCalendar: (id) => call("remove_interesting_calendar", { id }),
    listOccurrences: (from, to) => call("list_occurrences", { from, to }),
    getEvent: (id, start) => call("get_event", { id, start: start ?? null }),
    createEvent: (input) => call("create_event", { input }),
    updateEvent: (id, input, scope, occurrence) => call("update_event", { id, input, scope: scope ?? null, occurrence: occurrence ?? null }),
    deleteEvent: (id, occurrence, scope) => call("delete_event", { id, occurrence: occurrence ?? null, scope: scope ?? null }),
    eventGuests: (id) => call("event_guests", { id }),
    respondToInvite: (messageId, response, calendarId) => call("respond_to_invite", { messageId, response, calendarId: calendarId ?? null }),
    applyInviteUpdate: (messageId) => call("apply_invite_update", { messageId }),
    listContacts: (search, label, group) => call("list_contacts", { search: search ?? null, label: label ?? null, group: group ?? null }),
    smartGroups: () => call("smart_groups"),
    saveSmartGroup: (id, input) => call("save_smart_group", { id, input }),
    deleteSmartGroup: (id) => call("delete_smart_group", { id }),
    contactsRestorePreview: (point) => call("contacts_restore_preview", { since: point.since ?? null, after: point.after ?? null }),
    restoreContacts: (point) => call("restore_contacts", { since: point.since ?? null, after: point.after ?? null }),
    contactLabels: () => call("contact_labels"),
    deletedContacts: () => call("deleted_contacts"),
    restoreContact: (id) => call("restore_contact", { id }),
    contactVcard: (id) => call("contact_vcard", { id }),
    saveContactVcard: (id) => call("save_contact_vcard", { id }),
    contactQr: (id) => call("contact_qr", { id }),
    contactSuggestion: (messageId) => call("contact_suggestion", { messageId }),
    parseSignature: (text) => call("parse_signature", { text }),
    getContact: (id) => call("get_contact", { id }),
    contactActivity: (id) => call("contact_activity", { id }),
    takeMissedReminders: () => call("take_missed_reminders"),
    listSplits: () => call("list_splits"),
    saveSplit: (id, input) => call("save_split", { id, input }),
    deleteSplit: (id) => call("delete_split", { id }),
    moveSplit: (id, index) => call("move_split", { id, index }),
    inboxOverview: (accountId) => call("inbox_overview", { accountId: accountId ?? null }),
    bundleMarkRead: (accountId) => call("bundle_mark_read", { accountId: accountId ?? null }),
    bundleArchive: (accountId) => call("bundle_archive", { accountId: accountId ?? null }),
    unarchiveBundle: (keys) => call("unarchive_bundle", { keys }),
    proposeTime: (messageId, start, end, comment) => call("propose_time", { messageId, start, end, comment: comment ?? null }),
    acceptCounter: (messageId) => call("accept_counter", { messageId }),
    declineCounter: (messageId) => call("decline_counter", { messageId }),
    findTimes: (q) => call("find_times", { ...q }),
    calendarSets: () => call("calendar_sets"),
    saveCalendarSet: (name) => call("save_calendar_set", { name }),
    deleteCalendarSet: (id) => call("delete_calendar_set", { id }),
    applyCalendarSet: (id) => call("apply_calendar_set", { id }),
    createContact: (input) => call("create_contact", { input }),
    updateContact: (id, input) => call("update_contact", { id, input }),
    deleteContact: (id) => call("delete_contact", { id }),
    duplicateContacts: () => call("duplicate_contacts"),
    mergeContacts: (primary, others) => call("merge_contacts", { primary, others }),
    suggestRecipients: (prefix) => call("suggest_recipients", { prefix }),
    syncPimNow: () => call("sync_pim_now"),
    listNotes: (query) => call("list_notes", { query }),
    getNote: (id) => call("get_note", { id }),
    createNote: (input) => call("create_note", { input }),
    saveNoteBody: (id, markdown, ydoc, touch) => call("save_note_body", { id, markdown, ydoc, touch }),
    setNoteMeta: (id, meta) => call("set_note_meta", { id, meta }),
    deleteNote: (id) => call("delete_note", { id }),
    restoreNote: (id) => call("restore_note", { id }),
    noteTags: () => call("note_tags"),
    noteLinkFor: (target) => call("note_link_for", { target }),
    importNotes: (files) => call("import_notes", { files }),
    noteRecords: () => call("note_records"),
    applyNoteRecords: (records) => call("apply_note_records", { records }),
    getNotesRelay: () => call("get_notes_relay"),
    setNotesRelay: (relay) => call("set_notes_relay", { relay }),
  }
}

async function createTauriClient(): Promise<CoreClient> {
  const { invoke } = await import("@tauri-apps/api/core")
  const { listen } = await import("@tauri-apps/api/event")
  // One IPC command routes everything to the shared dispatcher in pim-app.
  const call: Call = (name, args) => invoke("core", { name, args: args ?? {} })
  return {
    kind: "native",
    remote: false,
    ...commands(call),
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

// ── Web gateway (ADR-0016) ───────────────────────────────────────────────────

export interface GatewaySession {
  gateway: true
  signedIn: boolean
}

/** Every write carries this header, so another site can't post as you (CSRF). */
const CSRF = { "X-Mailbird": "1" }

/** The gateway's session, or `null` when this page isn't served by a gateway. */
export async function gatewaySession(): Promise<GatewaySession | null> {
  // The gateway marks the page it serves; anywhere else there's nothing to ask.
  if (!document.querySelector('meta[name="mailbird-gateway"]')) return null
  try {
    const r = await fetch("/api/session", { credentials: "same-origin", headers: { Accept: "application/json" } })
    if (!r.ok || !r.headers.get("content-type")?.includes("application/json")) return null
    const v = (await r.json()) as Partial<GatewaySession> | null
    return v?.gateway ? (v as GatewaySession) : null
  } catch {
    return null
  }
}

async function gatewayError(r: Response): Promise<Error> {
  const v = (await r.json().catch(() => null)) as { error?: string } | null
  return new Error(v?.error ?? `the gateway answered ${r.status}`)
}

export async function signInToGateway(password: string): Promise<void> {
  const r = await fetch("/api/session", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", ...CSRF }, body: JSON.stringify({ password }) })
  if (!r.ok) throw await gatewayError(r)
}

export async function signOutOfGateway(): Promise<void> {
  await fetch("/api/session", { method: "DELETE", credentials: "same-origin", headers: CSRF })
}

/** Fired when the gateway says the session ended, so the app shows sign-in. */
export const SIGNED_OUT = "mailbird:signed-out"

function createGatewayClient(): CoreClient {
  const call: Call = async <T,>(name: string, args?: Record<string, unknown>) => {
    const r = await fetch(`/api/core/${name}`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", ...CSRF }, body: JSON.stringify(args ?? {}) })
    if (r.status === 401) {
      window.dispatchEvent(new Event(SIGNED_OUT))
      throw new Error("Your session ended. Sign in again.")
    }
    if (!r.ok) throw await gatewayError(r)
    if (r.headers.get("content-type")?.startsWith("application/octet-stream")) return (await r.arrayBuffer()) as T
    return (await r.json()) as T
  }
  // One event stream for the whole page; handlers subscribe by name.
  const handlers = new Map<string, Set<(payload?: unknown) => void>>()
  const stream = new EventSource("/api/events", { withCredentials: true })
  const names: (CoreEvent | "open-url")[] = ["mail:changed", "outbox:changed", "accounts:changed", "pim:changed", "notes:changed", "compose:changed", "reminder", "open-url"]
  for (const name of names) {
    stream.addEventListener(name, (e) => {
      const data = (e as MessageEvent<string>).data
      const payload: unknown = data ? JSON.parse(data) : undefined
      handlers.get(name)?.forEach((h) => h(payload))
    })
  }
  // OAuth sign-in: the gateway asks the browser to open the provider's page.
  handlers.set("open-url", new Set([(p) => void window.open(String(p), "_blank", "noopener")]))
  return {
    kind: "native",
    remote: true,
    ...commands(call),
    // Files download through the browser: there's no "open with" on a server.
    openAttachment: async (id) => {
      const a = document.createElement("a")
      a.href = `/api/attachments/${encodeURIComponent(id)}`
      a.download = ""
      a.click()
      return "your browser's downloads"
    },
    saveContactVcard: async (id) => downloadVcard(await call<ContactExport>("contact_vcard", { id })),
    on(event, handler) {
      const set = handlers.get(event) ?? new Set()
      set.add(handler)
      handlers.set(event, set)
      return () => set.delete(handler)
    },
  }
}

let clientPromise: Promise<CoreClient> | null = null

/** The desktop or phone app's own core, a web gateway's, or the sample-mail demo. */
export function getCoreClient(): Promise<CoreClient> {
  clientPromise ??= isTauri()
    ? createTauriClient()
    : gatewaySession().then((s) => (s ? createGatewayClient() : import("./demo").then((m) => m.createDemoClient())))
  return clientPromise
}
