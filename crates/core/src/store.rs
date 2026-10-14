//! The local database. One SQLite file per device holds accounts, messages,
//! attachments, the outbox, and changes still waiting to reach the server.
//!
//! Field ownership matters during sync:
//! - **Server-owned:** content, `seen`, and `flagged` (unless a local change is pending).
//! - **Device-owned:** `snoozed_until`, `sort_at`, `archived`, and `thread_id`.
//!   IMAP has no server-side snooze (see `Capabilities::server_side_scheduling`),
//!   so a re-sync never clobbers these.
//!
//! Lists are grouped by conversation. Threads are built from `Message-ID`,
//! `In-Reply-To`, and `References` (no subject guessing, which merges
//! unrelated mail). Copies of mail sent from this device live in mailbox
//! `Sent`, so your replies appear inside conversations.

use std::collections::BTreeSet;

use base64::Engine;
use rusqlite::{Connection, OptionalExtension, Row, params};

use crate::{
    Account, AccountConfig, Address, AttachmentInfo, Draft, Error, Lane,
    MessageDetail, MessageQuery, MessageSummary, OpKind, OutboxItem, OutboxState, PendingOp,
    RemoteBatch, RemoteCursor, RemoteOp, Result, SyncBatch, SyncCursor, mime, now,
};

/// Store mailbox names. Server mailboxes map onto these by role (RFC 6154
/// special-use for IMAP, `role` for JMAP), whatever the server calls them.
pub const INBOX: &str = "INBOX";
/// Sent mail: server copies, plus local copies of mail sent from this device.
pub const SENT: &str = "Sent";
/// The server's archive mailbox. Rows here are always `archived`.
pub const ARCHIVE: &str = "Archive";
/// `sync_state` key for an account's JMAP state (account-wide, not per mailbox).
const JMAP_STATE: &str = "*jmap";

const SCHEMA_VERSION: i64 = 4;

/// Version 1: the Phase 1 schema.
const SCHEMA_V1: &str = r#"
CREATE TABLE accounts (
  id           TEXT PRIMARY KEY,
  config       TEXT NOT NULL,          -- AccountConfig as JSON (no secrets)
  last_sync    INTEGER,
  last_error   TEXT,
  created_at   INTEGER NOT NULL
);

CREATE TABLE messages (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  mailbox       TEXT NOT NULL,
  uid           INTEGER,                -- NULL for messages that never came from IMAP
  message_id    TEXT,
  from_name     TEXT,
  from_email    TEXT NOT NULL,
  to_json       TEXT NOT NULL,
  cc_json       TEXT NOT NULL,
  subject       TEXT NOT NULL,
  preview       TEXT NOT NULL,
  body_text     TEXT NOT NULL,
  body_html     TEXT,
  date          INTEGER NOT NULL,
  sort_at       INTEGER NOT NULL,
  seen          INTEGER NOT NULL DEFAULT 0,
  flagged       INTEGER NOT NULL DEFAULT 0,
  archived      INTEGER NOT NULL DEFAULT 0,
  snoozed_until INTEGER,
  UNIQUE (account_id, mailbox, uid)
);
CREATE INDEX messages_sort ON messages (archived, sort_at DESC);
CREATE INDEX messages_snooze ON messages (snoozed_until) WHERE snoozed_until IS NOT NULL;

CREATE VIRTUAL TABLE messages_fts USING fts5(
  subject, from_name, from_email, body_text,
  content = 'messages', content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (rowid, subject, from_name, from_email, body_text)
  VALUES (new.rowid, new.subject, new.from_name, new.from_email, new.body_text);
END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, subject, from_name, from_email, body_text)
  VALUES ('delete', old.rowid, old.subject, old.from_name, old.from_email, old.body_text);
END;
CREATE TRIGGER messages_au AFTER UPDATE OF subject, from_name, from_email, body_text ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, subject, from_name, from_email, body_text)
  VALUES ('delete', old.rowid, old.subject, old.from_name, old.from_email, old.body_text);
  INSERT INTO messages_fts (rowid, subject, from_name, from_email, body_text)
  VALUES (new.rowid, new.subject, new.from_name, new.from_email, new.body_text);
END;

CREATE TABLE sync_state (
  account_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  mailbox       TEXT NOT NULL,
  uid_validity  INTEGER NOT NULL,
  last_uid      INTEGER NOT NULL,
  PRIMARY KEY (account_id, mailbox)
);

CREATE TABLE pending_ops (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,           -- seen | unseen | flag | unflag | archive
  created_at  INTEGER NOT NULL
);

CREATE TABLE outbox (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  draft       TEXT NOT NULL,           -- Draft as JSON
  send_at     INTEGER NOT NULL,
  state       TEXT NOT NULL,
  error       TEXT,
  created_at  INTEGER NOT NULL
);
"#;

/// Version 2: conversations, attachments, and the raw message (so
/// attachments can be decoded on demand without re-downloading).
const MIGRATE_V2: &str = r#"
ALTER TABLE messages ADD COLUMN thread_id TEXT;
ALTER TABLE messages ADD COLUMN has_attachments INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN raw BLOB;
UPDATE messages SET thread_id = id WHERE thread_id IS NULL;
CREATE INDEX messages_thread ON messages (thread_id);
CREATE INDEX messages_msgid ON messages (account_id, message_id);

CREATE TABLE message_refs (
  message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  ref         TEXT NOT NULL
);
CREATE INDEX message_refs_ref ON message_refs (ref);

CREATE TABLE attachments (
  id          TEXT PRIMARY KEY,
  message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL,
  filename    TEXT NOT NULL,
  mime_type   TEXT NOT NULL,
  size        INTEGER NOT NULL,
  content_id  TEXT,
  inline      INTEGER NOT NULL
);
CREATE INDEX attachments_message ON attachments (message_id);
"#;

/// Version 3: string server ids (JMAP) beside IMAP UIDs, and the server's
/// state string for resuming a JMAP sync.
const MIGRATE_V3: &str = r#"
ALTER TABLE messages ADD COLUMN remote_id TEXT;
CREATE UNIQUE INDEX messages_remote ON messages (account_id, mailbox, remote_id) WHERE remote_id IS NOT NULL;
ALTER TABLE sync_state ADD COLUMN state TEXT;
"#;

/// Inline images larger than this stay out of the HTML (kept as attachments).
const MAX_INLINE_IMAGE: u64 = 3 * 1024 * 1024;

pub struct Store {
    pub(crate) db: Connection,
}

impl Store {
    pub fn open(path: impl AsRef<std::path::Path>) -> Result<Self> {
        Self::init(Connection::open(path)?)
    }

    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(db: Connection) -> Result<Self> {
        db.pragma_update(None, "journal_mode", "WAL")?;
        db.pragma_update(None, "foreign_keys", true)?;
        let version: i64 = db.pragma_query_value(None, "user_version", |r| r.get(0))?;
        if version > SCHEMA_VERSION {
            return Err(Error::Invalid(
                "this database was created by a newer version of the app".into(),
            ));
        }
        let tx = db.unchecked_transaction()?;
        if version < 1 {
            tx.execute_batch(SCHEMA_V1)?;
        }
        if version < 2 {
            tx.execute_batch(MIGRATE_V2)?;
        }
        if version < 3 {
            tx.execute_batch(MIGRATE_V3)?;
        }
        if version < 4 {
            tx.execute_batch(crate::pim_store::MIGRATE_V4)?;
        }
        tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        tx.commit()?;
        Ok(Self { db })
    }

    // ── Accounts ──────────────────────────────────────────────────────────

    pub fn add_account(&self, config: &AccountConfig) -> Result<Account> {
        if config.address.trim().is_empty() || !config.address.contains('@') {
            return Err(Error::Invalid("enter a full email address".into()));
        }
        let id = uuid::Uuid::new_v4().to_string();
        self.db.execute(
            "INSERT INTO accounts (id, config, created_at) VALUES (?1, ?2, ?3)",
            params![id, json(config), now()],
        )?;
        self.account(&id)
    }

    pub fn accounts(&self) -> Result<Vec<Account>> {
        let mut stmt = self
            .db
            .prepare("SELECT id, config, last_sync, last_error, dav_last_sync, dav_error FROM accounts ORDER BY created_at")?;
        let rows = stmt.query_map([], account_row)?;
        rows.collect::<rusqlite::Result<_>>().map_err(Into::into)
    }

    pub fn account(&self, id: &str) -> Result<Account> {
        self.db
            .query_row(
                "SELECT id, config, last_sync, last_error, dav_last_sync, dav_error FROM accounts WHERE id = ?1",
                [id],
                account_row,
            )
            .optional()?
            .ok_or_else(|| Error::NotFound("that account no longer exists".into()))
    }

    /// Connects (or disconnects, with `None`) calendars and contacts. Turning
    /// DAV off drops the account's synced collections and everything in them.
    pub fn set_account_dav(&self, id: &str, dav: Option<&crate::DavConfig>) -> Result<Account> {
        let mut account = self.account(id)?;
        account.config.dav = dav.cloned();
        self.db.execute("UPDATE accounts SET config = ?2, dav_error = NULL WHERE id = ?1", params![id, json(&account.config)])?;
        if dav.is_none() {
            self.db.execute("DELETE FROM collections WHERE account_id = ?1", [id])?;
        }
        self.account(id)
    }

    pub fn record_dav_result(&self, account_id: &str, error: Option<&str>) -> Result<()> {
        match error {
            None => self.db.execute("UPDATE accounts SET dav_last_sync = ?2, dav_error = NULL WHERE id = ?1", params![account_id, now()])?,
            Some(e) => self.db.execute("UPDATE accounts SET dav_error = ?2 WHERE id = ?1", params![account_id, e])?,
        };
        Ok(())
    }

    pub fn remove_account(&self, id: &str) -> Result<()> {
        self.db.execute("DELETE FROM accounts WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn record_sync_result(&self, account_id: &str, error: Option<&str>) -> Result<()> {
        match error {
            None => self.db.execute(
                "UPDATE accounts SET last_sync = ?2, last_error = NULL WHERE id = ?1",
                params![account_id, now()],
            )?,
            Some(e) => self.db.execute(
                "UPDATE accounts SET last_error = ?2 WHERE id = ?1",
                params![account_id, e],
            )?,
        };
        Ok(())
    }

    // ── Reading ──────────────────────────────────────────────────────────

    /// One row per conversation: the newest message that matches the lane,
    /// with read/starred/attachment state rolled up across the thread.
    pub fn messages(&self, q: &MessageQuery) -> Result<Vec<MessageSummary>> {
        let t = now();
        let mut from = String::from("messages m");
        let mut clauses: Vec<String> = Vec::new();
        let mut args: Vec<rusqlite::types::Value> = Vec::new();

        if let Some(search) = q.search.as_deref().map(fts_query).filter(|s| !s.is_empty()) {
            from.push_str(" JOIN messages_fts f ON f.rowid = m.rowid");
            clauses.push("messages_fts MATCH ?".into());
            args.push(search.into());
        }
        if let Some(account) = &q.account_id {
            clauses.push("m.account_id = ?".into());
            args.push(account.clone().into());
        }
        let awake = "(m.snoozed_until IS NULL OR m.snoozed_until <= ?)";
        // Sent copies belong to conversations but never make a thread "in the inbox".
        let received = format!("m.mailbox <> '{SENT}'");
        match q.lane {
            Lane::Inbox => {
                clauses.push(format!("{received} AND m.archived = 0 AND {awake}"));
                args.push(t.into());
            }
            Lane::Unread => {
                clauses.push(format!("{received} AND m.archived = 0 AND m.seen = 0 AND {awake}"));
                args.push(t.into());
            }
            Lane::Starred => clauses.push("m.flagged = 1".into()),
            Lane::Snoozed => {
                clauses.push(format!("{received} AND m.snoozed_until > ?"));
                args.push(t.into());
            }
            Lane::Archive => clauses.push(format!("{received} AND m.archived = 1")),
        }
        let order = if q.lane == Lane::Snoozed { "snoozed_until ASC" } else { "sort_at DESC" };
        args.push(i64::from(q.limit.unwrap_or(200).min(1000)).into());

        let sql = format!(
            "WITH lane AS (
               SELECT m.* FROM {from} WHERE {where_}
             ), ranked AS (
               SELECT lane.*,
                 ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY sort_at DESC) AS rn,
                 MIN(seen) OVER (PARTITION BY thread_id) AS thread_seen
               FROM lane
             )
             SELECT {SUMMARY_COLS_RANKED} FROM ranked m
             WHERE rn = 1 ORDER BY {order} LIMIT ?",
            where_ = clauses.join(" AND "),
        );
        let mut stmt = self.db.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(args), summary_row)?;
        rows.collect::<rusqlite::Result<_>>().map_err(Into::into)
    }

    /// One message, with attachments and `cid:` images resolved.
    pub fn message(&self, id: &str) -> Result<MessageDetail> {
        let mut detail = self
            .db
            .query_row(
                &format!(
                    "SELECT {SUMMARY_COLS_PLAIN}, m.to_json, m.cc_json, m.message_id, m.body_text, m.body_html
                     FROM messages m WHERE m.id = ?1"
                ),
                [id],
                detail_row,
            )
            .optional()?
            .ok_or_else(|| Error::NotFound("that message is no longer here".into()))?;
        detail.attachments = self.attachments_of(id)?;
        let mut stmt = self.db.prepare_cached("SELECT ref FROM message_refs WHERE message_id = ?1 ORDER BY rowid")?;
        detail.references = stmt.query_map([id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        drop(stmt);
        if detail.body_html.as_deref().is_some_and(|h| h.contains("cid:")) {
            detail.body_html = Some(self.inline_cid_images(id, detail.body_html.take().unwrap())?);
        }
        Ok(detail)
    }

    /// The whole conversation, oldest first.
    pub fn thread(&self, thread_id: &str) -> Result<Vec<MessageDetail>> {
        let ids: Vec<String> = {
            let mut stmt = self
                .db
                .prepare("SELECT id FROM messages WHERE thread_id = ?1 ORDER BY date ASC, rowid ASC")?;
            stmt.query_map([thread_id], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?
        };
        if ids.is_empty() {
            return Err(Error::NotFound("that conversation is no longer here".into()));
        }
        ids.iter().map(|id| self.message(id)).collect()
    }

    fn attachments_of(&self, message_id: &str) -> Result<Vec<AttachmentInfo>> {
        let mut stmt = self.db.prepare(
            "SELECT id, filename, mime_type, size, inline FROM attachments WHERE message_id = ?1 ORDER BY idx",
        )?;
        let rows = stmt.query_map([message_id], |r| {
            Ok(AttachmentInfo {
                id: r.get(0)?,
                filename: r.get(1)?,
                mime_type: r.get(2)?,
                size: r.get::<_, i64>(3)? as u64,
                inline: r.get(4)?,
            })
        })?;
        rows.collect::<rusqlite::Result<_>>().map_err(Into::into)
    }

    /// An attachment's metadata and decoded bytes.
    pub fn attachment(&self, id: &str) -> Result<(AttachmentInfo, Vec<u8>)> {
        let (info, idx, raw): (AttachmentInfo, u32, Option<Vec<u8>>) = self
            .db
            .query_row(
                "SELECT a.id, a.filename, a.mime_type, a.size, a.inline, a.idx, m.raw
                 FROM attachments a JOIN messages m ON m.id = a.message_id WHERE a.id = ?1",
                [id],
                |r| {
                    Ok((
                        AttachmentInfo {
                            id: r.get(0)?,
                            filename: r.get(1)?,
                            mime_type: r.get(2)?,
                            size: r.get::<_, i64>(3)? as u64,
                            inline: r.get(4)?,
                        },
                        r.get(5)?,
                        r.get(6)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| Error::NotFound("that attachment is no longer here".into()))?;
        let bytes = raw
            .and_then(|raw| mime::attachment_bytes(&raw, idx))
            .ok_or_else(|| Error::NotFound("this attachment's contents aren't on this device".into()))?;
        Ok((info, bytes))
    }

    /// Replace `cid:` references with data URLs, so embedded images show
    /// inside the sandboxed frame without any network access.
    fn inline_cid_images(&self, message_id: &str, html: String) -> Result<String> {
        let raw: Option<Vec<u8>> =
            self.db.query_row("SELECT raw FROM messages WHERE id = ?1", [message_id], |r| r.get(0))?;
        let Some(raw) = raw else { return Ok(html) };
        let mut stmt = self.db.prepare(
            "SELECT idx, mime_type, content_id, size FROM attachments
             WHERE message_id = ?1 AND content_id IS NOT NULL",
        )?;
        let cids: Vec<(u32, String, String, u64)> = stmt
            .query_map([message_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get::<_, i64>(3)? as u64)))?
            .collect::<rusqlite::Result<_>>()?;
        let mut html = html;
        for (idx, mime_type, cid, size) in cids {
            if size > MAX_INLINE_IMAGE || !mime_type.starts_with("image/") {
                continue;
            }
            if let Some(bytes) = mime::attachment_bytes(&raw, idx) {
                let data = base64::engine::general_purpose::STANDARD.encode(bytes);
                html = html.replace(&format!("cid:{cid}"), &format!("data:{mime_type};base64,{data}"));
            }
        }
        Ok(html)
    }

    // ── Local actions on one message (each queues an op for the server) ──

    pub fn set_seen(&self, id: &str, seen: bool) -> Result<()> {
        self.update_flag(id, "seen", seen, if seen { "seen" } else { "unseen" })
    }

    pub fn set_flagged(&self, id: &str, flagged: bool) -> Result<()> {
        self.update_flag(id, "flagged", flagged, if flagged { "flag" } else { "unflag" })
    }

    fn update_flag(&self, id: &str, column: &str, value: bool, op: &str) -> Result<()> {
        let n = self
            .db
            .execute(&format!("UPDATE messages SET {column} = ?2 WHERE id = ?1"), params![id, value])?;
        if n == 0 {
            return Err(Error::NotFound("that message is no longer here".into()));
        }
        self.queue_op(id, op)
    }

    /// Archive or un-archive. Mail in the inbox queues a move to the server's
    /// archive mailbox; mail already in it queues a move back. Toggling twice
    /// before a sync cancels out, so nothing reaches the server.
    pub fn set_archived(&self, id: &str, archived: bool) -> Result<()> {
        let mailbox: String = self
            .db
            .query_row("SELECT mailbox FROM messages WHERE id = ?1", [id], |r| r.get(0))
            .optional()?
            .ok_or_else(|| Error::NotFound("that message is no longer here".into()))?;
        self.db
            .execute("UPDATE messages SET archived = ?2 WHERE id = ?1", params![id, archived])?;
        let (forward, back) = if mailbox == ARCHIVE { ("unarchive", "archive") } else { ("archive", "unarchive") };
        // `archived` is the state the user wants; the op is whatever move gets the server there.
        let wants_move = (mailbox == ARCHIVE) != archived;
        self.db.execute(
            "DELETE FROM pending_ops WHERE message_id = ?1 AND kind IN (?2, ?3)",
            params![id, forward, back],
        )?;
        if wants_move {
            self.queue_op(id, forward)?;
        }
        Ok(())
    }

    /// Hide a message until `until`. It comes back at the top of the inbox, unread.
    pub fn snooze(&self, id: &str, until: i64) -> Result<()> {
        if until <= now() {
            return Err(Error::Invalid("pick a time in the future".into()));
        }
        let n = self.db.execute(
            "UPDATE messages SET snoozed_until = ?2, archived = 0 WHERE id = ?1",
            params![id, until],
        )?;
        if n == 0 {
            return Err(Error::NotFound("that message is no longer here".into()));
        }
        Ok(())
    }

    pub fn unsnooze(&self, id: &str) -> Result<()> {
        self.db
            .execute("UPDATE messages SET snoozed_until = NULL WHERE id = ?1", [id])?;
        Ok(())
    }

    // ── Conversation actions (what the UI triages) ───────────────────────

    /// Received messages in a thread that a thread action should touch.
    fn thread_members(&self, thread_id: &str, extra: &str) -> Result<Vec<String>> {
        let mut stmt = self.db.prepare(&format!(
            "SELECT id FROM messages WHERE thread_id = ?1 AND mailbox <> '{SENT}' {extra}"
        ))?;
        let ids: Vec<String> = stmt
            .query_map([thread_id], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        if ids.is_empty() && extra.is_empty() {
            return Err(Error::NotFound("that conversation is no longer here".into()));
        }
        Ok(ids)
    }

    pub fn set_thread_seen(&self, thread_id: &str, seen: bool) -> Result<()> {
        let tx = self.db.unchecked_transaction()?;
        self.thread_members(thread_id, "")?;
        // Only rows that change get an op, so reading a thread doesn't re-flag old mail.
        for id in self.thread_members(thread_id, &format!("AND seen <> {}", seen as i32))? {
            self.set_seen(&id, seen)?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Starring stars the newest message; unstarring clears the whole thread.
    pub fn set_thread_flagged(&self, thread_id: &str, flagged: bool) -> Result<()> {
        let tx = self.db.unchecked_transaction()?;
        if flagged {
            let newest: String = self
                .db
                .query_row(
                    &format!(
                        "SELECT id FROM messages WHERE thread_id = ?1 AND mailbox <> '{SENT}'
                         ORDER BY sort_at DESC LIMIT 1"
                    ),
                    [thread_id],
                    |r| r.get(0),
                )
                .optional()?
                .ok_or_else(|| Error::NotFound("that conversation is no longer here".into()))?;
            self.set_flagged(&newest, true)?;
        } else {
            for id in self.thread_members(thread_id, "AND flagged = 1")? {
                self.set_flagged(&id, false)?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn set_thread_archived(&self, thread_id: &str, archived: bool) -> Result<()> {
        let tx = self.db.unchecked_transaction()?;
        self.thread_members(thread_id, "")?;
        for id in self.thread_members(thread_id, &format!("AND archived <> {}", archived as i32))? {
            self.set_archived(&id, archived)?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn snooze_thread(&self, thread_id: &str, until: i64) -> Result<()> {
        if until <= now() {
            return Err(Error::Invalid("pick a time in the future".into()));
        }
        let tx = self.db.unchecked_transaction()?;
        for id in self.thread_members(thread_id, "AND archived = 0")? {
            self.snooze(&id, until)?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn unsnooze_thread(&self, thread_id: &str) -> Result<()> {
        self.db.execute(
            "UPDATE messages SET snoozed_until = NULL WHERE thread_id = ?1",
            [thread_id],
        )?;
        Ok(())
    }

    /// Resurface every snooze that is due. Returns how many woke up.
    pub fn wake_snoozed(&self, at: i64) -> Result<usize> {
        let tx = self.db.unchecked_transaction()?;
        let ids: Vec<String> = {
            let mut stmt = tx.prepare(
                "SELECT id FROM messages WHERE snoozed_until IS NOT NULL AND snoozed_until <= ?1",
            )?;
            stmt.query_map([at], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?
        };
        for id in &ids {
            tx.execute(
                "UPDATE messages SET snoozed_until = NULL, sort_at = ?2, seen = 0 WHERE id = ?1",
                params![id, at],
            )?;
            tx.execute(
                "INSERT INTO pending_ops (message_id, kind, created_at) VALUES (?1, 'unseen', ?2)",
                params![id, at],
            )?;
        }
        tx.commit()?;
        Ok(ids.len())
    }

    fn queue_op(&self, message_id: &str, kind: &str) -> Result<()> {
        // Sent copies aren't on a server mailbox we sync; nothing to push.
        let on_server: bool = self.db.query_row(
            "SELECT uid IS NOT NULL OR remote_id IS NOT NULL FROM messages WHERE id = ?1",
            [message_id],
            |r| r.get(0),
        )?;
        if !on_server {
            return Ok(());
        }
        // A newer op on the same flag replaces the older one (seen then unseen = unseen).
        let family: &[&str] = match kind {
            "seen" | "unseen" => &["seen", "unseen"],
            "flag" | "unflag" => &["flag", "unflag"],
            _ => &[],
        };
        for k in family {
            self.db.execute(
                "DELETE FROM pending_ops WHERE message_id = ?1 AND kind = ?2",
                params![message_id, k],
            )?;
        }
        self.db.execute(
            "INSERT INTO pending_ops (message_id, kind, created_at) VALUES (?1, ?2, ?3)",
            params![message_id, kind, now()],
        )?;
        Ok(())
    }

    // ── Sync ──────────────────────────────────────────────────────────────

    pub fn sync_cursor(&self, account_id: &str, mailbox: &str) -> Result<SyncCursor> {
        let mut cursor = self
            .db
            .query_row(
                "SELECT uid_validity, last_uid FROM sync_state WHERE account_id = ?1 AND mailbox = ?2",
                params![account_id, mailbox],
                |r| Ok(SyncCursor { uid_validity: Some(r.get(0)?), last_uid: r.get(1)?, oldest_uid: None }),
            )
            .optional()?
            .unwrap_or_default();
        cursor.oldest_uid = self.db.query_row(
            "SELECT MIN(uid) FROM messages WHERE account_id = ?1 AND mailbox = ?2",
            params![account_id, mailbox],
            |r| r.get(0),
        )?;
        Ok(cursor)
    }

    /// Local changes for one IMAP mailbox that still need to reach the server.
    pub fn pending_ops(&self, account_id: &str, mailbox: &str) -> Result<Vec<PendingOp>> {
        Ok(self
            .ops_where(account_id, mailbox, "m.uid")?
            .into_iter()
            .map(|(id, uid, kind): (i64, u32, OpKind)| PendingOp { id, uid, kind })
            .collect())
    }

    /// Pending ops joined to the message's server key (`m.uid` or `m.remote_id`).
    fn ops_where<K: rusqlite::types::FromSql>(&self, account_id: &str, mailbox: &str, key: &str) -> Result<Vec<(i64, K, OpKind)>> {
        let mut stmt = self.db.prepare(&format!(
            "SELECT o.id, {key}, o.kind FROM pending_ops o JOIN messages m ON m.id = o.message_id
             WHERE m.account_id = ?1 AND m.mailbox = ?2 AND {key} IS NOT NULL ORDER BY o.id"
        ))?;
        let rows = stmt.query_map(params![account_id, mailbox], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, K>(1)?, r.get::<_, String>(2)?))
        })?;
        let mut ops = Vec::new();
        for row in rows {
            let (id, key, kind) = row?;
            let kind = match kind.as_str() {
                "seen" => OpKind::Seen(true),
                "unseen" => OpKind::Seen(false),
                "flag" => OpKind::Flagged(true),
                "unflag" => OpKind::Flagged(false),
                "archive" => OpKind::Archive,
                "unarchive" => OpKind::Unarchive,
                _ => continue,
            };
            ops.push((id, key, kind));
        }
        Ok(ops)
    }

    /// Apply one sync pass atomically. Returns the number of new messages.
    pub fn apply_sync(&self, account_id: &str, batch: &SyncBatch) -> Result<usize> {
        let tx = self.db.unchecked_transaction()?;
        let cursor = self.sync_cursor(account_id, &batch.mailbox)?;

        // UIDVALIDITY changed: every UID we hold is meaningless. Start over.
        if cursor.uid_validity.is_some_and(|v| v != batch.uid_validity) {
            tx.execute(
                "DELETE FROM messages WHERE account_id = ?1 AND mailbox = ?2",
                params![account_id, batch.mailbox],
            )?;
        }

        for op in &batch.applied_ops {
            tx.execute("DELETE FROM pending_ops WHERE id = ?1", [op])?;
        }
        for uid in &batch.moved_out {
            tx.execute(
                "DELETE FROM messages WHERE account_id = ?1 AND mailbox = ?2 AND uid = ?3",
                params![account_id, batch.mailbox, uid],
            )?;
        }

        let mut inserted = 0;
        for m in &batch.new_messages {
            if insert_message(&tx, account_id, &batch.mailbox, ServerKey::Uid(m.uid), &m.raw, m.seen, m.flagged)?.is_some() {
                inserted += 1;
            }
        }

        // Server flags win, except where a local change hasn't reached it yet.
        for (uid, seen, flagged) in &batch.flags {
            tx.execute(
                "UPDATE messages SET
                   seen = CASE WHEN EXISTS (SELECT 1 FROM pending_ops o WHERE o.message_id = messages.id
                          AND o.kind IN ('seen','unseen')) THEN seen ELSE ?4 END,
                   flagged = CASE WHEN EXISTS (SELECT 1 FROM pending_ops o WHERE o.message_id = messages.id
                          AND o.kind IN ('flag','unflag')) THEN flagged ELSE ?5 END
                 WHERE account_id = ?1 AND mailbox = ?2 AND uid = ?3",
                params![account_id, batch.mailbox, uid, seen, flagged],
            )?;
        }

        // Mail deleted (or archived elsewhere) on the server disappears here too,
        // unless we archived it ourselves and are keeping the local copy.
        if !batch.server_uids.is_empty() || !batch.new_messages.is_empty() || cursor.last_uid > 0 {
            let keep: std::collections::HashSet<u32> = batch.server_uids.iter().copied().collect();
            let mut stmt = tx.prepare(
                "SELECT id, uid FROM messages WHERE account_id = ?1 AND mailbox = ?2
                 AND uid IS NOT NULL AND archived = 0",
            )?;
            let gone: Vec<String> = stmt
                .query_map(params![account_id, batch.mailbox], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, u32>(1)?))
                })?
                .filter_map(|r| r.ok())
                .filter(|(_, uid)| !keep.contains(uid))
                .map(|(id, _)| id)
                .collect();
            drop(stmt);
            for id in gone {
                tx.execute("DELETE FROM messages WHERE id = ?1", [id])?;
            }
        }

        let last_uid = batch
            .new_messages
            .iter()
            .map(|m| m.uid)
            .chain(batch.server_uids.iter().copied())
            .max()
            .unwrap_or(0)
            .max(if cursor.uid_validity == Some(batch.uid_validity) { cursor.last_uid } else { 0 });
        tx.execute(
            "INSERT INTO sync_state (account_id, mailbox, uid_validity, last_uid) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (account_id, mailbox) DO UPDATE SET uid_validity = ?3, last_uid = ?4",
            params![account_id, batch.mailbox, batch.uid_validity, last_uid],
        )?;
        tx.commit()?;
        Ok(inserted)
    }

    // ── Server-id sync (JMAP) ─────────────────────────────────────────────

    pub fn remote_cursor(&self, account_id: &str) -> Result<RemoteCursor> {
        let state: Option<String> = self
            .db
            .query_row(
                "SELECT state FROM sync_state WHERE account_id = ?1 AND mailbox = ?2",
                params![account_id, JMAP_STATE],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        let mut stmt = self
            .db
            .prepare("SELECT remote_id, mailbox FROM messages WHERE account_id = ?1 AND remote_id IS NOT NULL")?;
        let known = stmt
            .query_map([account_id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(RemoteCursor { state, known })
    }

    /// Every local change on this account still waiting for the JMAP server.
    pub fn pending_remote_ops(&self, account_id: &str) -> Result<Vec<RemoteOp>> {
        let mut ops = Vec::new();
        for mailbox in [INBOX, ARCHIVE, SENT] {
            ops.extend(
                self.ops_where(account_id, mailbox, "m.remote_id")?
                    .into_iter()
                    .map(|(id, remote_id, kind)| RemoteOp { id, remote_id, kind }),
            );
        }
        ops.sort_by_key(|o| o.id);
        Ok(ops)
    }

    /// Apply one JMAP sync pass atomically. Returns the number of new messages.
    pub fn apply_remote(&self, account_id: &str, batch: &RemoteBatch) -> Result<usize> {
        let tx = self.db.unchecked_transaction()?;
        if batch.reset {
            tx.execute(
                "DELETE FROM messages WHERE account_id = ?1 AND remote_id IS NOT NULL",
                [account_id],
            )?;
        }
        for op in &batch.applied_ops {
            tx.execute("DELETE FROM pending_ops WHERE id = ?1", [op])?;
        }
        for (remote_id, mailbox) in &batch.moved {
            tx.execute(
                "UPDATE messages SET mailbox = ?3, archived = ?4 WHERE account_id = ?1 AND remote_id = ?2",
                params![account_id, remote_id, mailbox, mailbox == ARCHIVE],
            )?;
        }
        let mut inserted = 0;
        for m in &batch.new_messages {
            if insert_message(&tx, account_id, &m.mailbox, ServerKey::Remote(&m.remote_id), &m.raw, m.seen, m.flagged)?.is_some() {
                inserted += 1;
            }
        }
        for (remote_id, seen, flagged) in &batch.flags {
            tx.execute(
                "UPDATE messages SET
                   seen = CASE WHEN EXISTS (SELECT 1 FROM pending_ops o WHERE o.message_id = messages.id
                          AND o.kind IN ('seen','unseen')) THEN seen ELSE ?3 END,
                   flagged = CASE WHEN EXISTS (SELECT 1 FROM pending_ops o WHERE o.message_id = messages.id
                          AND o.kind IN ('flag','unflag')) THEN flagged ELSE ?4 END
                 WHERE account_id = ?1 AND remote_id = ?2",
                params![account_id, remote_id, seen, flagged],
            )?;
        }
        for remote_id in &batch.removed {
            tx.execute(
                "DELETE FROM messages WHERE account_id = ?1 AND remote_id = ?2",
                params![account_id, remote_id],
            )?;
        }
        tx.execute(
            "INSERT INTO sync_state (account_id, mailbox, uid_validity, last_uid, state) VALUES (?1, ?2, 0, 0, ?3)
             ON CONFLICT (account_id, mailbox) DO UPDATE SET state = ?3",
            params![account_id, JMAP_STATE, batch.state],
        )?;
        tx.commit()?;
        Ok(inserted)
    }

    /// Store a message that didn't come through IMAP sync: a copy of mail
    /// sent from this device (mailbox [`SENT`]), demo data, or imports.
    pub fn insert_local(&self, account_id: &str, mailbox: &str, raw: &[u8], seen: bool) -> Result<String> {
        let tx = self.db.unchecked_transaction()?;
        let id = insert_message(&tx, account_id, mailbox, ServerKey::Local, raw, seen, false)?
            .expect("local inserts have no UID to conflict on");
        tx.commit()?;
        Ok(id)
    }

    // ── Outbox (undo send) ───────────────────────────────────────────────

    /// Queue a message to send after `undo_secs`. Until then it can be cancelled.
    pub fn queue_send(&self, draft: &Draft, undo_secs: i64) -> Result<OutboxItem> {
        if draft.to.is_empty() && draft.cc.is_empty() {
            return Err(Error::Invalid("add at least one recipient".into()));
        }
        if let Some(bad) = draft.to.iter().chain(&draft.cc).find(|a| !a.email.contains('@')) {
            return Err(Error::Invalid(format!("“{}” isn't an email address", bad.email)));
        }
        let total: usize = draft.attachments.iter().map(|a| a.data_base64.len() * 3 / 4).sum();
        if total > MAX_OUTGOING_ATTACHMENTS {
            return Err(Error::Invalid(
                "attachments are over 25 MB — most mail servers will refuse the message".into(),
            ));
        }
        self.account(&draft.account_id)?;
        let id = uuid::Uuid::new_v4().to_string();
        let send_at = now() + undo_secs.clamp(0, 120);
        self.db.execute(
            "INSERT INTO outbox (id, account_id, draft, send_at, state, created_at)
             VALUES (?1, ?2, ?3, ?4, 'queued', ?5)",
            params![id, draft.account_id, json(draft), send_at, now()],
        )?;
        self.outbox_item(&id)
    }

    /// Undo send. Succeeds only while the item is still waiting, and hands the
    /// draft back so the composer can reopen with it.
    pub fn cancel_send(&self, id: &str) -> Result<Draft> {
        let n = self.db.execute(
            "UPDATE outbox SET state = 'cancelled' WHERE id = ?1 AND state = 'queued'",
            [id],
        )?;
        if n == 0 {
            return Err(Error::Invalid("too late to undo — it has already been sent".into()));
        }
        Ok(self.outbox_item(id)?.draft)
    }

    /// Claim every item whose undo window has closed. Claiming flips the state
    /// to `sending` first, so an undo can't race a send.
    pub fn claim_due(&self, at: i64) -> Result<Vec<OutboxItem>> {
        let tx = self.db.unchecked_transaction()?;
        let ids: Vec<String> = {
            let mut stmt =
                tx.prepare("SELECT id FROM outbox WHERE state = 'queued' AND send_at <= ?1 ORDER BY send_at")?;
            stmt.query_map([at], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?
        };
        for id in &ids {
            tx.execute("UPDATE outbox SET state = 'sending' WHERE id = ?1", [id])?;
        }
        tx.commit()?;
        ids.iter().map(|id| self.outbox_item(id)).collect()
    }

    pub fn finish_send(&self, id: &str, error: Option<&str>) -> Result<()> {
        self.db.execute(
            "UPDATE outbox SET state = ?2, error = ?3 WHERE id = ?1",
            params![id, if error.is_some() { "failed" } else { "sent" }, error],
        )?;
        // Sent items no longer need their (possibly large) attachment payloads.
        if error.is_none() {
            self.db.execute(
                "UPDATE outbox SET draft = json_set(draft, '$.attachments', json('[]')) WHERE id = ?1",
                [id],
            )?;
        }
        Ok(())
    }

    /// Items that are waiting or failed, for an "Outbox" view.
    pub fn outbox(&self) -> Result<Vec<OutboxItem>> {
        let mut stmt = self.db.prepare(
            "SELECT id, draft, send_at, state, error FROM outbox
             WHERE state IN ('queued','sending','failed') ORDER BY send_at",
        )?;
        let rows = stmt.query_map([], outbox_row)?;
        rows.collect::<rusqlite::Result<_>>().map_err(Into::into)
    }

    fn outbox_item(&self, id: &str) -> Result<OutboxItem> {
        self.db
            .query_row(
                "SELECT id, draft, send_at, state, error FROM outbox WHERE id = ?1",
                [id],
                outbox_row,
            )
            .optional()?
            .ok_or_else(|| Error::NotFound("that message isn't in the outbox".into()))
    }
}

/// The usual provider limit on a whole message is 25 MB.
const MAX_OUTGOING_ATTACHMENTS: usize = 25 * 1024 * 1024;

// ── Inserting + threading ────────────────────────────────────────────────

/// How the server identifies a message: IMAP by UID, JMAP by string id.
/// Local-only mail (sent copies, imports) has neither.
#[derive(Clone, Copy)]
enum ServerKey<'a> {
    Uid(u32),
    Remote(&'a str),
    Local,
}

/// Insert one message with its attachments and thread. Returns the new id,
/// or `None` if the server key is already stored for this mailbox.
fn insert_message(
    tx: &Connection,
    account_id: &str,
    mailbox: &str,
    key: ServerKey<'_>,
    raw: &[u8],
    seen: bool,
    flagged: bool,
) -> Result<Option<String>> {
    // A message that won't parse is still stored, so it isn't silently lost.
    let p = mime::parse(raw).unwrap_or_else(|e| mime::Parsed {
        message_id: None,
        from: Address { name: None, email: "unknown".into() },
        to: vec![],
        cc: vec![],
        subject: "(unreadable message)".into(),
        date: None,
        preview: e.to_string(),
        body_text: String::from_utf8_lossy(raw).into_owned(),
        body_html: None,
        in_reply_to: None,
        references: vec![],
        attachments: vec![],
    });
    let (uid, remote_id) = match key {
        ServerKey::Uid(u) => (Some(u), None),
        ServerKey::Remote(r) => (None, Some(r)),
        ServerKey::Local => (None, None),
    };
    let id = uuid::Uuid::new_v4().to_string();
    let date = p.date.unwrap_or_else(now);
    let has_files = p.attachments.iter().any(|a| !a.inline);
    let n = tx.execute(
        "INSERT OR IGNORE INTO messages (id, account_id, mailbox, uid, message_id, from_name, from_email,
           to_json, cc_json, subject, preview, body_text, body_html, date, sort_at, seen, flagged,
           thread_id, has_attachments, raw, remote_id, archived)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14, ?15, ?16, ?1, ?17, ?18, ?19, ?20)",
        params![
            id, account_id, mailbox, uid, p.message_id, p.from.name, p.from.email, json(&p.to),
            json(&p.cc), p.subject, p.preview, p.body_text, p.body_html, date, seen, flagged,
            has_files, raw, remote_id, mailbox == ARCHIVE
        ],
    )?;
    if n == 0 {
        return Ok(None);
    }
    // A server copy supersedes the stand-ins we kept until it arrived: the
    // local copy of mail sent from this device, or an archived inbox row.
    if let (Some(mid), false) = (&p.message_id, matches!(key, ServerKey::Local)) {
        let stale = match mailbox {
            SENT => Some(format!("mailbox = '{SENT}' AND uid IS NULL AND remote_id IS NULL")),
            ARCHIVE => Some(format!("mailbox = '{INBOX}' AND archived = 1")),
            _ => None,
        };
        if let Some(cond) = stale {
            tx.execute(
                &format!("DELETE FROM messages WHERE account_id = ?1 AND message_id = ?2 AND id <> ?3 AND {cond}"),
                params![account_id, mid, id],
            )?;
        }
    }

    for a in &p.attachments {
        tx.execute(
            "INSERT INTO attachments (id, message_id, idx, filename, mime_type, size, content_id, inline)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![uuid::Uuid::new_v4().to_string(), id, a.index, a.filename, a.mime_type, a.size as i64, a.content_id, a.inline],
        )?;
    }

    // Keep header order (oldest ancestor first): replies rebuild References from it.
    let mut chain: Vec<&str> = Vec::new();
    for r in p.references.iter().map(String::as_str).chain(p.in_reply_to.as_deref()) {
        if !chain.contains(&r) {
            chain.push(r);
        }
    }
    for r in &chain {
        tx.execute("INSERT INTO message_refs (message_id, ref) VALUES (?1, ?2)", params![id, r])?;
    }
    let refs: BTreeSet<&str> = chain.iter().copied().collect();
    assign_thread(tx, account_id, &id, p.message_id.as_deref(), &refs)?;
    Ok(Some(id))
}

/// Join the conversation this message belongs to, merging threads when a
/// message links two that arrived out of order.
fn assign_thread(tx: &Connection, account_id: &str, id: &str, message_id: Option<&str>, refs: &BTreeSet<&str>) -> Result<()> {
    let mut threads: BTreeSet<String> = BTreeSet::new();
    // Parents and ancestors we already have.
    for r in refs {
        let mut stmt = tx.prepare_cached(
            "SELECT thread_id FROM messages WHERE account_id = ?1 AND message_id = ?2 AND id <> ?3",
        )?;
        for t in stmt.query_map(params![account_id, r, id], |row| row.get::<_, String>(0))? {
            threads.insert(t?);
        }
    }
    // Replies that arrived before this message (or siblings with a shared ancestor).
    let mut keys: Vec<&str> = refs.iter().copied().collect();
    keys.extend(message_id);
    for k in keys {
        let mut stmt = tx.prepare_cached(
            "SELECT m.thread_id FROM message_refs r JOIN messages m ON m.id = r.message_id
             WHERE r.ref = ?1 AND m.account_id = ?2 AND m.id <> ?3",
        )?;
        for t in stmt.query_map(params![k, account_id, id], |row| row.get::<_, String>(0))? {
            threads.insert(t?);
        }
    }
    let Some(target) = threads.iter().next().cloned() else { return Ok(()) };
    tx.execute("UPDATE messages SET thread_id = ?1 WHERE id = ?2", params![target, id])?;
    for other in threads.iter().skip(1) {
        tx.execute("UPDATE messages SET thread_id = ?1 WHERE thread_id = ?2", params![target, other])?;
    }
    Ok(())
}

// ── Row helpers ──────────────────────────────────────────────────────────

const SUMMARY_COLS_PLAIN: &str = "m.id, m.account_id, m.thread_id, \
     (SELECT COUNT(*) FROM messages t WHERE t.thread_id = m.thread_id), \
     EXISTS (SELECT 1 FROM messages t WHERE t.thread_id = m.thread_id AND t.has_attachments = 1), \
     m.from_name, m.from_email, m.subject, m.preview, m.date, m.sort_at, m.seen, m.flagged, \
     m.archived, m.snoozed_until, m.mailbox";

/// Same columns for list rows, with read and starred rolled up per thread.
const SUMMARY_COLS_RANKED: &str = "m.id, m.account_id, m.thread_id, \
     (SELECT COUNT(*) FROM messages t WHERE t.thread_id = m.thread_id), \
     EXISTS (SELECT 1 FROM messages t WHERE t.thread_id = m.thread_id AND t.has_attachments = 1), \
     m.from_name, m.from_email, m.subject, m.preview, m.date, m.sort_at, m.thread_seen, \
     EXISTS (SELECT 1 FROM messages t WHERE t.thread_id = m.thread_id AND t.flagged = 1), \
     m.archived, m.snoozed_until, m.mailbox";

fn summary_row(r: &Row) -> rusqlite::Result<MessageSummary> {
    Ok(MessageSummary {
        id: r.get(0)?,
        account_id: r.get(1)?,
        thread_id: r.get(2)?,
        thread_count: r.get(3)?,
        has_attachments: r.get(4)?,
        from: Address { name: r.get(5)?, email: r.get(6)? },
        subject: r.get(7)?,
        preview: r.get(8)?,
        date: r.get(9)?,
        sort_at: r.get(10)?,
        seen: r.get(11)?,
        flagged: r.get(12)?,
        archived: r.get(13)?,
        snoozed_until: r.get(14)?,
        mailbox: r.get(15)?,
    })
}

fn detail_row(r: &Row) -> rusqlite::Result<MessageDetail> {
    Ok(MessageDetail {
        summary: summary_row(r)?,
        to: from_json(r.get(16)?),
        cc: from_json(r.get(17)?),
        message_id: r.get(18)?,
        body_text: r.get(19)?,
        body_html: r.get(20)?,
        attachments: vec![],
        references: vec![],
    })
}

fn account_row(r: &Row) -> rusqlite::Result<Account> {
    Ok(Account {
        id: r.get(0)?,
        config: serde_json::from_str(&r.get::<_, String>(1)?)
            .map_err(|e| rusqlite::Error::FromSqlConversionFailure(1, rusqlite::types::Type::Text, Box::new(e)))?,
        last_sync: r.get(2)?,
        last_error: r.get(3)?,
        dav_last_sync: r.get(4)?,
        dav_error: r.get(5)?,
    })
}

fn outbox_row(r: &Row) -> rusqlite::Result<OutboxItem> {
    let state: String = r.get(3)?;
    Ok(OutboxItem {
        id: r.get(0)?,
        draft: serde_json::from_str(&r.get::<_, String>(1)?)
            .map_err(|e| rusqlite::Error::FromSqlConversionFailure(1, rusqlite::types::Type::Text, Box::new(e)))?,
        send_at: r.get(2)?,
        state: match state.as_str() {
            "queued" => OutboxState::Queued,
            "sending" => OutboxState::Sending,
            "sent" => OutboxState::Sent,
            "cancelled" => OutboxState::Cancelled,
            _ => OutboxState::Failed,
        },
        error: r.get(4)?,
    })
}

pub(crate) fn json<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_string(v).expect("model types always serialize")
}

pub(crate) fn from_json<T: serde::de::DeserializeOwned + Default>(s: String) -> T {
    serde_json::from_str(&s).unwrap_or_default()
}

/// Turn what someone typed into a safe FTS5 query: each word becomes a quoted
/// prefix term, so punctuation can't be read as query syntax.
fn fts_query(input: &str) -> String {
    input
        .split_whitespace()
        .map(|w| w.replace('"', ""))
        .filter(|w| !w.is_empty())
        .map(|w| format!("\"{w}\"*"))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{FetchedMessage, Provider, Security, ServerConfig};

    fn store_with_account() -> (Store, String) {
        let s = Store::open_in_memory().unwrap();
        let server = ServerConfig { host: "localhost".into(), port: 143, security: Security::Plain };
        let a = s
            .add_account(&AccountConfig {
                display_name: "Test".into(),
                address: "me@example.com".into(),
                username: "me".into(),
                provider: Provider::Generic,
                imap: server.clone(),
                smtp: ServerConfig { port: 25, ..server },
                jmap: None,
                dav: None,
            })
            .unwrap();
        (s, a.id)
    }

    fn raw(subject: &str, body: &str) -> Vec<u8> {
        format!("From: Ana <ana@example.com>\r\nSubject: {subject}\r\nDate: Tue, 13 Oct 2026 09:00:00 +0000\r\n\r\n{body}\r\n").into_bytes()
    }

    /// A message with threading headers. `date` orders it within the thread.
    fn threaded(id: &str, reply_to: Option<&str>, refs: &[&str], subject: &str, hour: u32) -> Vec<u8> {
        let mut h = format!(
            "From: Ana <ana@example.com>\r\nSubject: {subject}\r\nMessage-ID: <{id}>\r\nDate: Tue, 13 Oct 2026 {hour:02}:00:00 +0000\r\n"
        );
        if let Some(p) = reply_to {
            h.push_str(&format!("In-Reply-To: <{p}>\r\n"));
        }
        if !refs.is_empty() {
            h.push_str(&format!("References: {}\r\n", refs.iter().map(|r| format!("<{r}>")).collect::<Vec<_>>().join(" ")));
        }
        format!("{h}\r\nbody of {id}\r\n").into_bytes()
    }

    fn fetched(uid: u32, subject: &str) -> FetchedMessage {
        FetchedMessage { uid, seen: false, flagged: false, raw: raw(subject, "hello") }
    }

    fn fetched_raw(uid: u32, raw: Vec<u8>) -> FetchedMessage {
        FetchedMessage { uid, seen: false, flagged: false, raw }
    }

    fn lane(s: &Store, lane: Lane) -> Vec<MessageSummary> {
        s.messages(&MessageQuery { lane, account_id: None, search: None, limit: None }).unwrap()
    }

    fn inbox(s: &Store) -> Vec<MessageSummary> {
        lane(s, Lane::Inbox)
    }

    fn batch(uid_validity: u32, new: Vec<FetchedMessage>, server_uids: Vec<u32>) -> SyncBatch {
        SyncBatch { mailbox: "INBOX".into(), uid_validity, new_messages: new, server_uids, ..Default::default() }
    }

    // ── Sync ─────────────────────────────────────────────────────────────

    #[test]
    fn sync_inserts_and_advances_cursor() {
        let (s, acct) = store_with_account();
        let n = s.apply_sync(&acct, &batch(7, vec![fetched(1, "One"), fetched(2, "Two")], vec![1, 2])).unwrap();
        assert_eq!(n, 2);
        assert_eq!(
            s.sync_cursor(&acct, "INBOX").unwrap(),
            SyncCursor { uid_validity: Some(7), last_uid: 2, oldest_uid: Some(1) }
        );
        assert_eq!(s.apply_sync(&acct, &batch(7, vec![fetched(2, "Two")], vec![1, 2])).unwrap(), 0);
        assert_eq!(inbox(&s).len(), 2);
    }

    #[test]
    fn backfilled_older_mail_lowers_the_oldest_uid() {
        let (s, acct) = store_with_account();
        s.apply_sync(&acct, &batch(7, vec![fetched(50, "Newest")], (1..=50).collect())).unwrap();
        assert_eq!(s.sync_cursor(&acct, "INBOX").unwrap().oldest_uid, Some(50));
        s.apply_sync(&acct, &batch(7, vec![fetched(10, "Older")], (1..=50).collect())).unwrap();
        let c = s.sync_cursor(&acct, "INBOX").unwrap();
        assert_eq!((c.last_uid, c.oldest_uid), (50, Some(10)));
    }

    #[test]
    fn uid_validity_change_resets_the_mailbox() {
        let (s, acct) = store_with_account();
        s.apply_sync(&acct, &batch(7, vec![fetched(1, "Old")], vec![1])).unwrap();
        s.apply_sync(&acct, &batch(8, vec![fetched(1, "New")], vec![1])).unwrap();
        let list = inbox(&s);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].subject, "New");
    }

    #[test]
    fn mail_removed_on_server_is_removed_locally() {
        let (s, acct) = store_with_account();
        s.apply_sync(&acct, &batch(7, vec![fetched(1, "Keep"), fetched(2, "Gone")], vec![1, 2])).unwrap();
        s.apply_sync(&acct, &batch(7, vec![], vec![1])).unwrap();
        assert_eq!(inbox(&s).iter().map(|m| m.subject.as_str()).collect::<Vec<_>>(), ["Keep"]);
    }

    #[test]
    fn pending_local_flags_survive_a_sync() {
        let (s, acct) = store_with_account();
        s.apply_sync(&acct, &batch(7, vec![fetched(1, "A")], vec![1])).unwrap();
        let id = inbox(&s)[0].id.clone();
        s.set_seen(&id, true).unwrap();
        let mut b = batch(7, vec![], vec![1]);
        b.flags = vec![(1, false, false)];
        s.apply_sync(&acct, &b).unwrap();
        assert!(s.message(&id).unwrap().summary.seen);
        let ops = s.pending_ops(&acct, "INBOX").unwrap();
        assert_eq!(ops.len(), 1);
        let mut b = batch(7, vec![], vec![1]);
        b.applied_ops = ops.iter().map(|o| o.id).collect();
        b.flags = vec![(1, true, false)];
        s.apply_sync(&acct, &b).unwrap();
        assert!(s.pending_ops(&acct, "INBOX").unwrap().is_empty());
    }

    #[test]
    fn opposite_ops_collapse_to_the_latest() {
        let (s, acct) = store_with_account();
        s.apply_sync(&acct, &batch(7, vec![fetched(1, "A")], vec![1])).unwrap();
        let id = inbox(&s)[0].id.clone();
        s.set_seen(&id, true).unwrap();
        s.set_seen(&id, false).unwrap();
        let ops = s.pending_ops(&acct, "INBOX").unwrap();
        assert_eq!(ops.iter().map(|o| o.kind).collect::<Vec<_>>(), [OpKind::Seen(false)]);
    }

    #[test]
    fn archived_mail_leaves_the_inbox_and_survives_server_removal() {
        let (s, acct) = store_with_account();
        s.apply_sync(&acct, &batch(7, vec![fetched(1, "A")], vec![1])).unwrap();
        let id = inbox(&s)[0].id.clone();
        s.set_archived(&id, true).unwrap();
        assert!(inbox(&s).is_empty());
        s.apply_sync(&acct, &batch(7, vec![], vec![])).unwrap();
        assert_eq!(lane(&s, Lane::Archive).len(), 1);
    }

    // ── Snooze, search, outbox ───────────────────────────────────────────

    #[test]
    fn snooze_hides_then_resurfaces_unread_at_the_top() {
        let (s, acct) = store_with_account();
        s.apply_sync(&acct, &batch(7, vec![fetched(1, "Snoozed"), fetched(2, "Other")], vec![1, 2])).unwrap();
        let id = inbox(&s).iter().find(|m| m.subject == "Snoozed").unwrap().id.clone();
        s.set_seen(&id, true).unwrap();
        let until = now() + 3600;
        s.snooze(&id, until).unwrap();
        assert_eq!(inbox(&s).len(), 1);
        assert_eq!(lane(&s, Lane::Snoozed)[0].snoozed_until, Some(until));

        assert_eq!(s.wake_snoozed(until).unwrap(), 1);
        let list = inbox(&s);
        assert_eq!(list[0].id, id, "a woken snooze sorts to the top");
        assert!(!list[0].seen, "a woken snooze is unread again");
    }

    #[test]
    fn snooze_rejects_the_past() {
        let (s, acct) = store_with_account();
        s.apply_sync(&acct, &batch(7, vec![fetched(1, "A")], vec![1])).unwrap();
        let id = inbox(&s)[0].id.clone();
        assert!(matches!(s.snooze(&id, now() - 1), Err(Error::Invalid(_))));
    }

    #[test]
    fn search_matches_prefixes_and_ignores_query_syntax() {
        let (s, acct) = store_with_account();
        s.apply_sync(&acct, &batch(7, vec![
            fetched_raw(1, raw("Ferry booking", "Saturday crossing")),
            fetched_raw(2, raw("Token audit", "semantic tier")),
        ], vec![1, 2])).unwrap();
        let q = |text: &str| s.messages(&MessageQuery { lane: Lane::Inbox, account_id: None, search: Some(text.into()), limit: None }).unwrap();
        assert_eq!(q("cross")[0].subject, "Ferry booking");
        assert_eq!(q("ana")[0].from.email, "ana@example.com");
        assert_eq!(q("semantic tier").len(), 1);
        assert!(q("\"unbalanced AND (").is_empty());
    }

    fn draft(acct: &str) -> Draft {
        Draft {
            account_id: acct.into(),
            to: vec![Address { name: None, email: "ana@example.com".into() }],
            cc: vec![],
            subject: "Hi".into(),
            body: "Hello".into(),
            body_html: None,
            in_reply_to: None,
            references: vec![],
            attachments: vec![],
        }
    }

    #[test]
    fn undo_send_window() {
        let (s, acct) = store_with_account();
        let draft = draft(&acct);
        let item = s.queue_send(&draft, 10).unwrap();
        assert_eq!(item.state, OutboxState::Queued);
        assert!(s.claim_due(now()).unwrap().is_empty(), "not due inside the undo window");
        assert_eq!(s.cancel_send(&item.id).unwrap(), draft);

        let item = s.queue_send(&draft, 10).unwrap();
        let claimed = s.claim_due(item.send_at).unwrap();
        assert_eq!(claimed.len(), 1);
        assert!(s.cancel_send(&item.id).is_err(), "can't undo once sending started");
        s.finish_send(&item.id, None).unwrap();
        assert!(s.outbox().unwrap().is_empty());
    }

    #[test]
    fn queue_send_validates_recipients_and_size() {
        let (s, acct) = store_with_account();
        let mut d = draft(&acct);
        d.to.clear();
        assert!(s.queue_send(&d, 10).is_err());
        d.to.push(Address { name: None, email: "not-an-address".into() });
        assert!(s.queue_send(&d, 10).is_err());
        let mut d = draft(&acct);
        d.attachments.push(crate::OutgoingAttachment {
            filename: "huge.bin".into(),
            mime_type: "application/octet-stream".into(),
            data_base64: "A".repeat(36 * 1024 * 1024),
        });
        assert!(matches!(s.queue_send(&d, 10), Err(Error::Invalid(m)) if m.contains("25 MB")));
    }

    #[test]
    fn removing_an_account_removes_its_mail() {
        let (s, acct) = store_with_account();
        s.apply_sync(&acct, &batch(7, vec![fetched(1, "A")], vec![1])).unwrap();
        s.remove_account(&acct).unwrap();
        assert!(inbox(&s).is_empty());
    }

    // ── Threads ──────────────────────────────────────────────────────────

    #[test]
    fn replies_join_their_conversation_in_any_order() {
        let (s, acct) = store_with_account();
        // The reply arrives before its parent; the grandchild links both.
        s.apply_sync(&acct, &batch(7, vec![
            fetched_raw(1, threaded("b@x", Some("a@x"), &["a@x"], "Re: Plans", 10)),
            fetched_raw(2, threaded("other@x", None, &[], "Unrelated", 9)),
        ], vec![1, 2])).unwrap();
        s.apply_sync(&acct, &batch(7, vec![
            fetched_raw(3, threaded("a@x", None, &[], "Plans", 8)),
            fetched_raw(4, threaded("c@x", Some("b@x"), &["a@x", "b@x"], "Re: Plans", 11)),
        ], vec![1, 2, 3, 4])).unwrap();

        let rows = inbox(&s);
        assert_eq!(rows.len(), 2, "one row per conversation");
        let plans = rows.iter().find(|r| r.subject.contains("Plans")).unwrap();
        assert_eq!(plans.thread_count, 3);
        assert_eq!(plans.subject, "Re: Plans");
        assert!(plans.preview.contains("c@x") || plans.from.email == "ana@example.com", "row shows the newest message");
        let thread = s.thread(&plans.thread_id).unwrap();
        assert_eq!(thread.iter().map(|m| m.message_id.clone().unwrap()).collect::<Vec<_>>(), ["a@x", "b@x", "c@x"]);
        assert_eq!(thread[2].references, ["a@x", "b@x"], "References keep header order for replies");
    }

    #[test]
    fn two_threads_merge_when_a_message_links_them() {
        let (s, acct) = store_with_account();
        // Siblings that only share an ancestor we don't have yet.
        s.apply_sync(&acct, &batch(7, vec![
            fetched_raw(1, threaded("b@x", Some("root@x"), &["root@x"], "Re: Q", 9)),
            fetched_raw(2, threaded("c@x", Some("root@x"), &["root@x"], "Re: Q", 10)),
        ], vec![1, 2])).unwrap();
        assert_eq!(inbox(&s).len(), 1, "a shared reference joins siblings");
        s.apply_sync(&acct, &batch(7, vec![fetched_raw(3, threaded("root@x", None, &[], "Q", 8))], vec![1, 2, 3])).unwrap();
        let rows = inbox(&s);
        assert_eq!((rows.len(), rows[0].thread_count), (1, 3));
    }

    #[test]
    fn thread_rows_roll_up_unread_and_starred() {
        let (s, acct) = store_with_account();
        s.apply_sync(&acct, &batch(7, vec![
            FetchedMessage { uid: 1, seen: true, flagged: true, raw: threaded("a@x", None, &[], "T", 8) },
            FetchedMessage { uid: 2, seen: false, flagged: false, raw: threaded("b@x", Some("a@x"), &["a@x"], "Re: T", 9) },
        ], vec![1, 2])).unwrap();
        let row = &inbox(&s)[0];
        assert!(!row.seen, "unread if any message is unread");
        assert!(row.flagged, "starred if any message is starred");

        s.set_thread_seen(&row.thread_id, true).unwrap();
        assert!(inbox(&s)[0].seen);
        let ops = s.pending_ops(&acct, "INBOX").unwrap();
        assert_eq!(ops.len(), 1, "only the message that changed gets an op");

        s.set_thread_flagged(&row.thread_id, false).unwrap();
        assert!(!inbox(&s)[0].flagged);
        s.set_thread_flagged(&row.thread_id, true).unwrap();
        let thread = s.thread(&row.thread_id).unwrap();
        assert!(thread.last().unwrap().summary.flagged, "starring stars the newest message");
    }

    #[test]
    fn thread_archive_and_snooze_move_the_whole_conversation() {
        let (s, acct) = store_with_account();
        s.apply_sync(&acct, &batch(7, vec![
            fetched_raw(1, threaded("a@x", None, &[], "T", 8)),
            fetched_raw(2, threaded("b@x", Some("a@x"), &["a@x"], "Re: T", 9)),
        ], vec![1, 2])).unwrap();
        let thread = inbox(&s)[0].thread_id.clone();
        s.set_thread_archived(&thread, true).unwrap();
        assert!(inbox(&s).is_empty(), "no older message is left behind in the inbox");
        assert_eq!(lane(&s, Lane::Archive).len(), 1);
        s.set_thread_archived(&thread, false).unwrap();

        s.snooze_thread(&thread, now() + 60).unwrap();
        assert!(inbox(&s).is_empty());
        assert_eq!(lane(&s, Lane::Snoozed).len(), 1);
        s.unsnooze_thread(&thread).unwrap();
        assert_eq!(inbox(&s).len(), 1);
    }

    #[test]
    fn sent_copies_join_threads_but_never_fill_the_inbox() {
        let (s, acct) = store_with_account();
        s.apply_sync(&acct, &batch(7, vec![fetched_raw(1, threaded("a@x", None, &[], "Lunch?", 8))], vec![1])).unwrap();
        let thread = inbox(&s)[0].thread_id.clone();
        s.set_thread_archived(&thread, true).unwrap();
        // I reply from an archived thread: it must not pop back into the inbox.
        let reply = b"From: Me <me@example.com>\r\nTo: ana@example.com\r\nSubject: Re: Lunch?\r\nMessage-ID: <mine@x>\r\nIn-Reply-To: <a@x>\r\nReferences: <a@x>\r\nDate: Tue, 13 Oct 2026 09:00:00 +0000\r\n\r\nYes!\r\n";
        s.insert_local(&acct, SENT, reply, true).unwrap();
        assert!(inbox(&s).is_empty());
        let t = s.thread(&thread).unwrap();
        assert_eq!(t.len(), 2);
        assert_eq!(t[1].summary.mailbox, SENT);
        // Sent copies have no IMAP UID, so actions on them queue nothing.
        s.set_thread_archived(&thread, false).unwrap();
        assert!(s.pending_ops(&acct, "INBOX").unwrap().iter().all(|o| o.kind != OpKind::Archive));
    }

    // ── Sent and Archive mailboxes ───────────────────────────────────────

    fn batch_in(mailbox: &str, uid_validity: u32, new: Vec<FetchedMessage>, server_uids: Vec<u32>) -> SyncBatch {
        SyncBatch { mailbox: mailbox.into(), uid_validity, new_messages: new, server_uids, ..Default::default() }
    }

    #[test]
    fn archive_mailbox_mail_is_archived_and_can_be_unarchived() {
        let (s, acct) = store_with_account();
        s.apply_sync(&acct, &batch_in(ARCHIVE, 3, vec![fetched_raw(1, threaded("old@x", None, &[], "Old trip", 8))], vec![1])).unwrap();
        assert!(inbox(&s).is_empty());
        let row = lane(&s, Lane::Archive).remove(0);
        // Unarchive = move back to the inbox on the server.
        s.set_thread_archived(&row.thread_id, false).unwrap();
        assert_eq!(inbox(&s).len(), 1, "shows in the inbox right away");
        let ops = s.pending_ops(&acct, ARCHIVE).unwrap();
        assert_eq!(ops.iter().map(|o| o.kind).collect::<Vec<_>>(), [OpKind::Unarchive]);
        // Changing your mind before a sync sends nothing.
        s.set_thread_archived(&row.thread_id, true).unwrap();
        assert!(s.pending_ops(&acct, ARCHIVE).unwrap().is_empty());
    }

    #[test]
    fn moved_out_rows_go_and_the_archive_copy_replaces_them() {
        let (s, acct) = store_with_account();
        s.apply_sync(&acct, &batch(7, vec![fetched_raw(1, threaded("a@x", None, &[], "Plans", 8))], vec![1])).unwrap();
        let t = inbox(&s)[0].thread_id.clone();
        s.set_thread_archived(&t, true).unwrap();
        // The adapter moved it: INBOX drops the row, Archive brings it back.
        let mut b = batch(7, vec![], vec![]);
        b.moved_out = vec![1];
        b.applied_ops = s.pending_ops(&acct, INBOX).unwrap().iter().map(|o| o.id).collect();
        s.apply_sync(&acct, &b).unwrap();
        s.apply_sync(&acct, &batch_in(ARCHIVE, 3, vec![fetched_raw(40, threaded("a@x", None, &[], "Plans", 8))], vec![40])).unwrap();
        let archived = lane(&s, Lane::Archive);
        assert_eq!(archived.len(), 1);
        assert_eq!(archived[0].mailbox, ARCHIVE);
        assert_eq!(archived[0].thread_count, 1, "no duplicate of the archived message");
    }

    #[test]
    fn a_locally_kept_archived_copy_is_replaced_by_the_server_copy() {
        // Defense in depth: even without moved_out, the Archive copy wins.
        let (s, acct) = store_with_account();
        s.apply_sync(&acct, &batch(7, vec![fetched_raw(1, threaded("a@x", None, &[], "Plans", 8))], vec![1])).unwrap();
        let t = inbox(&s)[0].thread_id.clone();
        s.set_thread_archived(&t, true).unwrap();
        s.apply_sync(&acct, &batch_in(ARCHIVE, 3, vec![fetched_raw(40, threaded("a@x", None, &[], "Plans", 8))], vec![40])).unwrap();
        assert_eq!(lane(&s, Lane::Archive)[0].thread_count, 1);
    }

    #[test]
    fn server_sent_copy_replaces_the_local_one() {
        let (s, acct) = store_with_account();
        s.apply_sync(&acct, &batch(7, vec![fetched_raw(1, threaded("a@x", None, &[], "Lunch?", 8))], vec![1])).unwrap();
        let mine = b"From: Me <me@example.com>\r\nTo: ana@example.com\r\nSubject: Re: Lunch?\r\nMessage-ID: <mine@x>\r\nIn-Reply-To: <a@x>\r\nDate: Tue, 13 Oct 2026 09:00:00 +0000\r\n\r\nYes!\r\n";
        s.insert_local(&acct, SENT, mine, true).unwrap();
        let t = inbox(&s)[0].thread_id.clone();
        assert_eq!(s.thread(&t).unwrap().len(), 2);
        s.apply_sync(&acct, &batch_in(SENT, 5, vec![FetchedMessage { uid: 9, seen: true, flagged: false, raw: mine.to_vec() }], vec![9])).unwrap();
        let thread = s.thread(&t).unwrap();
        assert_eq!(thread.len(), 2, "server copy replaced the local one, no duplicate");
        assert_eq!(s.sync_cursor(&acct, SENT).unwrap().oldest_uid, Some(9), "the kept copy is the server's");
    }

    // ── Attachments ──────────────────────────────────────────────────────

    const WITH_FILES: &[u8] = b"From: a@example.com\r\nSubject: Trip\r\nMIME-Version: 1.0\r\n\
Content-Type: multipart/related; boundary=\"b1\"\r\n\r\n\
--b1\r\nContent-Type: text/html\r\n\r\n<p>Map:</p><img src=\"cid:map@x\">\r\n\
--b1\r\nContent-Type: image/png\r\nContent-ID: <map@x>\r\nContent-Disposition: inline\r\nContent-Transfer-Encoding: base64\r\n\r\niVBORw0KGgo=\r\n\
--b1\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=\"tickets.pdf\"\r\nContent-Transfer-Encoding: base64\r\n\r\nSGVsbG8gUERG\r\n\
--b1--\r\n";

    #[test]
    fn attachments_are_listed_decoded_and_inlined() {
        let (s, acct) = store_with_account();
        s.apply_sync(&acct, &batch(7, vec![fetched_raw(1, WITH_FILES.to_vec())], vec![1])).unwrap();
        let row = &inbox(&s)[0];
        assert!(row.has_attachments);
        let detail = s.message(&row.id).unwrap();
        let files: Vec<_> = detail.attachments.iter().filter(|a| !a.inline).collect();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].filename, "tickets.pdf");
        let (info, bytes) = s.attachment(&files[0].id).unwrap();
        assert_eq!((info.mime_type.as_str(), bytes.as_slice()), ("application/pdf", b"Hello PDF".as_slice()));
        let html = detail.body_html.unwrap();
        assert!(html.contains("src=\"data:image/png;base64,"), "cid: image inlined: {html}");
        assert!(!html.contains("cid:map@x"));
    }

    #[test]
    fn inline_only_images_dont_count_as_attachments() {
        let (s, acct) = store_with_account();
        let inline_only = String::from_utf8_lossy(WITH_FILES).replace(
            "--b1\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=\"tickets.pdf\"\r\nContent-Transfer-Encoding: base64\r\n\r\nSGVsbG8gUERG\r\n", "");
        s.apply_sync(&acct, &batch(7, vec![fetched_raw(1, inline_only.into_bytes())], vec![1])).unwrap();
        assert!(!inbox(&s)[0].has_attachments);
    }

    // ── Server-id (JMAP) sync ────────────────────────────────────────────

    fn remote(id: &str, mailbox: &str, raw: Vec<u8>) -> crate::RemoteMessage {
        crate::RemoteMessage { remote_id: id.into(), mailbox: mailbox.into(), seen: false, flagged: false, raw }
    }

    #[test]
    fn remote_sync_inserts_updates_and_removes_by_server_id() {
        let (s, acct) = store_with_account();
        let b = RemoteBatch {
            state: "s1".into(),
            new_messages: vec![remote("M1", INBOX, raw("One", "x")), remote("M2", INBOX, raw("Two", "y"))],
            ..Default::default()
        };
        assert_eq!(s.apply_remote(&acct, &b).unwrap(), 2);
        assert_eq!(s.apply_remote(&acct, &b).unwrap(), 0, "same ids are not stored twice");
        let c = s.remote_cursor(&acct).unwrap();
        assert_eq!(c.state.as_deref(), Some("s1"));
        assert_eq!(c.known.get("M1").map(String::as_str), Some(INBOX));

        let one = inbox(&s).into_iter().find(|m| m.subject == "One").unwrap();
        s.set_thread_seen(&one.thread_id, true).unwrap();
        let ops = s.pending_remote_ops(&acct).unwrap();
        assert_eq!((ops.len(), ops[0].remote_id.as_str(), ops[0].kind), (1, "M1", OpKind::Seen(true)));
        s.apply_remote(&acct, &RemoteBatch { state: "s2".into(), flags: vec![("M1".into(), false, true)], ..Default::default() }).unwrap();
        let after = s.message(&one.id).unwrap().summary;
        assert!(after.seen && after.flagged, "pending seen kept, server flag applied");

        s.apply_remote(&acct, &RemoteBatch { state: "s3".into(), removed: vec!["M2".into()], applied_ops: vec![ops[0].id], ..Default::default() }).unwrap();
        assert_eq!(inbox(&s).len(), 1);
        assert!(s.pending_remote_ops(&acct).unwrap().is_empty());
        assert!(s.pending_ops(&acct, INBOX).unwrap().is_empty(), "IMAP ops never see JMAP rows");
    }

    #[test]
    fn remote_moves_change_mailbox_without_redownloading() {
        let (s, acct) = store_with_account();
        s.apply_remote(&acct, &RemoteBatch { state: "s1".into(), new_messages: vec![remote("M1", INBOX, raw("Trip", "x"))], ..Default::default() }).unwrap();
        let t = inbox(&s)[0].thread_id.clone();
        s.set_thread_archived(&t, true).unwrap();
        let op = s.pending_remote_ops(&acct).unwrap().remove(0);
        assert_eq!(op.kind, OpKind::Archive);
        s.apply_remote(&acct, &RemoteBatch { state: "s2".into(), moved: vec![("M1".into(), ARCHIVE.into())], applied_ops: vec![op.id], ..Default::default() }).unwrap();
        let archived = lane(&s, Lane::Archive);
        assert_eq!((archived.len(), archived[0].mailbox.as_str()), (1, ARCHIVE));
        // And back: unarchive queues the reverse move.
        s.set_thread_archived(&t, false).unwrap();
        assert_eq!(s.pending_remote_ops(&acct).unwrap()[0].kind, OpKind::Unarchive);
    }

    #[test]
    fn remote_reset_replaces_every_server_copy() {
        let (s, acct) = store_with_account();
        s.apply_remote(&acct, &RemoteBatch { state: "s1".into(), new_messages: vec![remote("M1", INBOX, raw("Old", "x")), remote("M2", ARCHIVE, raw("Older", "y"))], ..Default::default() }).unwrap();
        s.apply_remote(&acct, &RemoteBatch { state: "s9".into(), reset: true, new_messages: vec![remote("M3", INBOX, raw("New", "z"))], ..Default::default() }).unwrap();
        assert_eq!(inbox(&s).iter().map(|m| m.subject.as_str()).collect::<Vec<_>>(), ["New"]);
        assert!(lane(&s, Lane::Archive).is_empty());
    }

    // ── Migration ────────────────────────────────────────────────────────

    #[test]
    fn upgrades_a_version_1_database() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(SCHEMA_V1).unwrap();
        db.pragma_update(None, "user_version", 1).unwrap();
        db.execute("INSERT INTO accounts (id, config, created_at) VALUES ('a', '{}', 0)", []).unwrap();
        db.execute(
            "INSERT INTO messages (id, account_id, mailbox, uid, from_email, to_json, cc_json, subject, preview, body_text, date, sort_at)
             VALUES ('m1', 'a', 'INBOX', 1, 'x@y', '[]', '[]', 'Old mail', '', '', 0, 0)",
            [],
        )
        .unwrap();
        let s = Store::init(db).unwrap();
        let rows = s.messages(&MessageQuery { lane: Lane::Inbox, account_id: None, search: None, limit: None }).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].thread_id, "m1", "existing mail becomes its own conversation");
        let v: i64 = s.db.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert_eq!(v, SCHEMA_VERSION);
    }
}
