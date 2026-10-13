//! Shapes shared with the UI. Everything here serializes as camelCase JSON,
//! and `apps/web/src/core/types.ts` mirrors it by hand.

use serde::{Deserialize, Serialize};

use crate::Provider;

/// How a connection is secured.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Security {
    /// TLS from the first byte (IMAP 993, SMTP 465).
    Tls,
    /// Plain connect, then upgrade (SMTP 587).
    StartTls,
    /// No encryption. Only accepted for localhost, for local test servers.
    Plain,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
    pub security: Security,
}

/// Everything needed to reach an IMAP/SMTP account, minus the password.
/// Passwords live in the OS keychain, never in the database.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountConfig {
    pub display_name: String,
    pub address: String,
    pub username: String,
    pub provider: Provider,
    pub imap: ServerConfig,
    pub smtp: ServerConfig,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    #[serde(flatten)]
    pub config: AccountConfig,
    /// Last successful sync, or `None` if the account has never synced.
    pub last_sync: Option<i64>,
    /// Last sync error, shown on the account so failures are never silent.
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Address {
    pub name: Option<String>,
    pub email: String,
}

/// The inbox views. `Inbox` is the unified inbox across all accounts unless a
/// query narrows it to one account.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Lane {
    Inbox,
    Unread,
    Starred,
    Snoozed,
    Archive,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageQuery {
    pub lane: Lane,
    pub account_id: Option<String>,
    /// Full-text search over sender, subject, and body.
    pub search: Option<String>,
    pub limit: Option<u32>,
}

/// A row in a message list. Lists are grouped by conversation: each row is
/// the newest matching message of its thread, with thread-wide totals.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageSummary {
    pub id: String,
    pub account_id: String,
    pub thread_id: String,
    /// Messages in the whole conversation, including your sent replies.
    pub thread_count: u32,
    pub has_attachments: bool,
    pub from: Address,
    pub subject: String,
    pub preview: String,
    /// When the message was sent (seconds).
    pub date: i64,
    /// What the list sorts by: `date`, or the moment a snooze resurfaced it.
    pub sort_at: i64,
    /// In a list row: true only when every matching message in the thread is read.
    pub seen: bool,
    /// In a list row: true when any message in the thread is starred.
    pub flagged: bool,
    pub archived: bool,
    pub snoozed_until: Option<i64>,
    /// `INBOX`, or `Sent` for copies of mail sent from this device.
    pub mailbox: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentInfo {
    pub id: String,
    pub filename: String,
    pub mime_type: String,
    pub size: u64,
    /// Embedded in the body (cid: image); not listed as a file.
    pub inline: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageDetail {
    #[serde(flatten)]
    pub summary: MessageSummary,
    pub to: Vec<Address>,
    pub cc: Vec<Address>,
    pub message_id: Option<String>,
    pub body_text: String,
    /// HTML as sent, with `cid:` images inlined as data URLs. The UI must
    /// sanitize it and render it in a sandboxed iframe; it is never injected
    /// into the app's DOM.
    pub body_html: Option<String>,
    pub attachments: Vec<AttachmentInfo>,
    /// This message's `References` + `In-Reply-To`, oldest first. A reply
    /// sends these plus this message's own id.
    pub references: Vec<String>,
}

/// A file to attach to an outgoing message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutgoingAttachment {
    pub filename: String,
    pub mime_type: String,
    /// File contents, base64-encoded (JSON can't carry raw bytes).
    pub data_base64: String,
}

/// An outgoing message being written.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub account_id: String,
    pub to: Vec<Address>,
    #[serde(default)]
    pub cc: Vec<Address>,
    pub subject: String,
    pub body: String,
    /// `Message-ID` of the message being replied to, for threading.
    #[serde(default)]
    pub in_reply_to: Option<String>,
    /// The full `References` chain of the message being replied to.
    #[serde(default)]
    pub references: Vec<String>,
    #[serde(default)]
    pub attachments: Vec<OutgoingAttachment>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutboxState {
    /// Waiting out the undo window.
    Queued,
    Sending,
    Sent,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxItem {
    pub id: String,
    pub draft: Draft,
    /// When the undo window closes and sending starts (seconds).
    pub send_at: i64,
    pub state: OutboxState,
    pub error: Option<String>,
}

/// A message as fetched from a server, before it is stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchedMessage {
    pub uid: u32,
    pub seen: bool,
    pub flagged: bool,
    pub raw: Vec<u8>,
}

/// The result of one IMAP sync pass for one mailbox.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SyncBatch {
    pub mailbox: String,
    pub uid_validity: u32,
    pub new_messages: Vec<FetchedMessage>,
    /// Current server flags for already-known UIDs: (uid, seen, flagged).
    pub flags: Vec<(u32, bool, bool)>,
    /// Every UID still on the server, so local copies of deleted mail can go.
    pub server_uids: Vec<u32>,
    /// Local changes the server has now confirmed (op ids).
    pub applied_ops: Vec<i64>,
    /// Older mail is still on the server; another pass should backfill it.
    pub more_older: bool,
}

/// Where an IMAP sync should pick up.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SyncCursor {
    pub uid_validity: Option<u32>,
    pub last_uid: u32,
    /// Lowest UID stored locally; backfill fetches below it.
    pub oldest_uid: Option<u32>,
}

/// A local change that still has to reach the server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingOp {
    pub id: i64,
    pub uid: u32,
    pub kind: OpKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpKind {
    Seen(bool),
    Flagged(bool),
    Archive,
}
