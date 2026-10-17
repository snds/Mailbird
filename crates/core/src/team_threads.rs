//! Conversations shared with teammates (ADR-0060). A shared conversation is
//! a Yjs document on the owner's notes relay, `mailbird/shared/<id>`, the
//! same kind of link as a shared note (ADR-0056): a copy of the messages,
//! the team's comments, and a reply they write together. The owner sends
//! that reply from their own account; teammates never send.
//!
//! The core keeps the list (which conversations you shared, which were
//! shared with you) and each document's last state, so a conversation
//! whose link was stopped stays readable as a copy.

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::store::Store;
use crate::{Error, Result, ShareRole, now};

/// Version 20: shared conversations and their documents.
pub(crate) const MIGRATE_V20: &str = "
CREATE TABLE team_threads (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  thread_id TEXT,
  revoked INTEGER NOT NULL DEFAULT 0,
  relay TEXT,
  token TEXT,
  title TEXT NOT NULL DEFAULT '',
  sender TEXT,
  ydoc TEXT,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX team_threads_thread ON team_threads(thread_id);
";

/// Version 21: a share's own key, when it's end-to-end encrypted (ADR-0062).
pub(crate) const MIGRATE_V21: &str = "ALTER TABLE team_threads ADD COLUMN key TEXT;";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamThread {
    /// The share's id: its document is `mailbird/shared/<id>`.
    pub id: String,
    pub role: ShareRole,
    /// The owner's conversation (theirs only: a teammate has a copy, not the mail).
    pub thread_id: Option<String>,
    /// The owner stopped sharing. A teammate keeps a read-only copy.
    pub revoked: bool,
    /// A teammate's way in: the owner's relay and the link's token.
    pub relay: Option<String>,
    pub token: Option<String>,
    /// Its key when it's end-to-end encrypted (ADR-0062): the document is
    /// then `mailbird/x/shared/<id>`.
    pub key: Option<String>,
    pub title: String,
    /// Who shared it, as their accounts name them.
    pub from: Option<String>,
    pub created: i64,
    pub updated: i64,
}

/// A teammate's link, as the UI read it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamLink {
    pub id: String,
    pub relay: String,
    pub token: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub key: Option<String>,
}

const COLS: &str = "id, role, thread_id, revoked, relay, token, title, sender, created, updated, key";

fn row(r: &rusqlite::Row) -> rusqlite::Result<TeamThread> {
    Ok(TeamThread {
        id: r.get(0)?,
        role: if r.get::<_, String>(1)? == "owner" { ShareRole::Owner } else { ShareRole::Guest },
        thread_id: r.get(2)?,
        revoked: r.get::<_, i64>(3)? != 0,
        relay: r.get(4)?,
        token: r.get(5)?,
        title: r.get(6)?,
        from: r.get(7)?,
        created: r.get(8)?,
        updated: r.get(9)?,
        key: r.get(10)?,
    })
}

/// The relay serves `mailbird/shared/<id>` only for ids like these.
fn valid_id(id: &str) -> bool {
    (16..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

impl Store {
    /// Every shared conversation, most recently active first.
    pub fn team_threads(&self) -> Result<Vec<TeamThread>> {
        let mut stmt = self.db.prepare(&format!("SELECT {COLS} FROM team_threads ORDER BY updated DESC"))?;
        let out = stmt.query_map([], row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(out)
    }

    pub fn team_thread(&self, id: &str) -> Result<TeamThread> {
        self.db
            .query_row(&format!("SELECT {COLS} FROM team_threads WHERE id = ?1"), [id], row)
            .optional()?
            .ok_or_else(|| Error::NotFound("that shared conversation isn't here any more".into()))
    }

    /// Shares one of your conversations. Sharing one that's already shared
    /// returns its link; one that was stopped gets a new link. With `sealed`
    /// (your sync is end-to-end encrypted), a new link gets a key.
    pub fn share_thread(&self, thread_id: &str, from: Option<&str>, sealed: bool) -> Result<TeamThread> {
        let live: Option<String> = self
            .db
            .query_row("SELECT id FROM team_threads WHERE role = 'owner' AND thread_id = ?1 AND revoked = 0", [thread_id], |r| r.get(0))
            .optional()?;
        if let Some(id) = live {
            return self.team_thread(&id);
        }
        let messages = self.thread(thread_id)?;
        let Some(last) = messages.last() else { return Err(Error::NotFound("that conversation isn't here any more".into())) };
        let id = uuid::Uuid::new_v4().simple().to_string();
        let t = now();
        self.db.execute(
            "INSERT INTO team_threads (id, role, thread_id, title, sender, created, updated, key) VALUES (?1, 'owner', ?2, ?3, ?4, ?5, ?5, ?6)",
            params![id, thread_id, last.summary.subject, from.map(str::trim).filter(|f| !f.is_empty()), t, sealed.then(crate::note_shares::new_share_key)],
        )?;
        self.team_thread(&id)
    }

    /// Your shared conversation, if this one is shared right now.
    pub fn thread_share(&self, thread_id: &str) -> Result<Option<TeamThread>> {
        let id: Option<String> = self
            .db
            .query_row("SELECT id FROM team_threads WHERE role = 'owner' AND thread_id = ?1 AND revoked = 0", [thread_id], |r| r.get(0))
            .optional()?;
        id.map(|id| self.team_thread(&id)).transpose()
    }

    /// Joins a conversation from a teammate's link. The same link twice
    /// finds the one already joined; a stopped one can't be joined again.
    pub fn join_team_thread(&self, link: &TeamLink) -> Result<TeamThread> {
        let relay = link.relay.trim();
        let token = link.token.trim();
        if !valid_id(&link.id) || !(relay.starts_with("ws://") || relay.starts_with("wss://")) || token.is_empty() {
            return Err(Error::Invalid("that link isn't complete".into()));
        }
        let key = crate::note_shares::link_key(link.key.as_deref()).map_err(|_| Error::Invalid("that link isn't complete".into()))?;
        if let Ok(t) = self.team_thread(&link.id) {
            if t.revoked {
                return Err(Error::Invalid("That conversation isn't shared any more.".into()));
            }
            return Ok(t);
        }
        let t = now();
        self.db.execute(
            "INSERT INTO team_threads (id, role, relay, token, title, sender, created, updated, key) VALUES (?1, 'guest', ?2, ?3, ?4, ?5, ?6, ?6, ?7)",
            params![link.id, relay, token, link.title.trim(), link.from.as_deref().map(str::trim).filter(|f| !f.is_empty()), t, key],
        )?;
        self.team_thread(&link.id)
    }

    /// Stops a shared conversation: the owner's link stops working for good
    /// (the row stays, so the relay keeps refusing it); a teammate's becomes
    /// a read-only copy.
    pub fn stop_team_thread(&self, id: &str) -> Result<TeamThread> {
        self.db.execute("UPDATE team_threads SET revoked = 1, updated = MAX(?2, updated + 1) WHERE id = ?1", params![id, now()])?;
        self.team_thread(id)
    }

    /// Takes it off your list. A live link of yours has to be stopped first.
    pub fn remove_team_thread(&self, id: &str) -> Result<()> {
        let t = self.team_thread(id)?;
        if t.role == ShareRole::Owner && !t.revoked {
            return Err(Error::Invalid("Stop sharing this conversation first.".into()));
        }
        self.db.execute("DELETE FROM team_threads WHERE id = ?1", [id])?;
        Ok(())
    }

    /// The document's last state (base64 Yjs), or `None` before its first save.
    pub fn team_doc(&self, id: &str) -> Result<Option<String>> {
        Ok(self.db.query_row("SELECT ydoc FROM team_threads WHERE id = ?1", [id], |r| r.get(0)).optional()?.flatten())
    }

    /// Saves the document's state, with its title, and marks it active.
    pub fn save_team_doc(&self, id: &str, ydoc: &str, title: Option<&str>) -> Result<TeamThread> {
        let n = self.db.execute(
            "UPDATE team_threads SET ydoc = ?2, title = COALESCE(?3, title), updated = MAX(?4, updated + 1) WHERE id = ?1",
            params![id, ydoc, title.map(str::trim).filter(|t| !t.is_empty()), now()],
        )?;
        if n == 0 {
            return Err(Error::NotFound("that shared conversation isn't here any more".into()));
        }
        self.team_thread(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AccountConfig, FetchedMessage, MessageQuery, Provider, Security, ServerConfig, SyncBatch};

    fn store_with_thread() -> (Store, String) {
        let s = Store::open_in_memory().unwrap();
        let server = ServerConfig { host: "localhost".into(), port: 143, security: Security::Plain };
        let a = s
            .add_account(&AccountConfig { display_name: "Sam".into(), address: "sam@example.com".into(), username: "sam".into(), provider: Provider::Generic, imap: server.clone(), smtp: ServerConfig { port: 25, ..server }, jmap: None, dav: None, oauth: None })
            .unwrap();
        let raw = b"From: Ana <ana@example.org>\r\nTo: sam@example.com\r\nSubject: Offsite venue\r\nMessage-ID: <v1@x>\r\nDate: Tue, 13 Oct 2026 10:00:00 +0000\r\n\r\nCan we book it?\r\n".to_vec();
        let batch = SyncBatch { mailbox: "INBOX".into(), uid_validity: 1, new_messages: vec![FetchedMessage { uid: 1, seen: false, flagged: false, raw }], server_uids: vec![1], ..Default::default() };
        s.apply_sync(&a.id, &batch).unwrap();
        let q = MessageQuery { lane: crate::Lane::Inbox, account_id: None, search: None, limit: None, offset: None, category: None, split: None, bundle: false };
        let tid = s.messages(&q).unwrap()[0].thread_id.clone();
        (s, tid)
    }

    #[test]
    fn sharing_a_conversation_keeps_one_live_link() {
        let (s, tid) = store_with_thread();
        let a = s.share_thread(&tid, Some(" Sam "), false).unwrap();
        assert_eq!((a.role, a.title.as_str(), a.from.as_deref(), a.revoked), (ShareRole::Owner, "Offsite venue", Some("Sam"), false));
        assert!(valid_id(&a.id));
        assert_eq!(s.share_thread(&tid, None, false).unwrap().id, a.id, "sharing again finds the same link");
        assert_eq!(s.thread_share(&tid).unwrap().map(|t| t.id), Some(a.id.clone()));
        assert!(s.remove_team_thread(&a.id).is_err(), "a live link is stopped first");
        let stopped = s.stop_team_thread(&a.id).unwrap();
        assert!(stopped.revoked);
        assert_eq!(s.thread_share(&tid).unwrap(), None);
        let b = s.share_thread(&tid, None, false).unwrap();
        assert_ne!(b.id, a.id, "a stopped link never comes back");
        s.remove_team_thread(&a.id).unwrap();
        assert_eq!(s.team_threads().unwrap().len(), 1);
        assert!(s.share_thread("nope", None, false).is_err());
    }

    #[test]
    fn a_teammate_joins_once_and_keeps_a_copy() {
        let s = Store::open_in_memory().unwrap();
        let link = TeamLink { id: "0123456789abcdef0123".into(), relay: " wss://notes.example.com ".into(), token: "s1.x".into(), title: "Offsite venue".into(), from: Some("Sam".into()), key: None };
        let t = s.join_team_thread(&link).unwrap();
        assert_eq!((t.role, t.relay.as_deref(), t.thread_id.as_deref()), (ShareRole::Guest, Some("wss://notes.example.com"), None));
        assert_eq!(s.join_team_thread(&link).unwrap().created, t.created, "the same link twice is one conversation");
        let saved = s.save_team_doc(&t.id, "AAA=", Some("Re: Offsite venue")).unwrap();
        assert_eq!(saved.title, "Re: Offsite venue");
        assert!(saved.updated > t.updated);
        assert_eq!(s.team_doc(&t.id).unwrap().as_deref(), Some("AAA="));
        s.stop_team_thread(&t.id).unwrap();
        assert!(s.join_team_thread(&link).is_err(), "a stopped link can't be joined again");
        assert_eq!(s.team_doc(&t.id).unwrap().as_deref(), Some("AAA="), "the copy stays");
        s.remove_team_thread(&t.id).unwrap();
        assert!(s.team_threads().unwrap().is_empty());
        for bad in [TeamLink { id: "short".into(), ..link.clone() }, TeamLink { relay: "https://x".into(), ..link.clone() }, TeamLink { token: " ".into(), ..link.clone() }, TeamLink { key: Some("short".into()), ..link }] {
            assert!(s.join_team_thread(&bad).is_err());
        }
    }

    #[test]
    fn a_sealed_conversation_carries_its_key() {
        let (s, tid) = store_with_thread();
        let key = s.share_thread(&tid, None, true).unwrap().key.expect("a sealed share has a key");
        assert_eq!(key.len(), 43);
        let link = TeamLink { id: "0123456789abcdef9999".into(), relay: "wss://n.example.com".into(), token: "s1.x".into(), title: String::new(), from: None, key: Some(key.clone()) };
        assert_eq!(s.join_team_thread(&link).unwrap().key, Some(key));
    }
}
