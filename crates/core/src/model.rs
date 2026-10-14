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

/// How to reach a JMAP server (RFC 8620/8621).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JmapConfig {
    /// The session resource, e.g. `https://api.fastmail.com/jmap/session`.
    pub session_url: String,
    /// Send the secret as an API token (`Bearer`), as Fastmail requires,
    /// instead of username + password (`Basic`).
    #[serde(default)]
    pub bearer: bool,
}

/// Everything needed to reach an account, minus the password or token.
/// Secrets live in the OS keychain, never in the database.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountConfig {
    pub display_name: String,
    pub address: String,
    pub username: String,
    pub provider: Provider,
    /// Used when `jmap` is absent.
    pub imap: ServerConfig,
    pub smtp: ServerConfig,
    /// When set, mail syncs and sends over JMAP instead of IMAP/SMTP.
    #[serde(default)]
    pub jmap: Option<JmapConfig>,
    /// Calendars and contacts over CalDAV/CardDAV, when the provider has them.
    #[serde(default)]
    pub dav: Option<DavConfig>,
}

/// Where an account's calendars and contacts live.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DavConfig {
    /// CalDAV entry point: a server root (discovery uses `/.well-known/caldav`)
    /// or a known path such as `https://caldav.fastmail.com/dav/calendars`.
    #[serde(default)]
    pub calendar_url: Option<String>,
    #[serde(default)]
    pub contacts_url: Option<String>,
    /// DAV signs in with its own app password, stored apart from the mail
    /// secret (Fastmail: the JMAP API token can't do CalDAV).
    #[serde(default)]
    pub separate_secret: bool,
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
    /// Calendar and contacts sync, tracked apart from mail: one can fail
    /// while the other works.
    #[serde(default)]
    pub dav_last_sync: Option<i64>,
    #[serde(default)]
    pub dav_error: Option<String>,
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
    /// A meeting invitation, cancellation, or reply carried by the message.
    #[serde(default)]
    pub invite: Option<Invite>,
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
    /// Plain-text body. Always sent, so text-only readers get the message.
    pub body: String,
    /// Rich body from the composer; sent alongside `body` as
    /// multipart/alternative when present.
    #[serde(default)]
    pub body_html: Option<String>,
    /// `Message-ID` of the message being replied to, for threading.
    #[serde(default)]
    pub in_reply_to: Option<String>,
    /// The full `References` chain of the message being replied to.
    #[serde(default)]
    pub references: Vec<String>,
    #[serde(default)]
    pub attachments: Vec<OutgoingAttachment>,
    /// An iTIP message (invitation, reply, cancellation) sent as the
    /// message's `text/calendar` alternative (iMIP, RFC 6047).
    #[serde(default)]
    pub calendar: Option<CalendarPart>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarPart {
    /// "REQUEST", "REPLY", or "CANCEL"; repeated in the Content-Type.
    pub method: String,
    pub ics: String,
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
    /// UIDs our own ops moved to another mailbox. Their local rows go now;
    /// the destination mailbox's sync brings them back under the new UID.
    pub moved_out: Vec<u32>,
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
    /// Move from the inbox to the server's archive mailbox.
    Archive,
    /// Move from the server's archive mailbox back to the inbox.
    Unarchive,
}

// ── Server-id sync (JMAP) ────────────────────────────────────────────────
// IMAP addresses messages by numeric UID; JMAP by opaque string id. The
// store keeps both, and these types carry the string-id flavor.

/// Where a JMAP sync should pick up. JMAP state is account-wide, so one
/// cursor covers every mailbox.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RemoteCursor {
    /// The server's `Email` state string from the last pass.
    pub state: Option<String>,
    /// Stored server ids and the store mailbox each lives in.
    pub known: std::collections::HashMap<String, String>,
}

/// A local change that still has to reach a JMAP server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteOp {
    pub id: i64,
    pub remote_id: String,
    pub kind: OpKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteMessage {
    pub remote_id: String,
    /// Store mailbox: `store::INBOX`, `store::ARCHIVE`, or `store::SENT`.
    pub mailbox: String,
    pub seen: bool,
    pub flagged: bool,
    pub raw: Vec<u8>,
}

/// The result of one JMAP sync pass for one account.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RemoteBatch {
    /// New `Email` state to resume from next time.
    pub state: String,
    /// The old state was too old to diff; server copies were replaced.
    pub reset: bool,
    pub new_messages: Vec<RemoteMessage>,
    /// Current flags for already-known ids: (id, seen, flagged).
    pub flags: Vec<(String, bool, bool)>,
    /// Known ids that moved to another tracked mailbox: (id, store mailbox).
    pub moved: Vec<(String, String)>,
    /// Ids that left every tracked mailbox or were destroyed.
    pub removed: Vec<String>,
    pub applied_ops: Vec<i64>,
    pub more_older: bool,
}

// ── Calendar ────────────────────────────────────────────────────────────────

/// How an event repeats, as far as the editor can express it. `Custom` is any
/// richer rule from another client; edits keep it unchanged.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Repeat {
    #[default]
    None,
    Daily,
    Weekly,
    Monthly,
    Yearly,
    Custom,
}

/// An event as the editor submits it. Times are wall-clock in `time_zone`
/// ("2026-10-14T09:30"); all-day events use dates ("2026-10-14") with an
/// exclusive end, as iCalendar does.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventInput {
    pub calendar_id: String,
    pub title: String,
    #[serde(default)]
    pub location: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    pub start: String,
    pub end: String,
    #[serde(default)]
    pub all_day: bool,
    pub time_zone: String,
    #[serde(default)]
    pub repeat: Repeat,
    /// Minutes before the start to remind (0 = at the start). `None` keeps
    /// the event's reminders as they are; `Some(vec![])` removes them.
    #[serde(default)]
    pub reminders: Option<Vec<i64>>,
    /// Guests to invite (you organize). `None` keeps the guest list;
    /// `Some(vec![])` makes it a plain event again. Ignored when editing a
    /// single occurrence.
    #[serde(default)]
    pub attendees: Option<Vec<Address>>,
}

/// How you answer an invitation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InviteResponse {
    Accepted,
    Tentative,
    Declined,
}

/// The invitation (or cancellation, or guest's reply) a message carries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Invite {
    /// "request", "cancel", "reply", …
    pub method: String,
    pub uid: String,
    pub title: String,
    pub location: Option<String>,
    pub start: Option<i64>,
    pub end: Option<i64>,
    pub all_day: bool,
    pub recurring: bool,
    pub organizer: Option<Address>,
    pub attendees: Vec<Attendee>,
    /// Your answer: from your calendar's copy when there is one.
    pub my_status: Option<String>,
    /// Your calendar's copy of this event.
    pub event_id: Option<String>,
    /// Your calendar already has a newer version than this message.
    pub outdated: bool,
    /// For a reply: the guest and their answer.
    pub from: Option<Attendee>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attendee {
    pub name: Option<String>,
    pub email: String,
    /// RFC 5545 PARTSTAT, lowercased: "accepted", "declined", "tentative", "needs-action".
    pub status: Option<String>,
}

// ── Contacts ────────────────────────────────────────────────────────────────

/// One email address or phone number, with its vCard TYPE ("work", "cell"…).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactField {
    pub label: Option<String>,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactInput {
    pub book_id: String,
    pub full_name: String,
    #[serde(default)]
    pub emails: Vec<ContactField>,
    #[serde(default)]
    pub phones: Vec<ContactField>,
    #[serde(default)]
    pub org: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    /// "YYYY-MM-DD", or "--MM-DD" without a year.
    #[serde(default)]
    pub birthday: Option<String>,
}

// ── Calendar and contact collections ────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CollectionKind {
    Calendar,
    Contacts,
}

impl CollectionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            CollectionKind::Calendar => "calendar",
            CollectionKind::Contacts => "contacts",
        }
    }
}

/// A calendar or address book: on a CalDAV/CardDAV server, or on this device.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub id: String,
    /// `None` for collections that live only on this device.
    pub account_id: Option<String>,
    pub kind: CollectionKind,
    pub name: String,
    /// CSS color from the server (`calendar-color`), if any.
    pub color: Option<String>,
    pub writable: bool,
    pub hidden: bool,
    /// The server sends invitations and replies for events here (RFC 6638).
    pub scheduling: bool,
}

/// One occurrence of an event, for agenda and grid views. Times are Unix
/// seconds; all-day occurrences start at local midnight.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Occurrence {
    pub event_id: String,
    pub calendar_id: String,
    pub title: String,
    pub location: Option<String>,
    pub start: i64,
    pub end: i64,
    /// The occurrence's slot in its series (RECURRENCE-ID). Edits and
    /// deletes of one occurrence address it by this, not by `start`.
    pub original_start: i64,
    pub all_day: bool,
    pub recurring: bool,
}

/// Which occurrences of a series an edit or delete applies to.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EditScope {
    #[default]
    All,
    This,
    Following,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventDetail {
    #[serde(flatten)]
    pub occurrence: Occurrence,
    pub notes: Option<String>,
    pub repeat: Repeat,
    /// The zone the event was written in, when it isn't floating or all-day.
    pub time_zone: Option<String>,
    pub organizer: Option<Address>,
    pub attendees: Vec<Attendee>,
    pub url: Option<String>,
    pub writable: bool,
    /// Minutes before the start, for the series' editable reminders.
    pub reminders: Vec<i64>,
}

/// A reminder that is due: shown as a notification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DueReminder {
    pub event_id: String,
    pub title: String,
    pub location: Option<String>,
    /// The occurrence's start (Unix seconds).
    pub start: i64,
    pub fire_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactSummary {
    pub id: String,
    pub book_id: String,
    pub full_name: String,
    pub org: Option<String>,
    pub emails: Vec<ContactField>,
    pub phones: Vec<ContactField>,
    pub photo: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactDetail {
    #[serde(flatten)]
    pub summary: ContactSummary,
    pub title: Option<String>,
    pub note: Option<String>,
    pub birthday: Option<String>,
    pub writable: bool,
}

// ── DAV sync (store ↔ net) ──────────────────────────────────────────────────

/// A collection as the server lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteCollection {
    pub href: String,
    pub kind: CollectionKind,
    pub name: String,
    pub color: Option<String>,
    pub writable: bool,
    /// The server does CalDAV scheduling (RFC 6638 `calendar-auto-schedule`):
    /// it emails invitations and replies itself.
    pub scheduling: bool,
}

/// What the store knows about one collection's server copy.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DavCursor {
    pub href: String,
    /// RFC 6578 sync token, when the server supports `sync-collection`.
    pub sync_token: Option<String>,
    /// href → etag of every synced resource.
    pub etags: std::collections::HashMap<String, String>,
}

/// A local change waiting to reach the server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DavChange {
    pub item_id: String,
    pub href: String,
    /// The etag the change was made against; `None` for a new resource.
    pub etag: Option<String>,
    /// New body, or `None` to delete.
    pub body: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DavOutcome {
    /// Stored; the server's new etag, when it returned one.
    Saved(Option<String>),
    Deleted,
    /// The server copy changed (412) or vanished (404) first: the server wins.
    Conflict,
}

/// One pass of server changes for a collection.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DavBatch {
    pub sync_token: Option<String>,
    /// (href, etag, body) for new and changed resources.
    pub upserts: Vec<(String, String, String)>,
    pub removed: Vec<String>,
}
