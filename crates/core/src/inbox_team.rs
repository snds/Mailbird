//! A shared inbox on the web gateway (ADR-0063). When several people sign in
//! to one gateway, they work the same mail: each conversation can be
//! assigned to one of them, and they leave each other notes on it that never
//! go to anyone on the conversation. Who someone is comes from the gateway's
//! session, never from the page.

use std::collections::HashMap;

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::store::Store;
use crate::{Error, Result, now};

/// Version 22: who each conversation is assigned to, and the team's notes on it.
pub(crate) const MIGRATE_V22: &str = "
CREATE TABLE thread_assignees (
  thread_id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  member_name TEXT NOT NULL,
  by_name TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX thread_assignees_member ON thread_assignees(member_id);
CREATE TABLE thread_comments (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  text TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX thread_comments_thread ON thread_comments(thread_id, at);
";

/// Someone on the gateway: the owner, or a member they added.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Teammate {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Assignee {
    pub id: String,
    pub name: String,
    /// Who assigned it.
    pub by: String,
    pub at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadComment {
    pub id: String,
    pub author_id: String,
    pub author: String,
    pub text: String,
    pub at: i64,
}

/// The team's side of one conversation.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTeam {
    pub assignee: Option<Assignee>,
    pub comments: Vec<ThreadComment>,
}

/// The longest note on a conversation.
const MAX_COMMENT: usize = 4000;

impl Store {
    pub fn thread_team(&self, thread_id: &str) -> Result<ThreadTeam> {
        let assignee = self
            .db
            .query_row("SELECT member_id, member_name, by_name, at FROM thread_assignees WHERE thread_id = ?1", [thread_id], |r| {
                Ok(Assignee { id: r.get(0)?, name: r.get(1)?, by: r.get(2)?, at: r.get(3)? })
            })
            .optional()?;
        let mut stmt = self.db.prepare("SELECT id, author_id, author_name, text, at FROM thread_comments WHERE thread_id = ?1 ORDER BY at, rowid")?;
        let comments = stmt
            .query_map([thread_id], |r| Ok(ThreadComment { id: r.get(0)?, author_id: r.get(1)?, author: r.get(2)?, text: r.get(3)?, at: r.get(4)? }))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(ThreadTeam { assignee, comments })
    }

    /// Every assigned conversation, by thread: for the list's badges.
    pub fn thread_assignments(&self) -> Result<HashMap<String, Teammate>> {
        let mut stmt = self.db.prepare("SELECT thread_id, member_id, member_name FROM thread_assignees")?;
        let out = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, Teammate { id: r.get(1)?, name: r.get(2)? })))?.collect::<rusqlite::Result<HashMap<_, _>>>()?;
        Ok(out)
    }

    /// Assigns a conversation to someone, or to nobody.
    pub fn assign_thread(&self, thread_id: &str, to: Option<&Teammate>, by: &Teammate) -> Result<ThreadTeam> {
        if self.thread(thread_id)?.is_empty() {
            return Err(Error::NotFound("that conversation isn't here any more".into()));
        }
        match to {
            Some(m) => self.db.execute(
                "INSERT INTO thread_assignees (thread_id, member_id, member_name, by_name, at) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(thread_id) DO UPDATE SET member_id = ?2, member_name = ?3, by_name = ?4, at = ?5",
                params![thread_id, m.id, m.name.trim(), by.name.trim(), now()],
            )?,
            None => self.db.execute("DELETE FROM thread_assignees WHERE thread_id = ?1", [thread_id])?,
        };
        self.thread_team(thread_id)
    }

    /// Leaves the team a note on a conversation.
    pub fn add_thread_comment(&self, thread_id: &str, by: &Teammate, text: &str) -> Result<ThreadTeam> {
        let text = text.trim();
        if text.is_empty() {
            return Err(Error::Invalid("write something first".into()));
        }
        if text.chars().count() > MAX_COMMENT {
            return Err(Error::Invalid(format!("that's longer than a note can be ({MAX_COMMENT} characters)")));
        }
        if self.thread(thread_id)?.is_empty() {
            return Err(Error::NotFound("that conversation isn't here any more".into()));
        }
        self.db.execute(
            "INSERT INTO thread_comments (id, thread_id, author_id, author_name, text, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![uuid::Uuid::new_v4().simple().to_string(), thread_id, by.id, by.name.trim(), text, now()],
        )?;
        self.thread_team(thread_id)
    }

    /// Takes a note back: its author can, and so can the gateway's owner.
    /// Returns the conversation it was on.
    pub fn remove_thread_comment(&self, id: &str, by: &Teammate, owner: bool) -> Result<String> {
        let (thread_id, author): (String, String) = self
            .db
            .query_row("SELECT thread_id, author_id FROM thread_comments WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?
            .ok_or_else(|| Error::NotFound("that note isn't here any more".into()))?;
        if author != by.id && !owner {
            return Err(Error::Invalid("only the person who wrote a note can delete it".into()));
        }
        self.db.execute("DELETE FROM thread_comments WHERE id = ?1", [id])?;
        Ok(thread_id)
    }

    /// Someone left the team: what was theirs goes back to nobody.
    pub fn unassign_member(&self, member_id: &str) -> Result<usize> {
        Ok(self.db.execute("DELETE FROM thread_assignees WHERE member_id = ?1", [member_id])?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AccountConfig, FetchedMessage, Lane, MessageQuery, Provider, Security, ServerConfig, SyncBatch};

    fn store_with_thread() -> (Store, String) {
        let s = Store::open_in_memory().unwrap();
        let server = ServerConfig { host: "localhost".into(), port: 143, security: Security::Plain };
        let a = s
            .add_account(&AccountConfig { display_name: "Support".into(), address: "help@example.com".into(), username: "help".into(), provider: Provider::Generic, imap: server.clone(), smtp: ServerConfig { port: 25, ..server }, jmap: None, dav: None, oauth: None })
            .unwrap();
        let raw = b"From: Kim <kim@example.org>\r\nTo: help@example.com\r\nSubject: Refund for order 42\r\nMessage-ID: <r1@x>\r\nDate: Tue, 13 Oct 2026 10:00:00 +0000\r\n\r\nIt arrived broken.\r\n".to_vec();
        let batch = SyncBatch { mailbox: "INBOX".into(), uid_validity: 1, new_messages: vec![FetchedMessage { uid: 1, seen: false, flagged: false, raw }], server_uids: vec![1], ..Default::default() };
        s.apply_sync(&a.id, &batch).unwrap();
        let tid = s.messages(&inbox(None)).unwrap()[0].thread_id.clone();
        (s, tid)
    }

    fn inbox(assigned_to: Option<&str>) -> MessageQuery {
        MessageQuery { lane: Lane::Inbox, account_id: None, search: None, limit: None, offset: None, category: None, split: None, bundle: false, assigned_to: assigned_to.map(Into::into) }
    }

    fn who(id: &str, name: &str) -> Teammate {
        Teammate { id: id.into(), name: name.into() }
    }

    #[test]
    fn a_conversation_is_assigned_to_one_person_at_a_time() {
        let (s, tid) = store_with_thread();
        let (owner, ana, sam) = (who("owner", "Lee"), who("m1", "Ana"), who("m2", "Sam"));
        assert_eq!(s.thread_team(&tid).unwrap(), ThreadTeam::default());
        let t = s.assign_thread(&tid, Some(&ana), &owner).unwrap().assignee.unwrap();
        assert_eq!((t.id.as_str(), t.name.as_str(), t.by.as_str()), ("m1", "Ana", "Lee"));
        assert_eq!(s.messages(&inbox(Some("m1"))).unwrap().len(), 1, "Ana's list has it");
        assert!(s.messages(&inbox(Some("m2"))).unwrap().is_empty(), "Sam's doesn't");
        s.assign_thread(&tid, Some(&sam), &ana).unwrap();
        assert!(s.messages(&inbox(Some("m1"))).unwrap().is_empty(), "handed on");
        assert_eq!(s.thread_assignments().unwrap().get(&tid), Some(&sam));
        assert_eq!(s.unassign_member("m2").unwrap(), 1);
        assert_eq!(s.thread_team(&tid).unwrap().assignee, None, "someone who left has nothing");
        s.assign_thread(&tid, Some(&ana), &owner).unwrap();
        assert_eq!(s.assign_thread(&tid, None, &ana).unwrap().assignee, None);
        assert!(s.assign_thread("nope", Some(&ana), &owner).is_err());
    }

    #[test]
    fn notes_stay_with_the_team_and_only_their_author_takes_them_back() {
        let (s, tid) = store_with_thread();
        let (owner, ana, sam) = (who("owner", "Lee"), who("m1", "Ana"), who("m2", "Sam"));
        s.add_thread_comment(&tid, &ana, " Refund approved? ").unwrap();
        let team = s.add_thread_comment(&tid, &sam, "Yes, send the label").unwrap();
        assert_eq!(team.comments.iter().map(|c| (c.author.as_str(), c.text.as_str())).collect::<Vec<_>>(), vec![("Ana", "Refund approved?"), ("Sam", "Yes, send the label")]);
        assert!(s.add_thread_comment(&tid, &ana, "  ").is_err(), "an empty note");
        assert!(s.add_thread_comment(&tid, &ana, &"x".repeat(MAX_COMMENT + 1)).is_err(), "a too-long note");
        let first = team.comments[0].id.clone();
        assert!(s.remove_thread_comment(&first, &sam, false).is_err(), "Sam can't take back Ana's note");
        assert_eq!(s.remove_thread_comment(&first, &ana, false).unwrap(), tid);
        let second = team.comments[1].id.clone();
        s.remove_thread_comment(&second, &owner, true).unwrap();
        assert!(s.thread_team(&tid).unwrap().comments.is_empty());
        assert!(s.remove_thread_comment(&second, &owner, true).is_err(), "gone");
    }
}
