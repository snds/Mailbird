//! Senders: the Screener's decisions and category overrides (ADR-0018).
//!
//! A sender is an address, lowercased, across all accounts. You decide about
//! a person once, not once per account.
//!
//! - **The Screener** (off by default) holds mail from first-time senders,
//!   arriving after it was turned on, in its own lane until you say yes or no.
//!   Known senders skip it: anyone you've written to (stored as `allowed`
//!   when your mail is stored), anyone in your contacts, and anyone allowed.
//! - **Screened out / blocked** senders' mail is archived as it arrives, on
//!   the server too, so other mail apps agree. Blocking also marks it read.
//!   This works with the Screener off.
//! - **Categories** sort mail into People, Updates, and Newsletters
//!   (`triage`); moving a sender overrides the headers for all their mail.

use rusqlite::{OptionalExtension, params};

use crate::store::{INBOX, SENT, Store};
use crate::{Category, Error, Result, ScreenerStatus, Sender, SenderDecision, now};

/// Version 8: senders, and each message's category.
pub(crate) const MIGRATE_V8: &str = r#"
ALTER TABLE messages ADD COLUMN category TEXT NOT NULL DEFAULT 'people';
CREATE TABLE senders (
  email       TEXT PRIMARY KEY,       -- lowercased
  decision    TEXT,                   -- allowed | screened_out | blocked
  category    TEXT,                   -- people | updates | newsletters
  updated_at  INTEGER NOT NULL
);
CREATE INDEX messages_from ON messages (lower(from_email));
"#;

/// The setting that turns the Screener on: when it was turned on.
const SCREENER_SINCE: &str = "screener_since";

/// SQL for a message row's sender decision (`m` is the row).
pub(crate) const DECISION: &str = "(SELECT s.decision FROM senders s WHERE s.email = lower(m.from_email))";

/// SQL for a message row's category: the sender's, or the headers'.
pub(crate) const CATEGORY: &str = "COALESCE((SELECT s.category FROM senders s WHERE s.email = lower(m.from_email)), m.category)";

/// SQL: the row's sender is in your contacts.
const CONTACT: &str = "EXISTS (SELECT 1 FROM contacts c, json_each(c.emails) e \
     WHERE c.state <> 'deleted' AND lower(json_extract(e.value, '$.value')) = lower(m.from_email))";

/// SQL: the row waits in the Screener (given when it was turned on).
pub(crate) fn screened(since: i64) -> String {
    format!("(m.mailbox <> '{SENT}' AND m.date >= {since} AND {DECISION} IS NULL AND NOT {CONTACT})")
}

impl Store {
    /// When the Screener was turned on, or `None` when it's off.
    pub fn screener_since(&self) -> Result<Option<i64>> {
        Ok(self.setting(SCREENER_SINCE)?.and_then(|v| v.parse().ok()))
    }

    pub fn screener_status(&self) -> Result<ScreenerStatus> {
        let since = self.screener_since()?;
        let waiting = match since {
            None => 0,
            Some(since) => {
                self.db.query_row(&format!("SELECT COUNT(DISTINCT lower(m.from_email)) FROM messages m WHERE m.archived = 0 AND {}", screened(since)), [], |r| r.get(0))?
            }
        };
        Ok(ScreenerStatus { enabled: since.is_some(), since, waiting })
    }

    /// Turn the Screener on or off. Turning it on remembers everyone you've
    /// written to, so only mail from new senders, from now on, waits.
    pub fn set_screener(&self, enabled: bool) -> Result<ScreenerStatus> {
        if !enabled {
            self.set_setting(SCREENER_SINCE, None)?;
        } else if self.screener_since()?.is_none() {
            let tx = self.db.unchecked_transaction()?;
            let sent: Vec<(String, String)> = {
                let mut stmt = tx.prepare(&format!("SELECT to_json, cc_json FROM messages WHERE mailbox = '{SENT}'"))?;
                stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?
            };
            for (to, cc) in sent {
                for a in crate::store::from_json::<Vec<crate::Address>>(to).into_iter().chain(crate::store::from_json::<Vec<crate::Address>>(cc)) {
                    remember_recipient(&tx, &a.email)?;
                }
            }
            tx.execute("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = ?2", params![SCREENER_SINCE, now().to_string()])?;
            tx.commit()?;
        }
        self.screener_status()
    }

    /// Decide about a sender. Screening out or blocking also archives the
    /// mail from them that's in the inbox now (blocking marks it read).
    pub fn decide_sender(&self, email: &str, decision: Option<SenderDecision>) -> Result<()> {
        let email = normalize(email)?;
        let tx = self.db.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO senders (email, decision, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT (email) DO UPDATE SET decision = excluded.decision, updated_at = excluded.updated_at",
            params![email, decision.map(SenderDecision::as_str), now()],
        )?;
        if matches!(decision, Some(SenderDecision::ScreenedOut | SenderDecision::Blocked)) {
            let ids: Vec<String> = {
                let mut stmt = tx.prepare(&format!("SELECT id FROM messages WHERE lower(from_email) = ?1 AND mailbox <> '{SENT}' AND archived = 0"))?;
                stmt.query_map([&email], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?
            };
            for id in ids {
                self.set_archived(&id, true)?;
                if decision == Some(SenderDecision::Blocked) {
                    self.set_seen(&id, true)?;
                }
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Move a sender's mail to a category, or back to what the headers say.
    pub fn set_sender_category(&self, email: &str, category: Option<Category>) -> Result<()> {
        let email = normalize(email)?;
        self.db.execute(
            "INSERT INTO senders (email, category, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT (email) DO UPDATE SET category = excluded.category, updated_at = excluded.updated_at",
            params![email, category.map(Category::as_str), now()],
        )?;
        Ok(())
    }

    /// Senders you've screened out, blocked, or moved, for reviewing those
    /// choices. Senders allowed only because you wrote to them aren't listed.
    pub fn senders(&self) -> Result<Vec<Sender>> {
        let mut stmt = self.db.prepare(&format!(
            "SELECT s.email, s.decision, s.category,
               (SELECT m.from_name FROM messages m WHERE lower(m.from_email) = s.email AND m.mailbox <> '{SENT}' ORDER BY m.date DESC LIMIT 1),
               (SELECT COUNT(*) FROM messages m WHERE lower(m.from_email) = s.email AND m.mailbox <> '{SENT}')
             FROM senders s WHERE s.decision IN ('screened_out', 'blocked') OR s.category IS NOT NULL
             ORDER BY s.updated_at DESC"
        ))?;
        let rows = stmt.query_map([], |r| {
            Ok(Sender {
                email: r.get(0)?,
                decision: r.get::<_, Option<String>>(1)?.as_deref().and_then(SenderDecision::parse),
                category: r.get::<_, Option<String>>(2)?.as_deref().and_then(Category::parse),
                name: r.get(3)?,
                messages: r.get(4)?,
            })
        })?;
        rows.collect::<rusqlite::Result<_>>().map_err(Into::into)
    }

    /// Server changes waiting to be sent, across all accounts.
    pub fn pending_op_count(&self) -> Result<i64> {
        Ok(self.db.query_row("SELECT COUNT(*) FROM pending_ops", [], |r| r.get(0))?)
    }

    /// Fill in the category of mail stored before categories existed.
    pub(crate) fn reclassify_all(&self) -> Result<()> {
        let rows: Vec<(String, String, Option<Vec<u8>>)> = {
            let mut stmt = self.db.prepare(&format!("SELECT id, from_email, raw FROM messages WHERE mailbox <> '{SENT}'"))?;
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<rusqlite::Result<_>>()?
        };
        let tx = self.db.unchecked_transaction()?;
        for (id, from, raw) in rows {
            let category = crate::triage::classify(raw.as_deref().unwrap_or_default(), &from);
            if category != Category::People {
                tx.execute("UPDATE messages SET category = ?2 WHERE id = ?1", params![id, category.as_str()])?;
            }
        }
        tx.commit()?;
        Ok(())
    }
}

/// You wrote to them: they're known. An earlier decision (say, blocked) stands.
pub(crate) fn remember_recipient(tx: &rusqlite::Connection, email: &str) -> Result<()> {
    let email = email.trim().to_lowercase();
    if email.contains('@') {
        tx.execute(
            "INSERT INTO senders (email, decision, updated_at) VALUES (?1, 'allowed', ?2)
             ON CONFLICT (email) DO UPDATE SET decision = 'allowed', updated_at = excluded.updated_at WHERE decision IS NULL",
            params![email, now()],
        )?;
    }
    Ok(())
}

/// What a newly stored message from this sender should get: archived (and
/// read) when you screened them out or blocked them.
pub(crate) fn arrival_rule(tx: &rusqlite::Connection, from_email: &str) -> Result<Option<SenderDecision>> {
    let d: Option<Option<String>> = tx.query_row("SELECT decision FROM senders WHERE email = lower(?1)", [from_email], |r| r.get(0)).optional()?;
    Ok(d.flatten().as_deref().and_then(SenderDecision::parse).filter(|d| *d != SenderDecision::Allowed))
}

fn normalize(email: &str) -> Result<String> {
    let e = email.trim().to_lowercase();
    if !e.contains('@') {
        return Err(Error::Invalid(format!("“{email}” isn't an email address")));
    }
    Ok(e)
}

/// Mailboxes whose arrivals the sender rules apply to.
pub(crate) fn rules_apply(mailbox: &str) -> bool {
    mailbox == INBOX
}

#[cfg(test)]
mod tests {
    use crate::store::{INBOX, SENT};
    use crate::{
        AccountConfig, Category, CollectionKind, ContactField, ContactInput, FetchedMessage, Lane, MessageQuery, Provider, Security, SenderDecision, ServerConfig, Store, SyncBatch,
    };

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
                smtp: ServerConfig { port: 25, ..server },
                jmap: None,
                dav: None,
                oauth: None,
            })
            .unwrap();
        (s, a.id)
    }

    /// Mail from `from`; `old` dates it before the Screener could be on.
    fn mail(from: &str, subject: &str, extra: &str, old: bool) -> Vec<u8> {
        let date = if old { "Date: Tue, 13 Oct 2026 09:00:00 +0000\r\n" } else { "" };
        format!("From: {from}\r\nTo: me@example.com\r\nSubject: {subject}\r\n{date}{extra}\r\nhello\r\n").into_bytes()
    }

    fn lane(s: &Store, lane: Lane) -> Vec<String> {
        s.messages(&MessageQuery { lane, account_id: None, search: None, limit: None, offset: None, category: None, split: None, bundle: false }).unwrap().into_iter().map(|m| m.subject).collect()
    }

    fn of(s: &Store, category: Category) -> Vec<String> {
        s.messages(&MessageQuery { lane: Lane::Inbox, account_id: None, search: None, limit: None, offset: None, category: Some(category), split: None, bundle: false })
            .unwrap()
            .into_iter()
            .map(|m| m.subject)
            .collect()
    }

    #[test]
    fn categories_from_headers_and_from_you() {
        let (s, acct) = store();
        s.insert_local(&acct, INBOX, &mail("Ana <ana@example.com>", "Lunch", "", true), false).unwrap();
        s.insert_local(&acct, INBOX, &mail("Clay Club <news@clay.example>", "Monthly", "List-Id: <club.clay.example>\r\n", true), false).unwrap();
        s.insert_local(&acct, INBOX, &mail("Bank <no-reply@bank.example>", "Your statement", "", true), false).unwrap();
        assert_eq!(of(&s, Category::People), ["Lunch"]);
        assert_eq!(of(&s, Category::Newsletters), ["Monthly"]);
        assert_eq!(of(&s, Category::Updates), ["Your statement"]);
        assert_eq!(lane(&s, Lane::Inbox).len(), 3, "the inbox still has everything");
        let rows = s.messages(&MessageQuery { lane: Lane::Inbox, account_id: None, search: None, limit: None, offset: None, category: None, split: None, bundle: false }).unwrap();
        assert_eq!(rows.iter().find(|m| m.subject == "Monthly").unwrap().category, Category::Newsletters);

        // Moving a sender wins over the headers, for all their mail.
        s.set_sender_category("NEWS@clay.example", Some(Category::People)).unwrap();
        let mut people = of(&s, Category::People);
        people.sort();
        assert_eq!(people, ["Lunch", "Monthly"]);
        s.set_sender_category("news@clay.example", None).unwrap();
        assert_eq!(of(&s, Category::Newsletters), ["Monthly"], "and moving back undoes it");
    }

    #[test]
    fn the_screener_holds_new_senders_until_you_decide() {
        let (s, acct) = store();
        s.insert_local(&acct, INBOX, &mail("Old Friend <old@example.com>", "From before", "", true), false).unwrap();
        s.insert_local(&acct, SENT, b"From: me@example.com\r\nTo: Jo <jo@joinery.example>\r\nSubject: Quote?\r\nDate: Tue, 13 Oct 2026 08:00:00 +0000\r\n\r\nx\r\n", true).unwrap();
        let status = s.set_screener(true).unwrap();
        assert!(status.enabled && status.waiting == 0);

        // A contact, someone you wrote to, and a stranger write in.
        s.ensure_local_collections().unwrap();
        let book = s.collections(CollectionKind::Contacts).unwrap()[0].id.clone();
        s.create_contact(&ContactInput {
            book_id: book,
            full_name: "Priya".into(),
            emails: vec![ContactField { label: None, value: "Priya@Studio.example".into() }],
            phones: vec![],
            org: None,
            title: None,
            note: None,
            birthday: None,
            labels: None,
        })
        .unwrap();
        s.insert_local(&acct, INBOX, &mail("Priya <priya@studio.example>", "From a contact", "", false), false).unwrap();
        s.insert_local(&acct, INBOX, &mail("Jo <jo@joinery.example>", "Re: Quote?", "", false), false).unwrap();
        s.insert_local(&acct, INBOX, &mail("Stranger <hi@growth.example>", "Quick question", "", false), false).unwrap();
        s.insert_local(&acct, INBOX, &mail("Stranger <hi@growth.example>", "Following up", "", false), false).unwrap();

        let inbox = lane(&s, Lane::Inbox);
        assert!(inbox.contains(&"From before".to_string()), "mail from before the Screener stays");
        assert!(inbox.contains(&"From a contact".to_string()) && inbox.contains(&"Re: Quote?".to_string()), "contacts and people you wrote to skip it");
        assert!(!inbox.iter().any(|t| t == "Quick question" || t == "Following up"), "a stranger waits");
        assert!(!lane(&s, Lane::Unread).iter().any(|t| t == "Quick question"), "and isn't unread mail either (no notification)");
        assert_eq!(lane(&s, Lane::Screener).len(), 2);
        assert_eq!(s.screener_status().unwrap().waiting, 1, "one sender waiting");

        s.decide_sender("hi@growth.example", Some(SenderDecision::Allowed)).unwrap();
        assert!(lane(&s, Lane::Screener).is_empty());
        assert!(lane(&s, Lane::Inbox).contains(&"Quick question".to_string()), "yes: into the inbox");

        // Off again: nothing is held.
        s.insert_local(&acct, INBOX, &mail("New <new@example.org>", "Hello", "", false), false).unwrap();
        assert!(!lane(&s, Lane::Inbox).contains(&"Hello".to_string()));
        assert!(!s.set_screener(false).unwrap().enabled);
        assert!(lane(&s, Lane::Inbox).contains(&"Hello".to_string()));
        assert!(lane(&s, Lane::Screener).is_empty());
    }

    #[test]
    fn screening_out_and_blocking_archive_now_and_on_arrival() {
        let (s, acct) = store();
        let batch = |uid: u32, raw: Vec<u8>| SyncBatch {
            mailbox: INBOX.into(),
            uid_validity: 1,
            new_messages: vec![FetchedMessage { uid, seen: false, flagged: false, raw }],
            server_uids: (1..=uid).collect(),
            ..Default::default()
        };
        s.apply_sync(&acct, &batch(1, mail("Deals <deals@shop.example>", "Sale", "", true))).unwrap();
        s.apply_sync(&acct, &batch(2, mail("Spam <x@spam.example>", "Win", "", true))).unwrap();
        s.decide_sender("deals@shop.example", Some(SenderDecision::ScreenedOut)).unwrap();
        s.decide_sender("x@spam.example", Some(SenderDecision::Blocked)).unwrap();
        assert!(lane(&s, Lane::Inbox).is_empty(), "both leave the inbox now");
        assert_eq!(lane(&s, Lane::Archive).len(), 2);

        s.apply_sync(&acct, &batch(3, mail("Deals <deals@shop.example>", "Another sale", "", false))).unwrap();
        s.apply_sync(&acct, &batch(4, mail("Spam <x@spam.example>", "Win again", "", false))).unwrap();
        assert!(lane(&s, Lane::Inbox).is_empty(), "and their new mail never reaches it");
        let unread = lane(&s, Lane::Unread);
        assert!(!unread.contains(&"Win again".to_string()));
        let ops: Vec<(i64, String)> = {
            let mut stmt = s.db.prepare("SELECT m.uid, o.kind FROM pending_ops o JOIN messages m ON m.id = o.message_id ORDER BY m.uid, o.kind").unwrap();
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().map(Result::unwrap).collect()
        };
        assert!(ops.contains(&(3, "archive".into())), "archived on the server too: {ops:?}");
        assert!(ops.contains(&(4, "archive".into())) && ops.contains(&(4, "seen".into())), "blocked mail is also marked read: {ops:?}");
        assert!(!ops.contains(&(3, "seen".into())), "screened-out mail stays unread");

        let listed = s.senders().unwrap();
        assert_eq!(listed.len(), 2);
        assert!(listed.iter().any(|x| x.email == "x@spam.example" && x.decision == Some(SenderDecision::Blocked) && x.messages == 2 && x.name.as_deref() == Some("Spam")));
        s.decide_sender("deals@shop.example", None).unwrap();
        assert_eq!(s.senders().unwrap().len(), 1, "undoing a decision removes it from the list");
        assert!(s.decide_sender("not-an-address", Some(SenderDecision::Blocked)).is_err());
    }

    #[test]
    fn mail_from_before_categories_is_sorted_on_upgrade() {
        let (s, acct) = store();
        let id = s.insert_local(&acct, INBOX, &mail("Clay <news@clay.example>", "Monthly", "List-Id: <club.clay.example>\r\n", true), false).unwrap();
        s.db.execute("UPDATE messages SET category = 'people' WHERE id = ?1", [&id]).unwrap();
        s.reclassify_all().unwrap();
        assert_eq!(of(&s, Category::Newsletters), ["Monthly"]);
    }
}
