// Mirrors crates/core/src/model.rs and capabilities.rs (serde camelCase).
// Keep the two in step by hand; the Rust side is the source of truth.

export type Provider = "google" | "microsoft" | "i_cloud" | "jmap" | "generic" | "local"
export type Security = "tls" | "start_tls" | "plain"
export type Lane = "inbox" | "unread" | "starred" | "snoozed" | "archive"
export type OutboxState = "queued" | "sending" | "sent" | "failed" | "cancelled"

export interface Capabilities {
  mail: boolean
  calendar: boolean
  contacts: boolean
  notes: "native" | "import_only" | "unsupported"
  mail_organization: "labels" | "folders" | null
  contact_groups: boolean
  server_side_scheduling: boolean
  push: boolean
  auth: "o_auth2" | "app_password" | "password" | "none"
}

export interface ServerConfig {
  host: string
  port: number
  security: Security
}

export interface JmapConfig {
  /** The session resource, e.g. https://api.fastmail.com/jmap/session */
  sessionUrl: string
  /** Send the secret as an API token (Bearer) instead of username + password. */
  bearer: boolean
}

export interface AccountConfig {
  displayName: string
  address: string
  username: string
  provider: Provider
  /** Used when `jmap` is absent. */
  imap: ServerConfig
  smtp: ServerConfig
  /** When set, mail syncs and sends over JMAP instead of IMAP/SMTP. */
  jmap?: JmapConfig | null
  /** Calendars and contacts over CalDAV/CardDAV. */
  dav?: DavConfig | null
  /** Signed in with the provider in the browser (Google), not a password. */
  oauth?: OAuthAccount | null
}

export type OAuthIssuer = "google" | "microsoft"

export interface OAuthAccount {
  issuer: OAuthIssuer
  clientId: string
}

/** The app's registration with a provider (an OAuth client). */
export interface OAuthClientInfo {
  clientId: string
  hasSecret: boolean
  /** Baked into this build, rather than set in the app. */
  builtIn: boolean
}

export interface DavConfig {
  /** CalDAV entry point: a server root (well-known discovery) or a known path. */
  calendarUrl?: string | null
  contactsUrl?: string | null
  /** DAV signs in with its own app password (Fastmail). */
  separateSecret?: boolean
}

export interface Account extends AccountConfig {
  id: string
  lastSync: number | null
  lastError: string | null
  /** Calendar/contacts sync is tracked apart from mail. */
  davLastSync: number | null
  davError: string | null
}

export interface Address {
  name: string | null
  email: string
}

export interface MessageQuery {
  lane: Lane
  accountId?: string | null
  search?: string | null
  limit?: number | null
}

/** A list row is a conversation: its newest matching message plus thread totals. */
export interface MessageSummary {
  id: string
  accountId: string
  threadId: string
  /** Messages in the whole conversation, including your sent replies. */
  threadCount: number
  hasAttachments: boolean
  from: Address
  subject: string
  preview: string
  /** Seconds since the epoch. */
  date: number
  sortAt: number
  /** In a list row: every message in the thread is read. */
  seen: boolean
  /** In a list row: some message in the thread is starred. */
  flagged: boolean
  archived: boolean
  snoozedUntil: number | null
  /** "INBOX", or "Sent" for copies of mail sent from this device. */
  mailbox: string
}

export interface AttachmentInfo {
  id: string
  filename: string
  mimeType: string
  size: number
  /** Embedded in the body (cid: image), not shown as a file. */
  inline: boolean
}

export interface MessageDetail extends MessageSummary {
  to: Address[]
  cc: Address[]
  messageId: string | null
  bodyText: string
  /** Untrusted. Only ever rendered inside a sandboxed iframe. */
  bodyHtml: string | null
  attachments: AttachmentInfo[]
  /** References + In-Reply-To, oldest first; a reply appends this message's id. */
  references: string[]
  invite?: Invite | null
}

export interface OutgoingAttachment {
  filename: string
  mimeType: string
  dataBase64: string
}

export interface Draft {
  accountId: string
  to: Address[]
  cc: Address[]
  subject: string
  /** Plain-text part; always sent. */
  body: string
  /** Rich part from the composer, sent alongside `body` as multipart/alternative. */
  bodyHtml?: string | null
  inReplyTo?: string | null
  references?: string[]
  attachments?: OutgoingAttachment[]
}

export interface OutboxItem {
  id: string
  draft: Draft
  sendAt: number
  state: OutboxState
  error: string | null
}

// ── Calendars and contacts ───────────────────────────────────────────────

export type CollectionKind = "calendar" | "contacts"

export interface Collection {
  id: string
  /** null: lives only on this device. */
  accountId: string | null
  kind: CollectionKind
  name: string
  color: string | null
  writable: boolean
  hidden: boolean
  /** The server sends invitations and replies itself (CalDAV scheduling). */
  scheduling: boolean
}

/** "custom" is a richer rule from another app; edits keep it unchanged. */
export type Repeat = "none" | "daily" | "weekly" | "monthly" | "yearly" | "custom"

/** Wall-clock times in `timeZone` ("2026-10-14T09:30"); all-day uses dates with an exclusive end. */
export interface EventInput {
  calendarId: string
  title: string
  location?: string | null
  notes?: string | null
  start: string
  end: string
  allDay: boolean
  timeZone: string
  repeat: Repeat
  /** Minutes before the start (0 = at the start). Omit to keep them as they are. */
  reminders?: number[] | null
  /** Guests to invite. Omit to keep the guest list; [] removes it. */
  attendees?: Address[] | null
}

/** Which occurrences of a series an edit or delete applies to. */
export type EditScope = "all" | "this" | "following"

/** One occurrence. Seconds since the epoch; all-day ones start at local midnight. */
export interface Occurrence {
  eventId: string
  calendarId: string
  title: string
  location: string | null
  start: number
  end: number
  /** The occurrence's slot in its series; edits of one occurrence address it by this. */
  originalStart: number
  allDay: boolean
  recurring: boolean
}

export interface Attendee {
  name: string | null
  email: string
  /** "accepted" | "declined" | "tentative" | "needs-action" … */
  status: string | null
}

export interface EventDetail extends Occurrence {
  notes: string | null
  repeat: Repeat
  timeZone: string | null
  organizer: Address | null
  attendees: Attendee[]
  url: string | null
  writable: boolean
  /** Minutes before the start. */
  reminders: number[]
}

export interface DueReminder {
  eventId: string
  title: string
  location: string | null
  start: number
  fireAt: number
}

export type InviteResponse = "accepted" | "tentative" | "declined"

/** The invitation, cancellation, or guest reply a message carries. */
export interface Invite {
  method: "request" | "cancel" | "reply" | string
  uid: string
  title: string
  location: string | null
  start: number | null
  end: number | null
  allDay: boolean
  recurring: boolean
  organizer: Address | null
  attendees: Attendee[]
  /** Your answer, from your calendar's copy when there is one. */
  myStatus: string | null
  /** Your calendar's copy of the event. */
  eventId: string | null
  /** Your calendar already has a newer version. */
  outdated: boolean
  /** For a reply: the guest and their answer. */
  from: Attendee | null
}

export interface ContactField {
  /** vCard TYPE: "work", "home", "cell"… */
  label: string | null
  value: string
}

export interface ContactInput {
  bookId: string
  fullName: string
  emails: ContactField[]
  phones: ContactField[]
  org?: string | null
  title?: string | null
  note?: string | null
  /** "YYYY-MM-DD", or "--MM-DD" without a year. */
  birthday?: string | null
}

export interface ContactSummary {
  id: string
  bookId: string
  fullName: string
  org: string | null
  emails: ContactField[]
  phones: ContactField[]
  /** data: URL; remote photos are never fetched. */
  photo: string | null
}

export interface ContactDetail extends ContactSummary {
  title: string | null
  note: string | null
  birthday: string | null
  writable: boolean
}

// ── Notes ───────────────────────────────────────────────────────────────────

/** Links use keys every device shares: an event's or contact's UID, a conversation's first Message-ID. */
export type NoteLinkKind = "event" | "contact" | "thread"

export interface NoteLink {
  kind: NoteLinkKind
  key: string
  /** Shown when the target isn't on this device. */
  label: string
  /** The target's id here, when it's here. */
  target?: string | null
}

export interface NoteSummary {
  id: string
  /** The first line, without Markdown marks. */
  title: string
  snippet: string
  pinned: boolean
  archived: boolean
  tags: string[]
  links: NoteLink[]
  created: number
  updated: number
}

export interface NoteDetail extends NoteSummary {
  markdown: string
  /** base64 Yjs state, once an editor has opened the note. */
  ydoc: string | null
}

export interface NoteInput {
  markdown: string
  pinned?: boolean
  tags?: string[]
  links?: NoteLink[]
}

/** Omitted fields stay as they are. */
export interface NoteMeta {
  pinned?: boolean
  archived?: boolean
  tags?: string[]
  links?: NoteLink[]
}

export interface NoteTarget {
  kind: NoteLinkKind
  id: string
}

export interface NoteQuery {
  search?: string | null
  tag?: string | null
  archived?: boolean
  linked?: NoteTarget | null
}

export interface TagCount {
  tag: string
  count: number
}

export interface ImportFile {
  /** Path inside the picked folder; folders become tags. */
  path: string
  contents: string
  modified?: number | null
}

export interface ImportReport {
  imported: number
  duplicates: number
  trashed: number
  attachmentsDropped: number
  skipped: string[]
}

/** Everything but a note's text, which syncs as its own Yjs document. Newest `updated` wins. */
export interface NoteRecord {
  id: string
  pinned: boolean
  archived: boolean
  deleted: boolean
  tags: string[]
  links: NoteLink[]
  created: number
  updated: number
}

export interface RelayConfig {
  /** wss://… (ws:// only on this device). */
  url: string
  token: string
}
