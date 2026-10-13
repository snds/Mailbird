//! The local database. One SQLite file per device holds accounts, messages,
//! the outbox, and changes still waiting to reach the server.
//!
//! Field ownership matters during sync:
//! - **Server-owned:** content, `seen`, and `flagged` (unless a local change is pending).
//! - **Device-owned:** `snoozed_until`, `sort_at`, and `archived`.
//!   IMAP has no server-side snooze (see `Capabilities::server_side_scheduling`),
//!   so a re-sync never clobbers these.

use rusqlite::{Connection, OptionalExtension, Row, params};

use crate::{
    Account, AccountConfig, Address, Draft, Error, FetchedMessage, Lane, MessageDetail,
    MessageQuery, MessageSummary, OpKind, OutboxItem, OutboxState, PendingOp, Result, SyncBatch,
    SyncCursor, mime, now,
};

const SCHEMA_VERSION: i64 = 1;

const SCHEMA: &str = r#"
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

-- Full-text search, kept in step with messages by triggers.
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

-- Local changes not yet confirmed by the server.
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

pub struct Store {
    db: Connection,
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
        if version == 0 {
            db.execute_batch(SCHEMA)?;
            db.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        } else if version > SCHEMA_VERSION {
            return Err(Error::Invalid(
                "this database was created by a newer version of the app".into(),
            ));
        }
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
            .prepare("SELECT id, config, last_sync, last_error FROM accounts ORDER BY created_at")?;
        let rows = stmt.query_map([], account_row)?;
        rows.collect::<rusqlite::Result<_>>().map_err(Into::into)
    }

    pub fn account(&self, id: &str) -> Result<Account> {
        self.db
            .query_row(
                "SELECT id, config, last_sync, last_error FROM accounts WHERE id = ?1",
                [id],
                account_row,
            )
            .optional()?
            .ok_or_else(|| Error::NotFound("that account no longer exists".into()))
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

    // ── Reading messages ─────────────────────────────────────────────────

    pub fn messages(&self, q: &MessageQuery) -> Result<Vec<MessageSummary>> {
        let t = now();
        let mut sql = format!("SELECT {SUMMARY_COLS} FROM messages m");
        let mut clauses: Vec<String> = Vec::new();
        let mut args: Vec<rusqlite::types::Value> = Vec::new();

        if let Some(search) = q.search.as_deref().map(fts_query).filter(|s| !s.is_empty()) {
            sql.push_str(" JOIN messages_fts f ON f.rowid = m.rowid");
            clauses.push("messages_fts MATCH ?".into());
            args.push(search.into());
        }
        if let Some(account) = &q.account_id {
            clauses.push("m.account_id = ?".into());
            args.push(account.clone().into());
        }
        let awake = "(m.snoozed_until IS NULL OR m.snoozed_until <= ?)";
        match q.lane {
            Lane::Inbox => {
                clauses.push(format!("m.archived = 0 AND {awake}"));
                args.push(t.into());
            }
            Lane::Unread => {
                clauses.push(format!("m.archived = 0 AND m.seen = 0 AND {awake}"));
                args.push(t.into());
            }
            Lane::Starred => clauses.push("m.flagged = 1".into()),
            Lane::Snoozed => {
                clauses.push("m.snoozed_until > ?".into());
                args.push(t.into());
            }
            Lane::Archive => clauses.push("m.archived = 1".into()),
        }
        sql.push_str(" WHERE ");
        sql.push_str(&clauses.join(" AND "));
        sql.push_str(if q.lane == Lane::Snoozed {
            " ORDER BY m.snoozed_until ASC"
        } else {
            " ORDER BY m.sort_at DESC"
        });
        sql.push_str(" LIMIT ?");
        args.push(i64::from(q.limit.unwrap_or(200).min(1000)).into());

        let mut stmt = self.db.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(args), summary_row)?;
        rows.collect::<rusqlite::Result<_>>().map_err(Into::into)
    }

    pub fn message(&self, id: &str) -> Result<MessageDetail> {
        self.db
            .query_row(
                &format!(
                    "SELECT {SUMMARY_COLS}, m.to_json, m.cc_json, m.message_id, m.body_text, m.body_html
                     FROM messages m WHERE m.id = ?1"
                ),
                [id],
                |r| {
                    Ok(MessageDetail {
                        summary: summary_row(r)?,
                        to: from_json(r.get(12)?),
                        cc: from_json(r.get(13)?),
                        message_id: r.get(14)?,
                        body_text: r.get(15)?,
                        body_html: r.get(16)?,
                    })
                },
            )
            .optional()?
            .ok_or_else(|| Error::NotFound("that message is no longer here".into()))
    }

    // ── Local actions (each queues an op for the server) ──────────────────

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

    /// Archive or un-archive. Un-archiving is local-only for now: the IMAP
    /// adapter moves archived mail out of the synced INBOX, so it can't be
    /// moved back until Archive is synced too (Phase 1b).
    pub fn set_archived(&self, id: &str, archived: bool) -> Result<()> {
        let n = self
            .db
            .execute("UPDATE messages SET archived = ?2 WHERE id = ?1", params![id, archived])?;
        if n == 0 {
            return Err(Error::NotFound("that message is no longer here".into()));
        }
        if archived {
            self.queue_op(id, "archive")?;
        } else {
            self.db.execute(
                "DELETE FROM pending_ops WHERE message_id = ?1 AND kind = 'archive'",
                [id],
            )?;
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

    /// Resurface every snooze that is due. Returns how many woke up, so the
    /// shell knows whether to notify the UI.
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
        Ok(self
            .db
            .query_row(
                "SELECT uid_validity, last_uid FROM sync_state WHERE account_id = ?1 AND mailbox = ?2",
                params![account_id, mailbox],
                |r| Ok(SyncCursor { uid_validity: Some(r.get(0)?), last_uid: r.get(1)? }),
            )
            .optional()?
            .unwrap_or_default())
    }

    /// Local changes for one mailbox that still need to reach the server.
    pub fn pending_ops(&self, account_id: &str, mailbox: &str) -> Result<Vec<PendingOp>> {
        let mut stmt = self.db.prepare(
            "SELECT o.id, m.uid, o.kind FROM pending_ops o JOIN messages m ON m.id = o.message_id
             WHERE m.account_id = ?1 AND m.mailbox = ?2 AND m.uid IS NOT NULL ORDER BY o.id",
        )?;
        let rows = stmt.query_map(params![account_id, mailbox], |r| {
            let kind: String = r.get(2)?;
            Ok((r.get::<_, i64>(0)?, r.get::<_, u32>(1)?, kind))
        })?;
        let mut ops = Vec::new();
        for row in rows {
            let (id, uid, kind) = row?;
            let kind = match kind.as_str() {
                "seen" => OpKind::Seen(true),
                "unseen" => OpKind::Seen(false),
                "flag" => OpKind::Flagged(true),
                "unflag" => OpKind::Flagged(false),
                "archive" => OpKind::Archive,
                _ => continue,
            };
            ops.push(PendingOp { id, uid, kind });
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

        let mut inserted = 0;
        for m in &batch.new_messages {
            inserted += insert_fetched(&tx, account_id, &batch.mailbox, m)?;
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

        // Mail deleted (or archived) on the server disappears here too, unless
        // we archived it ourselves and are keeping the local copy.
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

    /// Store a message that didn't come through IMAP (demo data, imports).
    pub fn insert_local(&self, account_id: &str, mailbox: &str, raw: &[u8], seen: bool) -> Result<String> {
        let p = mime::parse(raw)?;
        let id = uuid::Uuid::new_v4().to_string();
        let date = p.date.unwrap_or_else(now);
        self.db.execute(
            &format!("INSERT INTO messages ({INSERT_COLS}) VALUES ({INSERT_PARAMS})"),
            params![
                id, account_id, mailbox, None::<u32>, p.message_id, p.from.name, p.from.email,
                json(&p.to), json(&p.cc), p.subject, p.preview, p.body_text, p.body_html,
                date, date, seen, false
            ],
        )?;
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

// ── Row helpers ──────────────────────────────────────────────────────────

const SUMMARY_COLS: &str = "m.id, m.account_id, m.from_name, m.from_email, m.subject, m.preview, \
     m.date, m.sort_at, m.seen, m.flagged, m.archived, m.snoozed_until";

const INSERT_COLS: &str = "id, account_id, mailbox, uid, message_id, from_name, from_email, \
     to_json, cc_json, subject, preview, body_text, body_html, date, sort_at, seen, flagged";
const INSERT_PARAMS: &str = "?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17";

fn insert_fetched(tx: &Connection, account_id: &str, mailbox: &str, m: &FetchedMessage) -> Result<usize> {
    // A message that won't parse is still stored, so it isn't silently lost.
    let p = mime::parse(&m.raw).unwrap_or_else(|e| mime::Parsed {
        message_id: None,
        from: Address { name: None, email: "unknown".into() },
        to: vec![],
        cc: vec![],
        subject: "(unreadable message)".into(),
        date: None,
        preview: e.to_string(),
        body_text: String::from_utf8_lossy(&m.raw).into_owned(),
        body_html: None,
    });
    let date = p.date.unwrap_or_else(now);
    let n = tx.execute(
        &format!("INSERT OR IGNORE INTO messages ({INSERT_COLS}) VALUES ({INSERT_PARAMS})"),
        params![
            uuid::Uuid::new_v4().to_string(), account_id, mailbox, m.uid, p.message_id,
            p.from.name, p.from.email, json(&p.to), json(&p.cc), p.subject, p.preview,
            p.body_text, p.body_html, date, date, m.seen, m.flagged
        ],
    )?;
    Ok(n)
}

fn summary_row(r: &Row) -> rusqlite::Result<MessageSummary> {
    Ok(MessageSummary {
        id: r.get(0)?,
        account_id: r.get(1)?,
        from: Address { name: r.get(2)?, email: r.get(3)? },
        subject: r.get(4)?,
        preview: r.get(5)?,
        date: r.get(6)?,
        sort_at: r.get(7)?,
        seen: r.get(8)?,
        flagged: r.get(9)?,
        archived: r.get(10)?,
        snoozed_until: r.get(11)?,
    })
}

fn account_row(r: &Row) -> rusqlite::Result<Account> {
    Ok(Account {
        id: r.get(0)?,
        config: serde_json::from_str(&r.get::<_, String>(1)?)
            .map_err(|e| rusqlite::Error::FromSqlConversionFailure(1, rusqlite::types::Type::Text, Box::new(e)))?,
        last_sync: r.get(2)?,
        last_error: r.get(3)?,
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

fn json<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_string(v).expect("model types always serialize")
}

fn from_json<T: serde::de::DeserializeOwned + Default>(s: String) -> T {
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
    use crate::{Provider, Security, ServerConfig};

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
            })
            .unwrap();
        (s, a.id)
    }

    fn raw(subject: &str, body: &str) -> Vec<u8> {
        format!("From: Ana <ana@example.com>\r\nSubject: {subject}\r\nDate: Tue, 13 Oct 2026 09:00:00 +0000\r\n\r\n{body}\r\n").into_bytes()
    }

    fn fetched(uid: u32, subject: &str) -> FetchedMessage {
        FetchedMessage { uid, seen: false, flagged: false, raw: raw(subject, "hello") }
    }

    fn inbox(s: &Store) -> Vec<MessageSummary> {
        s.messages(&MessageQuery { lane: Lane::Inbox, account_id: None, search: None, limit: None }).unwrap()
    }

    fn batch(uid_validity: u32, new: Vec<FetchedMessage>, server_uids: Vec<u32>) -> SyncBatch {
        SyncBatch { mailbox: "INBOX".into(), uid_validity, new_messages: new, server_uids, ..Default::default() }
    }

    #[test]
    fn sync_inserts_and_advances_cursor() {
        let (s, acct) = store_with_account();
        let n = s.apply_sync(&acct, &batch(7, vec![fetched(1, "One"), fetched(2, "Two")], vec![1, 2])).unwrap();
        assert_eq!(n, 2);
        assert_eq!(s.sync_cursor(&acct, "INBOX").unwrap(), SyncCursor { uid_validity: Some(7), last_uid: 2 });
        // Re-applying the same UIDs is a no-op.
        assert_eq!(s.apply_sync(&acct, &batch(7, vec![fetched(2, "Two")], vec![1, 2])).unwrap(), 0);
        assert_eq!(inbox(&s).len(), 2);
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
        // Server still says unseen; the local change hasn't been pushed yet.
        let mut b = batch(7, vec![], vec![1]);
        b.flags = vec![(1, false, false)];
        s.apply_sync(&acct, &b).unwrap();
        assert!(s.message(&id).unwrap().summary.seen);
        // Once the server confirms the op, server state is authoritative again.
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
        // The adapter moved it off INBOX on the server; the local copy stays in Archive.
        s.apply_sync(&acct, &batch(7, vec![], vec![])).unwrap();
        let archive = s.messages(&MessageQuery { lane: Lane::Archive, account_id: None, search: None, limit: None }).unwrap();
        assert_eq!(archive.len(), 1);
    }

    #[test]
    fn snooze_hides_then_resurfaces_unread_at_the_top() {
        let (s, acct) = store_with_account();
        s.apply_sync(&acct, &batch(7, vec![fetched(1, "Snoozed"), fetched(2, "Other")], vec![1, 2])).unwrap();
        let id = inbox(&s).iter().find(|m| m.subject == "Snoozed").unwrap().id.clone();
        s.set_seen(&id, true).unwrap();
        let until = now() + 3600;
        s.snooze(&id, until).unwrap();
        assert_eq!(inbox(&s).len(), 1);
        let snoozed = s.messages(&MessageQuery { lane: Lane::Snoozed, account_id: None, search: None, limit: None }).unwrap();
        assert_eq!(snoozed[0].snoozed_until, Some(until));

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
            FetchedMessage { uid: 1, seen: false, flagged: false, raw: raw("Ferry booking", "Saturday crossing") },
            FetchedMessage { uid: 2, seen: false, flagged: false, raw: raw("Token audit", "semantic tier") },
        ], vec![1, 2])).unwrap();
        let q = |text: &str| s.messages(&MessageQuery { lane: Lane::Inbox, account_id: None, search: Some(text.into()), limit: None }).unwrap();
        assert_eq!(q("cross")[0].subject, "Ferry booking");
        assert_eq!(q("ana")[0].from.email, "ana@example.com");
        assert_eq!(q("semantic tier").len(), 1);
        assert!(q("\"unbalanced AND (").is_empty());
    }

    #[test]
    fn undo_send_window() {
        let (s, acct) = store_with_account();
        let draft = Draft {
            account_id: acct,
            to: vec![Address { name: None, email: "ana@example.com".into() }],
            cc: vec![],
            subject: "Hi".into(),
            body: "Hello".into(),
            in_reply_to: None,
        };
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
    fn queue_send_validates_recipients() {
        let (s, acct) = store_with_account();
        let mut draft = Draft { account_id: acct, to: vec![], cc: vec![], subject: String::new(), body: String::new(), in_reply_to: None };
        assert!(s.queue_send(&draft, 10).is_err());
        draft.to.push(Address { name: None, email: "not-an-address".into() });
        assert!(s.queue_send(&draft, 10).is_err());
    }

    #[test]
    fn removing_an_account_removes_its_mail() {
        let (s, acct) = store_with_account();
        s.apply_sync(&acct, &batch(7, vec![fetched(1, "A")], vec![1])).unwrap();
        s.remove_account(&acct).unwrap();
        assert!(inbox(&s).is_empty());
    }
}
