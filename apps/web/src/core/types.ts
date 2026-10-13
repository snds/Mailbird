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

export interface AccountConfig {
  displayName: string
  address: string
  username: string
  provider: Provider
  imap: ServerConfig
  smtp: ServerConfig
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

export interface MessageSummary {
  id: string
  accountId: string
  from: Address
  subject: string
  preview: string
  /** Seconds since the epoch. */
  date: number
  sortAt: number
  seen: boolean
  flagged: boolean
  archived: boolean
  snoozedUntil: number | null
}

export interface MessageDetail extends MessageSummary {
  to: Address[]
  cc: Address[]
  messageId: string | null
  bodyText: string
  /** Untrusted. Only ever rendered inside a sandboxed iframe. */
  bodyHtml: string | null
}

export interface Draft {
  accountId: string
  to: Address[]
  cc: Address[]
  subject: string
  body: string
  inReplyTo?: string | null
}

export interface OutboxItem {
  id: string
  draft: Draft
  sendAt: number
  state: OutboxState
  error: string | null
}
