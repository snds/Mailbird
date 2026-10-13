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
}

export interface Account extends AccountConfig {
  id: string
  lastSync: number | null
  lastError: string | null
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
  body: string
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
