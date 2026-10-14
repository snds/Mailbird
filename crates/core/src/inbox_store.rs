//! Your inbox, your way (ADR-0022): split inboxes made from simple rules,
//! and newsletters folded into one bundle row with one-tap clean-up.

use rusqlite::types::Value;

use crate::sender_store::CATEGORY;
use crate::store::{SENT, Store, from_json, json};
use crate::{Category, Error, InboxOverview, Lane, MessageQuery, NewsletterBundle, Result, Split, SplitCount, SplitInput};

const SPLITS: &str = "splits";
/// Fewer than this many newsletters stay as rows: bundling one helps nobody.
const BUNDLE_MIN: usize = 2;
/// How many conversations the overview and bulk actions look at.
const LOOK: u32 = 1000;

fn like(s: &str) -> String {
    format!("%{}%", s.replace(['%', '_'], ""))
}

/// A split's rule as SQL over `messages m`, with its arguments.
pub(crate) fn split_sql(rule: &SplitInput) -> (String, Vec<Value>) {
    let mut parts = Vec::new();
    let mut args: Vec<Value> = Vec::new();
    let senders: Vec<String> = rule.senders.iter().map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()).collect();
    if !senders.is_empty() {
        let mut any = Vec::new();
        for s in senders {
            if let Some(domain) = s.strip_prefix('@') {
                // "@studio.example" also takes subdomains (mail.studio.example).
                any.push("(lower(m.from_email) LIKE ? OR lower(m.from_email) LIKE ?)".to_string());
                args.push(format!("%@{domain}").into());
                args.push(format!("%.{domain}").into());
            } else {
                any.push("lower(m.from_email) = ?".to_string());
                args.push(s.into());
            }
        }
        parts.push(format!("({})", any.join(" OR ")));
    }
    if let Some(words) = rule.subject.as_deref().map(str::trim).filter(|w| !w.is_empty()) {
        parts.push("m.subject LIKE ?".into());
        args.push(like(words).into());
    }
    if rule.has_attachments {
        parts.push("m.has_attachments = 1".into());
    }
    if let Some(a) = &rule.account_id {
        parts.push("m.account_id = ?".into());
        args.push(a.clone().into());
    }
    (format!("({})", parts.join(" AND ")), args)
}

fn check(rule: &SplitInput) -> Result<SplitInput> {
    let mut r = rule.clone();
    r.name = r.name.trim().to_string();
    r.senders = r.senders.iter().map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()).collect();
    r.subject = r.subject.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    if r.name.is_empty() {
        return Err(Error::Invalid("give the split a name".into()));
    }
    if r.senders.is_empty() && r.subject.is_none() && !r.has_attachments && r.account_id.is_none() {
        return Err(Error::Invalid("say what goes in it: a sender, a domain, or subject words".into()));
    }
    if let Some(bad) = r.senders.iter().find(|s| !s.contains('@') || s.ends_with('@')) {
        return Err(Error::Invalid(format!("“{bad}” isn't an address or a domain like @example.com")));
    }
    Ok(r)
}

impl Store {
    pub fn splits(&self) -> Result<Vec<Split>> {
        Ok(self.setting(SPLITS)?.map(from_json).unwrap_or_default())
    }

    /// Adds a split, or changes the one with `id`.
    pub fn save_split(&self, id: Option<&str>, input: &SplitInput) -> Result<Split> {
        let rule = check(input)?;
        let mut all = self.splits()?;
        let split = match id {
            Some(id) => {
                let s = all.iter_mut().find(|s| s.id == id).ok_or_else(|| Error::NotFound("that split was deleted".into()))?;
                s.rule = rule;
                s.clone()
            }
            None => {
                let s = Split { id: uuid::Uuid::new_v4().to_string(), rule };
                all.push(s.clone());
                s
            }
        };
        self.set_setting(SPLITS, Some(&json(&all)))?;
        Ok(split)
    }

    pub fn delete_split(&self, id: &str) -> Result<Vec<Split>> {
        let mut all = self.splits()?;
        all.retain(|s| s.id != id);
        self.set_setting(SPLITS, Some(&json(&all)))?;
        Ok(all)
    }

    /// Moves a split to `index` among the tabs.
    pub fn move_split(&self, id: &str, index: usize) -> Result<Vec<Split>> {
        let mut all = self.splits()?;
        let at = all.iter().position(|s| s.id == id).ok_or_else(|| Error::NotFound("that split was deleted".into()))?;
        let s = all.remove(at);
        all.insert(index.min(all.len()), s);
        self.set_setting(SPLITS, Some(&json(&all)))?;
        Ok(all)
    }

    /// Extra WHERE clauses for the inbox: a split's own rule, or (for the
    /// main inbox) leaving out what exclusive splits take and, when asked,
    /// the newsletter bundle.
    pub(crate) fn inbox_clauses(&self, q: &MessageQuery) -> Result<Vec<(String, Vec<Value>)>> {
        if q.lane != Lane::Inbox {
            return Ok(vec![]);
        }
        let splits = self.splits()?;
        if let Some(id) = &q.split {
            let s = splits.iter().find(|s| &s.id == id).ok_or_else(|| Error::NotFound("that split was deleted".into()))?;
            return Ok(vec![split_sql(&s.rule)]);
        }
        let mut out: Vec<(String, Vec<Value>)> = splits
            .iter()
            .filter(|s| s.rule.exclusive)
            .map(|s| {
                let (sql, args) = split_sql(&s.rule);
                (format!("NOT {sql}"), args)
            })
            .collect();
        if q.bundle && q.category.is_none() && self.bundle_rows(q.account_id.as_deref())?.len() >= BUNDLE_MIN {
            out.push((format!("{CATEGORY} <> 'newsletters'"), vec![]));
        }
        Ok(out)
    }

    /// The newsletter conversations in the main inbox (not taken by a split).
    fn bundle_rows(&self, account_id: Option<&str>) -> Result<Vec<crate::MessageSummary>> {
        self.messages(&MessageQuery {
            lane: Lane::Inbox,
            account_id: account_id.map(String::from),
            search: None,
            limit: Some(LOOK),
            offset: None,
            category: Some(Category::Newsletters),
            split: None,
            bundle: false,
        })
    }

    /// Split tab counts and the newsletter bundle, for the inbox header.
    pub fn inbox_overview(&self, account_id: Option<&str>) -> Result<InboxOverview> {
        let mut splits = Vec::new();
        for s in self.splits()? {
            let rows = self.messages(&MessageQuery {
                lane: Lane::Inbox,
                account_id: account_id.map(String::from),
                search: None,
                limit: Some(LOOK),
                offset: None,
                category: None,
                split: Some(s.id.clone()),
                bundle: false,
            })?;
            splits.push(SplitCount { id: s.id, threads: rows.len() as u32, unread: rows.iter().filter(|r| !r.seen).count() as u32 });
        }
        let rows = self.bundle_rows(account_id)?;
        let bundle = (rows.len() >= BUNDLE_MIN).then(|| {
            let mut senders: Vec<String> = Vec::new();
            for r in &rows {
                let who = r.from.name.clone().filter(|n| !n.trim().is_empty()).unwrap_or_else(|| r.from.email.clone());
                if !senders.contains(&who) && senders.len() < 3 {
                    senders.push(who);
                }
            }
            NewsletterBundle { threads: rows.len() as u32, unread: rows.iter().filter(|r| !r.seen).count() as u32, latest: rows.iter().map(|r| r.date).max().unwrap_or(0), senders }
        });
        Ok(InboxOverview { splits, bundle })
    }

    /// The bundle's received messages, for the bulk actions.
    fn bundle_messages(&self, account_id: Option<&str>) -> Result<Vec<(String, bool)>> {
        let threads: Vec<String> = self.bundle_rows(account_id)?.into_iter().map(|r| r.thread_id).collect();
        let mut st = self.db.prepare(&format!("SELECT id, seen FROM messages WHERE thread_id = ?1 AND archived = 0 AND mailbox <> '{SENT}'"))?;
        let mut out = Vec::new();
        for t in threads {
            for row in st.query_map([t], |r| Ok((r.get(0)?, r.get(1)?)))? {
                out.push(row?);
            }
        }
        Ok(out)
    }

    /// Marks every newsletter in the bundle read. Returns how many changed.
    pub fn bundle_mark_read(&self, account_id: Option<&str>) -> Result<u32> {
        let mut n = 0;
        for (id, seen) in self.bundle_messages(account_id)? {
            if !seen {
                self.set_seen(&id, true)?;
                n += 1;
            }
        }
        Ok(n)
    }

    /// Archives every newsletter in the bundle (on the server too). Returns
    /// undo keys: each message's Message-ID (its row id when it has none).
    /// Row and thread ids don't survive the move: once the server files a
    /// message in Archive, sync brings it back as a new row.
    pub fn bundle_archive(&self, account_id: Option<&str>) -> Result<Vec<String>> {
        let mut keys = Vec::new();
        for (id, _) in self.bundle_messages(account_id)? {
            let header: Option<String> = self.db.query_row("SELECT message_id FROM messages WHERE id = ?1", [&id], |r| r.get(0))?;
            self.set_archived(&id, true)?;
            keys.push(header.filter(|h| !h.is_empty()).unwrap_or(id));
        }
        Ok(keys)
    }

    /// Undoes `bundle_archive`, wherever the archived copies now live.
    pub fn unarchive_bundle(&self, keys: &[String]) -> Result<()> {
        let mut st = self.db.prepare(&format!("SELECT id FROM messages WHERE (message_id = ?1 OR id = ?1) AND archived = 1 AND mailbox <> '{SENT}'"))?;
        let mut found = Vec::new();
        for k in keys {
            for id in st.query_map([k], |r| r.get::<_, String>(0))? {
                found.push(id?);
            }
        }
        if found.is_empty() && !keys.is_empty() {
            return Err(Error::NotFound("those newsletters are still on their way to Archive; try again in a moment".into()));
        }
        for id in &found {
            self.set_archived(id, false)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::INBOX;
    use crate::{AccountConfig, Provider, Security, ServerConfig};

    fn store() -> (Store, String) {
        let s = Store::open_in_memory().unwrap();
        let server = ServerConfig { host: "localhost".into(), port: 143, security: Security::Plain };
        let a = s
            .add_account(&AccountConfig {
                display_name: "Me".into(),
                address: "me@example.com".into(),
                username: "me".into(),
                provider: Provider::Generic,
                imap: server.clone(),
                smtp: server,
                jmap: None,
                dav: None,
                oauth: None,
            })
            .unwrap();
        (s, a.id)
    }

    fn mail(s: &Store, account: &str, from: &str, subject: &str, extra: &str) -> String {
        let raw = format!("From: {from}\r\nTo: me@example.com\r\nSubject: {subject}\r\nMessage-ID: <{}@x>\r\n{extra}\r\nHello\r\n", uuid::Uuid::new_v4());
        s.insert_local(account, INBOX, raw.as_bytes(), false).unwrap()
    }

    fn inbox(s: &Store, split: Option<&str>, bundle: bool) -> Vec<String> {
        let q = MessageQuery { lane: Lane::Inbox, account_id: None, search: None, limit: None, offset: None, category: None, split: split.map(String::from), bundle };
        let mut v: Vec<String> = s.messages(&q).unwrap().into_iter().map(|m| m.subject).collect();
        v.sort();
        v
    }

    fn rule(name: &str, senders: &[&str], exclusive: bool) -> SplitInput {
        SplitInput { name: name.into(), senders: senders.iter().map(|s| s.to_string()).collect(), exclusive, ..Default::default() }
    }

    #[test]
    fn splits_catch_mail_by_rule() {
        let (s, a) = store();
        mail(&s, &a, "Priya <priya@studio.example>", "Token audit", "");
        mail(&s, &a, "CI <ci@build.studio.example>", "Build failed", "");
        mail(&s, &a, "Ana <ana@example.com>", "Invoice March", "");
        mail(&s, &a, "Rui <rui@clay.example>", "Kiln", "");

        let work = s.save_split(None, &rule("Work", &["@studio.example"], true)).unwrap();
        assert_eq!(inbox(&s, Some(&work.id), false), vec!["Build failed", "Token audit"], "a domain takes its subdomains too");
        assert_eq!(inbox(&s, None, false), vec!["Invoice March", "Kiln"], "an exclusive split's mail leaves the main inbox");

        let bills = s.save_split(None, &SplitInput { name: "Bills".into(), subject: Some("invoice".into()), ..Default::default() }).unwrap();
        assert_eq!(inbox(&s, Some(&bills.id), false), vec!["Invoice March"], "subject words, any case");
        assert_eq!(inbox(&s, None, false), vec!["Invoice March", "Kiln"], "a shared split leaves its mail in the inbox too");

        let counts = s.inbox_overview(None).unwrap().splits;
        assert_eq!(counts.iter().map(|c| (c.threads, c.unread)).collect::<Vec<_>>(), vec![(2, 2), (1, 1)]);

        // Edit, reorder, delete.
        s.save_split(Some(&work.id), &rule("Studio", &["priya@studio.example"], true)).unwrap();
        assert_eq!(inbox(&s, None, false), vec!["Build failed", "Invoice March", "Kiln"]);
        assert_eq!(s.move_split(&bills.id, 0).unwrap()[0].rule.name, "Bills");
        assert_eq!(s.delete_split(&work.id).unwrap().len(), 1);
        assert_eq!(inbox(&s, None, false).len(), 4);
        assert!(s.messages(&MessageQuery { split: Some(work.id), ..q_inbox() }).is_err(), "a deleted split");
    }

    fn q_inbox() -> MessageQuery {
        MessageQuery { lane: Lane::Inbox, account_id: None, search: None, limit: None, offset: None, category: None, split: None, bundle: false }
    }

    #[test]
    fn splits_need_a_rule_and_valid_senders() {
        let (s, _) = store();
        assert!(s.save_split(None, &rule("", &["@x.example"], false)).is_err(), "a name");
        assert!(s.save_split(None, &rule("Empty", &[], false)).is_err(), "something to match");
        assert!(s.save_split(None, &rule("Typo", &["studio.example"], false)).is_err(), "an address or @domain");
        assert_eq!(s.save_split(None, &rule("Ok", &[" @Studio.Example "], false)).unwrap().rule.senders, vec!["@studio.example"], "trimmed and lowercased");
    }

    #[test]
    fn newsletters_fold_into_a_bundle() {
        let (s, a) = store();
        mail(&s, &a, "Ana <ana@example.com>", "Photos", "");
        mail(&s, &a, "Design Weekly <digest@dsweekly.example>", "Issue 212", "List-Id: <dsweekly.example>\r\n");
        assert_eq!(inbox(&s, None, true).len(), 2, "one newsletter stays a row");
        assert_eq!(s.inbox_overview(None).unwrap().bundle, None);

        mail(&s, &a, "Clay Club <news@clay.example>", "Kiln news", "List-Unsubscribe: <mailto:leave@clay.example>\r\n");
        assert_eq!(inbox(&s, None, true), vec!["Photos"], "two or more fold away");
        assert_eq!(inbox(&s, None, false).len(), 3, "only when asked");
        let b = s.inbox_overview(None).unwrap().bundle.unwrap();
        assert_eq!((b.threads, b.unread, b.senders.len()), (2, 2, 2));

        assert_eq!(s.bundle_mark_read(None).unwrap(), 2);
        assert_eq!(s.inbox_overview(None).unwrap().bundle.unwrap().unread, 0);
        // As if synced: messages with a server UID get server ops.
        s.db.execute("UPDATE messages SET uid = rowid", []).unwrap();
        let ids = s.bundle_archive(None).unwrap();
        assert_eq!(ids.len(), 2);
        assert_eq!(inbox(&s, None, false), vec!["Photos"], "archived");
        let ops: i64 = s.db.query_row("SELECT count(*) FROM pending_ops WHERE kind = 'archive'", [], |r| r.get(0)).unwrap();
        assert_eq!(ops, 2, "on the server too");
        // The server files them in Archive: sync drops the rows and brings
        // them back as new ones. Undo still finds them by Message-ID.
        let raws: Vec<Vec<u8>> = s.db.prepare("SELECT raw FROM messages WHERE archived = 1").unwrap().query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect();
        s.db.execute("DELETE FROM pending_ops", []).unwrap();
        s.db.execute("DELETE FROM messages WHERE archived = 1", []).unwrap();
        for raw in &raws {
            s.insert_local(&a, crate::store::ARCHIVE, raw, true).unwrap();
        }
        s.db.execute("UPDATE messages SET archived = 1, uid = rowid WHERE mailbox = 'Archive'", []).unwrap();
        s.unarchive_bundle(&ids).unwrap();
        assert_eq!(inbox(&s, None, false).len(), 3, "and undone");
        let ops: i64 = s.db.query_row("SELECT count(*) FROM pending_ops WHERE kind = 'unarchive'", [], |r| r.get(0)).unwrap();
        assert_eq!(ops, 2, "moved back on the server");
        assert!(s.unarchive_bundle(&["<gone@x>".into()]).is_err(), "nothing to undo says so");
    }
}
