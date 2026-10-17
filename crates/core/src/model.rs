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
    /// Signed in with OAuth instead of a password. The secret in the keychain
    /// is then a token set (see `oauth::TokenSet`), and every protocol sends
    /// `Authorization: Bearer`. For Google, mail uses the Gmail API.
    #[serde(default)]
    pub oauth: Option<OAuthAccount>,
}

/// Who issued an account's OAuth tokens.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OAuthIssuer {
    Google,
    Microsoft,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthAccount {
    pub issuer: OAuthIssuer,
    /// The OAuth client the tokens were issued to; refresh tokens only work
    /// with the client that got them.
    pub client_id: String,
    /// Overrides the provider's API root (tests, or a self-hosted proxy).
    #[serde(default)]
    pub api_base: Option<String>,
    /// Overrides the provider's token endpoint (tests).
    #[serde(default)]
    pub token_url: Option<String>,
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
    /// Sent mail with a follow-up reminder that hasn't come due.
    Waiting,
    /// Mail from first-time senders, held until you say yes or no.
    Screener,
}

/// What kind of mail a message is, from its headers (see `triage`), unless
/// you've moved its sender to another category.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Category {
    #[default]
    People,
    Updates,
    Newsletters,
}

impl Category {
    pub fn as_str(self) -> &'static str {
        match self {
            Category::People => "people",
            Category::Updates => "updates",
            Category::Newsletters => "newsletters",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "people" => Some(Category::People),
            "updates" => Some(Category::Updates),
            "newsletters" => Some(Category::Newsletters),
            _ => None,
        }
    }
}

/// What you decided about a sender.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SenderDecision {
    /// Their mail goes to the inbox.
    Allowed,
    /// Their mail skips the inbox: it's archived as it arrives.
    ScreenedOut,
    /// Screened out, and marked read too.
    Blocked,
}

impl SenderDecision {
    pub fn as_str(self) -> &'static str {
        match self {
            SenderDecision::Allowed => "allowed",
            SenderDecision::ScreenedOut => "screened_out",
            SenderDecision::Blocked => "blocked",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "allowed" => Some(SenderDecision::Allowed),
            "screened_out" => Some(SenderDecision::ScreenedOut),
            "blocked" => Some(SenderDecision::Blocked),
            _ => None,
        }
    }
}

/// A sender you've decided about, or moved to a category.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sender {
    pub email: String,
    /// The name on their newest message, if any.
    pub name: Option<String>,
    pub decision: Option<SenderDecision>,
    pub category: Option<Category>,
    /// Messages from them on this device.
    pub messages: u32,
}

/// Whether the Screener is on, and how many senders wait in it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenerStatus {
    pub enabled: bool,
    /// Mail from new senders that arrived before this isn't screened.
    pub since: Option<i64>,
    pub waiting: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageQuery {
    pub lane: Lane,
    pub account_id: Option<String>,
    /// Full-text search over sender, subject, and body.
    pub search: Option<String>,
    pub limit: Option<u32>,
    /// Rows to skip, for paging through a long list.
    #[serde(default)]
    pub offset: Option<u32>,
    /// Only this kind of mail (People, Updates, Newsletters).
    #[serde(default)]
    pub category: Option<Category>,
    /// Inbox only: just the mail a split catches (ADR-0022).
    #[serde(default)]
    pub split: Option<String>,
    /// Inbox only: fold newsletters into one bundle row when there are two or more.
    #[serde(default)]
    pub bundle: bool,
}

/// Your own inbox tab: mail matching a rule (Superhuman's split inbox).
/// Every field set must match; a sender list matches any of its entries.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitInput {
    pub name: String,
    /// Addresses ("ana@example.com") or whole domains ("@studio.example").
    #[serde(default)]
    pub senders: Vec<String>,
    /// Words the subject contains.
    #[serde(default)]
    pub subject: Option<String>,
    #[serde(default)]
    pub has_attachments: bool,
    /// Only mail to this account.
    #[serde(default)]
    pub account_id: Option<String>,
    /// Its mail leaves the main inbox (shows only in the split).
    #[serde(default)]
    pub exclusive: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Split {
    pub id: String,
    #[serde(flatten)]
    pub rule: SplitInput,
}

/// A split's size, for its tab.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitCount {
    pub id: String,
    /// Conversations, and how many have unread mail.
    pub threads: u32,
    pub unread: u32,
}

/// Newsletters folded into one inbox row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewsletterBundle {
    pub threads: u32,
    pub unread: u32,
    /// The newest, where the row sorts.
    pub latest: i64,
    /// Who they're from, newest first, up to three.
    pub senders: Vec<String>,
}

/// What the inbox shows above its rows: split tab counts and the bundle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxOverview {
    pub splits: Vec<SplitCount>,
    pub bundle: Option<NewsletterBundle>,
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
    /// On sent mail: when a follow-up reminder is due if nobody replies.
    /// In the inbox lane, a past time means the thread came back for it.
    #[serde(default)]
    pub follow_up_at: Option<i64>,
    /// On sent mail: who it went to (the first recipient's name or address),
    /// so a list row can say "To Jo" instead of "Me".
    #[serde(default)]
    pub sent_to: Option<String>,
    /// People, Updates, or Newsletters: the sender's category if you set
    /// one, otherwise what the headers say.
    #[serde(default)]
    pub category: Category,
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
    /// How to unsubscribe, from the message's `List-Unsubscribe` headers.
    #[serde(default)]
    pub unsubscribe: Option<Unsubscribe>,
}

/// The ways a mailing list offers to unsubscribe (RFC 2369, RFC 8058).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Unsubscribe {
    /// An https address that unsubscribes with one POST, no page to visit.
    pub one_click: Option<String>,
    /// An address to mail; the request is the message itself.
    pub mailto: Option<String>,
    /// A page to open in the browser.
    pub web: Option<String>,
}

/// How an unsubscribe request went out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnsubscribeMethod {
    OneClick,
    Mail,
    Web,
}

/// A reusable message: inserted into the composer by name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Template {
    pub id: String,
    pub name: String,
    /// Fills the subject when it's empty.
    pub subject: String,
    pub html: String,
    pub updated: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateInput {
    /// Absent for a new template.
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub subject: String,
    pub html: String,
}

/// The signature added to new messages and replies from one account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Signature {
    pub account_id: String,
    pub html: String,
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
    /// Bring the conversation back this many seconds after sending if
    /// nobody has replied by then.
    #[serde(default)]
    pub follow_up_after: Option<i64>,
    /// Ask for a read receipt (`Disposition-Notification-To`, RFC 8098).
    /// The recipient's app decides whether to send one (ADR-0055).
    #[serde(default)]
    pub request_receipt: bool,
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
    /// Sent later on purpose, rather than after the undo window.
    #[serde(default)]
    pub scheduled: bool,
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
    /// Minutes to get there, blocked out before the start (ADR-0029).
    /// `None` keeps it as it is; `Some(0)` removes it.
    #[serde(default)]
    pub travel: Option<i64>,
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
    /// For a reply: the guest and their answer. For a counter-proposal: who proposed.
    pub from: Option<Attendee>,
    /// Events in your visible calendars at the same time (requests and counter-proposals).
    #[serde(default)]
    pub conflicts: Vec<Occurrence>,
    /// For a counter-proposal: your event's time now, to compare.
    #[serde(default)]
    pub current_start: Option<i64>,
    #[serde(default)]
    pub current_end: Option<i64>,
    /// The guest's note (COMMENT) on a reply or counter-proposal.
    #[serde(default)]
    pub comment: Option<String>,
    /// For a counter-proposal you've answered: "accepted" or "declined".
    #[serde(default)]
    pub answered: Option<String>,
    /// For an invitation: the new time you proposed, if you did.
    #[serde(default)]
    pub proposed: Option<TimeSlot>,
    /// The call the invitation is for (ADR-0030).
    #[serde(default)]
    pub meeting: Option<crate::meeting::MeetingInfo>,
    #[serde(default)]
    pub manage: Vec<crate::meeting::ManageLink>,
}

/// A free stretch of time, from "find a time".
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeSlot {
    pub start: i64,
    pub end: i64,
}

/// A saved set of visible calendars ("Work", "Personal"), switched with one tap.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarSet {
    pub id: String,
    pub name: String,
    pub calendar_ids: Vec<String>,
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
    /// Labels (vCard CATEGORIES). None leaves a card's labels as they are.
    #[serde(default)]
    pub labels: Option<Vec<String>>,
    /// A `data:image/…;base64` photo. None leaves the photo as it is; an
    /// empty string removes it.
    #[serde(default)]
    pub photo: Option<String>,
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
    /// A video-call link found in the location (Zoom, Meet, Teams…).
    #[serde(default)]
    pub meeting_url: Option<String>,
    /// For a birthday: the contact it belongs to (open them, not an event).
    #[serde(default)]
    pub contact_id: Option<String>,
    /// Minutes to get there, blocked out before `start` (ADR-0029).
    #[serde(default)]
    pub travel: Option<i64>,
    /// `meeting_url` in its service's app (Zoom, Teams), when it has one (ADR-0030).
    #[serde(default)]
    pub meeting_app_url: Option<String>,
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
    /// The call, as the invitation describes it (ADR-0030).
    #[serde(default)]
    pub meeting: Option<crate::meeting::MeetingInfo>,
    /// Reschedule and cancel links from the booking tool that made it.
    #[serde(default)]
    pub manage: Vec<crate::meeting::ManageLink>,
}

/// Who sent a message, beside it in the mail pane (ADR-0036): their card if
/// they're a contact, what you've done together, and how long you've known them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SenderProfile {
    pub email: String,
    /// The name on their newest message, for people who aren't contacts.
    pub name: Option<String>,
    pub contact: Option<ContactDetail>,
    /// Messages from them on this device.
    pub received: u32,
    /// Their first message here (Unix seconds).
    pub first_seen: Option<i64>,
    pub activity: ContactActivity,
    /// Their offset from UTC in minutes, from the Date header of their newest
    /// personal message (ADR-0040). `None` for automated mail, or none known.
    pub local_offset: Option<i32>,
    /// When that message was sent, since the offset is only as fresh as it.
    pub offset_seen: Option<i64>,
}

/// Someone's clock, from their own mail (ADR-0040), for the composer (ADR-0041).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTime {
    pub email: String,
    /// The name on their newest message, if any.
    pub name: Option<String>,
    /// Minutes east of UTC.
    pub offset: i32,
    /// When the message it came from was sent.
    pub seen: i64,
}

/// What you've done with someone: recent conversations, and meetings they're in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactActivity {
    /// Newest first, one row per conversation.
    pub threads: Vec<MessageSummary>,
    /// Soonest first.
    pub upcoming: Vec<Occurrence>,
    /// Most recent first.
    pub past: Vec<Occurrence>,
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
    /// "Time to leave": fires when its travel time begins (ADR-0029).
    #[serde(default)]
    pub leave: bool,
    /// A note's own reminder (ADR-0039) rather than an event's: `event_id`
    /// is empty, `title` is the note's, and `start` is the reminder time.
    #[serde(default)]
    pub note_id: Option<String>,
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
    /// vCard CATEGORIES, in the card's order.
    #[serde(default)]
    pub labels: Vec<String>,
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
    /// Created where the server chose (Microsoft Graph picks its own ids):
    /// the item's new href, and its etag when known.
    Created(String, Option<String>),
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

// ── Notes ───────────────────────────────────────────────────────────────────

/// What a note can be linked to. Links use keys that are the same on every
/// device, so they survive sync: an event's iCalendar `UID`, a contact's
/// vCard `UID`, and a conversation's first `Message-ID`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NoteLinkKind {
    Event,
    Contact,
    Thread,
}

impl NoteLinkKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Event => "event",
            Self::Contact => "contact",
            Self::Thread => "thread",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteLink {
    pub kind: NoteLinkKind,
    /// The stable key (see [`NoteLinkKind`]).
    pub key: String,
    /// What to show when the target isn't on this device (yet).
    pub label: String,
    /// The target's id in this device's store, when it's here. Ignored on input.
    #[serde(default)]
    pub target: Option<String>,
}

/// Who a shared note belongs to (ADR-0056).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ShareRole {
    /// You shared it: its text syncs through your relay, under its share id.
    Owner,
    /// Someone shared it with you: its text syncs through their relay.
    Guest,
}

/// What a share link lets the other person do.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ShareMode {
    #[default]
    Edit,
    View,
}

/// A note shared by link (ADR-0056). Its text is its own Yjs document on the
/// owner's relay, `mailbird/shared/<id>`, which the link's token opens.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteShare {
    /// 16 to 64 letters, digits, `-`, or `_`.
    pub id: String,
    pub role: ShareRole,
    #[serde(default)]
    pub mode: ShareMode,
    /// The owner stopped sharing. An owner's stays, so the relay keeps
    /// refusing the old link; a guest's note becomes their own copy.
    #[serde(default)]
    pub revoked: bool,
    /// A guest's: the owner's relay and the link's token.
    #[serde(default)]
    pub relay: Option<String>,
    #[serde(default)]
    pub token: Option<String>,
    /// A guest's: who shared it, as the link names them.
    #[serde(default)]
    pub from: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSummary {
    pub id: String,
    /// The first line of the note, without Markdown marks.
    pub title: String,
    /// The next bit of text after the title, for lists.
    pub snippet: String,
    pub pinned: bool,
    pub archived: bool,
    /// One of [`NOTE_COLORS`](crate::NOTE_COLORS), or `None` for the plain card.
    pub color: Option<String>,
    /// When to bring the note back (Unix seconds). It stays set after it
    /// fires, so the note shows as due until it's marked done.
    pub remind_at: Option<i64>,
    /// Its text is sealed with the notes passphrase (ADR-0043); only the
    /// title is readable.
    #[serde(default)]
    pub locked: bool,
    /// The first image the text shows, for a card's thumbnail (ADR-0044).
    #[serde(default)]
    pub cover: Option<String>,
    /// Shared by link, or shared with you (ADR-0056).
    #[serde(default)]
    pub share: Option<NoteShare>,
    pub tags: Vec<String>,
    pub links: Vec<NoteLink>,
    pub created: i64,
    pub updated: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteDetail {
    #[serde(flatten)]
    pub summary: NoteSummary,
    /// The note itself, as Markdown. This is what export and search read.
    pub markdown: String,
    /// The note's Yjs document (a base64 state update), once an editor has
    /// opened it. Sync merges this; Markdown is derived from it.
    pub ydoc: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteInput {
    pub markdown: String,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub links: Vec<NoteLink>,
    /// A note someone shared with you, added from their link (ADR-0056).
    #[serde(default)]
    pub share: Option<NoteShare>,
}

/// Everything about a note except its text. `None` leaves a field as it is.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteMeta {
    pub pinned: Option<bool>,
    pub archived: Option<bool>,
    /// A color name, or `""` for none.
    pub color: Option<String>,
    /// A reminder time, or `0` for none.
    pub remind_at: Option<i64>,
    pub tags: Option<Vec<String>>,
    pub links: Option<Vec<NoteLink>>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteQuery {
    pub search: Option<String>,
    pub tag: Option<String>,
    #[serde(default)]
    pub archived: bool,
    /// Only notes linked to this target.
    pub linked: Option<NoteTarget>,
    /// Only notes in this smart folder (ADR-0042).
    #[serde(default)]
    pub folder: Option<String>,
}

/// An event, contact, or conversation by its id on this device.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteTarget {
    pub kind: NoteLinkKind,
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagCount {
    pub tag: String,
    pub count: u32,
}

/// One file handed to the importer: its path inside the folder that was
/// picked (folders become tags) and its text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportFile {
    pub path: String,
    #[serde(default)]
    pub contents: String,
    /// The file's modified time (Unix seconds), when the picker knows it.
    #[serde(default)]
    pub modified: Option<i64>,
    /// An image's bytes (base64), sent for the images notes show (ADR-0044).
    #[serde(default)]
    pub data_base64: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub imported: u32,
    /// Already imported before (same file), so left alone.
    pub duplicates: u32,
    /// In the source app's trash.
    pub trashed: u32,
    /// Images it couldn't find, and audio, PDFs, and drawings, which aren't brought over.
    pub attachments_dropped: u32,
    /// Files that weren't notes we could read.
    pub skipped: Vec<String>,
}

/// A note's sync record: everything but the text, which syncs separately as
/// its own Yjs document. The newest `updated` wins.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteRecord {
    pub id: String,
    pub pinned: bool,
    pub archived: bool,
    pub deleted: bool,
    /// Devices from before colors (ADR-0038) leave it out.
    #[serde(default)]
    pub color: Option<String>,
    /// Devices from before note reminders (ADR-0039) leave it out.
    #[serde(default)]
    pub remind_at: Option<i64>,
    /// A locked note (ADR-0043) carries its sealed text and its title here,
    /// since its Yjs document stays empty.
    #[serde(default)]
    pub locked: bool,
    #[serde(default)]
    pub sealed: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    /// Devices from before shared notes (ADR-0056) leave it out.
    #[serde(default)]
    pub share: Option<NoteShare>,
    pub tags: Vec<String>,
    pub links: Vec<NoteLink>,
    pub created: i64,
    pub updated: i64,
}
