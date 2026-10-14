//! Follow-up reminders, signatures, and templates in the local store.
//!
//! A follow-up belongs to a message you sent, keyed by its `Message-ID`
//! rather than by row: the local Sent copy is replaced when the server's copy
//! arrives, and the reminder has to survive that. A reply is any received
//! message whose `References` or `In-Reply-To` names it; storing one clears
//! the reminder (see `store::insert_message`). Until then the reminder waits
//! in the Waiting lane, and once due, the conversation comes back to the inbox.

use rusqlite::{OptionalExtension, params};

use crate::store::{SENT, Store};
use crate::{Error, Result, Signature, Template, TemplateInput, now};

/// Version 7: follow-up reminders, signatures, and templates.
pub(crate) const MIGRATE_V7: &str = r#"
CREATE TABLE follow_ups (
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  message_id  TEXT NOT NULL,          -- Message-ID of the sent message
  due_at      INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (account_id, message_id)
);
CREATE INDEX follow_ups_due ON follow_ups (due_at);

CREATE TABLE signatures (
  account_id  TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  html        TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE templates (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  subject     TEXT NOT NULL,
  html        TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
"#;

/// The SQL for one message row's follow-up time (`m` is the row). Only sent
/// mail carries one.
pub(crate) const FOLLOW_UP_AT: &str = "(SELECT f.due_at FROM follow_ups f \
     WHERE m.mailbox = 'Sent' AND f.account_id = m.account_id AND f.message_id = m.message_id)";

/// Reminders can be set up to a year out.
const MAX_FOLLOW_UP: i64 = 366 * 24 * 3600;

impl Store {
    // ── Follow-ups ───────────────────────────────────────────────────────

    /// Remind about a message just sent from this device, unless a reply
    /// comes first.
    pub fn add_follow_up(&self, account_id: &str, message_id: &str, due_at: i64) -> Result<()> {
        self.db.execute(
            "INSERT INTO follow_ups (account_id, message_id, due_at, created_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (account_id, message_id) DO UPDATE SET due_at = excluded.due_at",
            params![account_id, message_id, due_at, now()],
        )?;
        Ok(())
    }

    /// Remind about a conversation: the newest message you sent in it comes
    /// back at `due_at` if nobody has replied to it.
    pub fn set_follow_up(&self, thread_id: &str, due_at: i64) -> Result<()> {
        if due_at <= now() {
            return Err(Error::Invalid("pick a time in the future".into()));
        }
        if due_at > now() + MAX_FOLLOW_UP {
            return Err(Error::Invalid("reminders can be set up to a year ahead".into()));
        }
        let sent: Option<(String, String)> = self
            .db
            .query_row(
                &format!(
                    "SELECT account_id, message_id FROM messages
                     WHERE thread_id = ?1 AND mailbox = '{SENT}' AND message_id IS NOT NULL
                     ORDER BY date DESC LIMIT 1"
                ),
                [thread_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((account, mid)) = sent else {
            return Err(Error::Invalid("follow-up reminders are for conversations where you've sent a message".into()));
        };
        self.add_follow_up(&account, &mid, due_at)
    }

    /// Stop every reminder in a conversation, due or not.
    pub fn cancel_follow_up(&self, thread_id: &str) -> Result<usize> {
        self.clear_follow_ups(thread_id, None)
    }

    /// The reminders in a conversation that have come due: archiving it
    /// dismisses them. Returns how many there were.
    pub(crate) fn dismiss_due_follow_ups(&self, thread_id: &str) -> Result<usize> {
        self.clear_follow_ups(thread_id, Some(now()))
    }

    fn clear_follow_ups(&self, thread_id: &str, due_by: Option<i64>) -> Result<usize> {
        Ok(self.db.execute(
            &format!(
                "DELETE FROM follow_ups WHERE due_at <= ?2 AND (account_id, message_id) IN (
                   SELECT account_id, message_id FROM messages
                   WHERE thread_id = ?1 AND mailbox = '{SENT}' AND message_id IS NOT NULL)"
            ),
            params![thread_id, due_by.unwrap_or(i64::MAX)],
        )?)
    }

    /// Reminders that came due in `(after, until]`, with the subject of the
    /// message each is about, for a notification.
    pub fn follow_ups_due(&self, after: i64, until: i64) -> Result<Vec<(String, String)>> {
        let mut stmt = self.db.prepare(&format!(
            "SELECT m.thread_id, m.subject FROM follow_ups f
             JOIN messages m ON m.account_id = f.account_id AND m.message_id = f.message_id AND m.mailbox = '{SENT}'
             WHERE f.due_at > ?1 AND f.due_at <= ?2 GROUP BY f.account_id, f.message_id"
        ))?;
        let rows = stmt.query_map(params![after, until], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<rusqlite::Result<_>>().map_err(Into::into)
    }

    // ── Signatures ───────────────────────────────────────────────────────

    pub fn signatures(&self) -> Result<Vec<Signature>> {
        let mut stmt = self.db.prepare("SELECT account_id, html FROM signatures ORDER BY account_id")?;
        let rows = stmt.query_map([], |r| Ok(Signature { account_id: r.get(0)?, html: r.get(1)? }))?;
        rows.collect::<rusqlite::Result<_>>().map_err(Into::into)
    }

    /// Set an account's signature. An empty one removes it.
    pub fn set_signature(&self, account_id: &str, html: &str) -> Result<()> {
        self.account(account_id)?;
        if is_blank(html) {
            self.db.execute("DELETE FROM signatures WHERE account_id = ?1", [account_id])?;
        } else {
            self.db.execute(
                "INSERT INTO signatures (account_id, html, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT (account_id) DO UPDATE SET html = excluded.html, updated_at = excluded.updated_at",
                params![account_id, html, now()],
            )?;
        }
        Ok(())
    }

    // ── Templates ────────────────────────────────────────────────────────

    pub fn templates(&self) -> Result<Vec<Template>> {
        let mut stmt = self.db.prepare("SELECT id, name, subject, html, updated_at FROM templates ORDER BY name COLLATE NOCASE")?;
        let rows = stmt.query_map([], |r| Ok(Template { id: r.get(0)?, name: r.get(1)?, subject: r.get(2)?, html: r.get(3)?, updated: r.get(4)? }))?;
        rows.collect::<rusqlite::Result<_>>().map_err(Into::into)
    }

    pub fn save_template(&self, input: &TemplateInput) -> Result<Template> {
        let name = input.name.trim();
        if name.is_empty() {
            return Err(Error::Invalid("give the template a name".into()));
        }
        if is_blank(&input.html) {
            return Err(Error::Invalid("the template is empty".into()));
        }
        let id = match &input.id {
            Some(id) => {
                let n = self.db.execute(
                    "UPDATE templates SET name = ?2, subject = ?3, html = ?4, updated_at = ?5 WHERE id = ?1",
                    params![id, name, input.subject.trim(), input.html, now()],
                )?;
                if n == 0 {
                    return Err(Error::NotFound("that template was deleted".into()));
                }
                id.clone()
            }
            None => {
                let id = uuid::Uuid::new_v4().to_string();
                self.db.execute(
                    "INSERT INTO templates (id, name, subject, html, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![id, name, input.subject.trim(), input.html, now()],
                )?;
                id
            }
        };
        self.templates()?.into_iter().find(|t| t.id == id).ok_or_else(|| Error::NotFound("that template was deleted".into()))
    }

    pub fn delete_template(&self, id: &str) -> Result<()> {
        self.db.execute("DELETE FROM templates WHERE id = ?1", [id])?;
        Ok(())
    }
}

/// HTML with no text in it: what an emptied editor leaves (`<p></p>`).
fn is_blank(html: &str) -> bool {
    let mut in_tag = false;
    let mut text = String::new();
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag => text.push(c),
            _ => {}
        }
    }
    text.replace("&nbsp;", " ").trim().is_empty() && !html.contains("<img")
}

#[cfg(test)]
mod tests {
    use super::is_blank;
    use crate::store::{INBOX, SENT};
    use crate::{AccountConfig, Address, Draft, FetchedMessage, Lane, MessageQuery, Provider, Security, ServerConfig, Store, SyncBatch, TemplateInput, now};

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

    fn mine(subject: &str) -> Vec<u8> {
        format!("From: Me <me@example.com>\r\nTo: ana@example.com\r\nSubject: {subject}\r\nMessage-ID: <mine@x>\r\nDate: Tue, 13 Oct 2026 09:00:00 +0000\r\n\r\nAny news?\r\n")
            .into_bytes()
    }

    fn lane(s: &Store, lane: Lane) -> Vec<crate::MessageSummary> {
        s.messages(&MessageQuery { lane, account_id: None, search: None, limit: None, offset: None, category: None, split: None, bundle: false }).unwrap()
    }

    fn make_due(s: &Store) {
        s.db.execute("UPDATE follow_ups SET due_at = ?1", [now() - 5]).unwrap();
    }

    #[test]
    fn a_follow_up_waits_then_comes_back_and_archiving_dismisses_it() {
        let (s, acct) = store();
        s.insert_local(&acct, SENT, &mine("Quote for the cabin"), true).unwrap();
        s.add_follow_up(&acct, "mine@x", now() + 3600).unwrap();
        let waiting = lane(&s, Lane::Waiting);
        assert_eq!(waiting.len(), 1);
        assert!(waiting[0].follow_up_at.is_some());
        assert_eq!(waiting[0].sent_to.as_deref(), Some("ana@example.com"), "rows say who it went to");
        assert!(lane(&s, Lane::Inbox).is_empty(), "not due yet");

        make_due(&s);
        let inbox = lane(&s, Lane::Inbox);
        assert_eq!(inbox.len(), 1, "due: the conversation is back in the inbox");
        assert_eq!(inbox[0].subject, "Quote for the cabin");
        assert!(inbox[0].follow_up_at.unwrap() <= now());
        assert!(lane(&s, Lane::Waiting).is_empty());

        s.set_thread_archived(&inbox[0].thread_id, true).unwrap();
        assert!(lane(&s, Lane::Inbox).is_empty(), "archiving dismisses the reminder");
        let left: i64 = s.db.query_row("SELECT COUNT(*) FROM follow_ups", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 0);
    }

    #[test]
    fn a_reply_ends_the_wait() {
        let (s, acct) = store();
        s.insert_local(&acct, SENT, &mine("Quote"), true).unwrap();
        s.add_follow_up(&acct, "mine@x", now() + 3600).unwrap();
        let reply =
            b"From: Ana <ana@example.com>\r\nSubject: Re: Quote\r\nMessage-ID: <r1@x>\r\nIn-Reply-To: <mine@x>\r\nDate: Tue, 13 Oct 2026 10:00:00 +0000\r\n\r\nHere it is\r\n";
        s.insert_local(&acct, INBOX, reply, false).unwrap();
        assert!(lane(&s, Lane::Waiting).is_empty());
        let inbox = lane(&s, Lane::Inbox);
        assert_eq!(inbox.len(), 1);
        assert_eq!(inbox[0].follow_up_at, None);
    }

    #[test]
    fn the_reminder_outlives_the_local_sent_copy() {
        let (s, acct) = store();
        s.insert_local(&acct, SENT, &mine("Quote"), true).unwrap();
        s.add_follow_up(&acct, "mine@x", now() + 3600).unwrap();
        // The server's Sent copy arrives and replaces the local one.
        let batch = SyncBatch {
            mailbox: SENT.into(),
            uid_validity: 1,
            new_messages: vec![FetchedMessage { uid: 7, seen: true, flagged: false, raw: mine("Quote") }],
            server_uids: vec![7],
            ..Default::default()
        };
        s.apply_sync(&acct, &batch).unwrap();
        let rows: i64 = s.db.query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 1, "one copy");
        assert_eq!(lane(&s, Lane::Waiting).len(), 1, "still waiting");
    }

    #[test]
    fn reminders_on_a_conversation() {
        let (s, acct) = store();
        let received = s
            .insert_local(&acct, INBOX, b"From: Ana <ana@example.com>\r\nSubject: Hello\r\nMessage-ID: <a@x>\r\nDate: Tue, 13 Oct 2026 08:00:00 +0000\r\n\r\nHi\r\n", false)
            .unwrap();
        let thread = s.message(&received).unwrap().summary.thread_id;
        assert!(s.set_follow_up(&thread, now() + 3600).unwrap_err().to_string().contains("you've sent"));
        let reply = b"From: Me <me@example.com>\r\nTo: ana@example.com\r\nSubject: Re: Hello\r\nMessage-ID: <mine@x>\r\nIn-Reply-To: <a@x>\r\nDate: Tue, 13 Oct 2026 09:00:00 +0000\r\n\r\nHi back\r\n";
        s.insert_local(&acct, SENT, reply, true).unwrap();
        assert!(s.set_follow_up(&thread, now() - 1).is_err(), "the past");
        assert!(s.set_follow_up(&thread, now() + 400 * 86400).is_err(), "too far");
        s.set_follow_up(&thread, now() + 3600).unwrap();

        // Archiving while still waiting keeps the reminder: reply, archive, get nudged later.
        s.set_thread_archived(&thread, true).unwrap();
        assert_eq!(lane(&s, Lane::Waiting).len(), 1);
        let due = s.follow_ups_due(now(), now() + 7200).unwrap();
        assert_eq!(due, vec![(thread.clone(), "Re: Hello".to_string())]);
        assert!(s.follow_ups_due(now() + 7200, now() + 9000).unwrap().is_empty());

        make_due(&s);
        assert_eq!(lane(&s, Lane::Inbox).len(), 1, "back, though the received mail is archived");
        assert_eq!(s.cancel_follow_up(&thread).unwrap(), 1);
        assert!(lane(&s, Lane::Inbox).is_empty());
    }

    #[test]
    fn scheduled_sends_wait_for_their_time() {
        let (s, acct) = store();
        let mut d = Draft {
            account_id: acct,
            to: vec![Address { name: None, email: "ana@example.com".into() }],
            cc: vec![],
            subject: "Later".into(),
            body: "x".into(),
            body_html: None,
            in_reply_to: None,
            references: vec![],
            attachments: vec![],
            calendar: None,
            follow_up_after: None,
        };
        let at = now() + 3600;
        let item = s.queue_send(&d, 10, Some(at)).unwrap();
        assert!(item.scheduled);
        assert_eq!(item.send_at, at);
        assert!(s.claim_due(now() + 120).unwrap().is_empty());
        assert_eq!(s.claim_due(at).unwrap().len(), 1);
        assert!(!s.queue_send(&d, 10, None).unwrap().scheduled, "undo window only");
        assert!(s.queue_send(&d, 10, Some(now() + 30)).is_err(), "too soon to schedule");
        assert!(s.queue_send(&d, 10, Some(now() + 400 * 86400)).is_err(), "too far");
        d.follow_up_after = Some(5);
        assert!(s.queue_send(&d, 10, None).is_err(), "a follow-up a few seconds out");
        d.follow_up_after = Some(3 * 86400);
        assert!(s.queue_send(&d, 10, None).is_ok());
    }

    #[test]
    fn templates_and_signatures() {
        let (s, acct) = store();
        assert!(s.save_template(&TemplateInput { id: None, name: " ".into(), subject: "".into(), html: "<p>x</p>".into() }).is_err());
        assert!(s.save_template(&TemplateInput { id: None, name: "Intro".into(), subject: "".into(), html: "<p></p>".into() }).is_err());
        let t = s.save_template(&TemplateInput { id: None, name: "Intro".into(), subject: "Hello".into(), html: "<p>Nice to meet you</p>".into() }).unwrap();
        s.save_template(&TemplateInput { id: None, name: "agenda".into(), subject: "".into(), html: "<p>1.</p>".into() }).unwrap();
        assert_eq!(s.templates().unwrap().iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), ["agenda", "Intro"], "sorted by name");
        let edited = s.save_template(&TemplateInput { id: Some(t.id.clone()), name: "Intro".into(), subject: "Hi".into(), html: "<p>Hi!</p>".into() }).unwrap();
        assert_eq!(edited.subject, "Hi");
        s.delete_template(&t.id).unwrap();
        assert!(s.save_template(&TemplateInput { id: Some(t.id), name: "x".into(), subject: "".into(), html: "<p>x</p>".into() }).is_err(), "deleted");

        s.set_signature(&acct, "<p>— Me</p>").unwrap();
        assert_eq!(s.signatures().unwrap()[0].html, "<p>— Me</p>");
        s.set_signature(&acct, "<p></p>").unwrap();
        assert!(s.signatures().unwrap().is_empty(), "emptying removes it");
        assert!(s.set_signature("nope", "<p>x</p>").is_err());
    }

    #[test]
    fn message_detail_offers_unsubscribe() {
        let (s, acct) = store();
        let raw = b"From: News <news@list.example>\r\nSubject: Weekly\r\nList-Unsubscribe: <https://list.example/u/1>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\nDate: Tue, 13 Oct 2026 08:00:00 +0000\r\n\r\nNews\r\n";
        let id = s.insert_local(&acct, INBOX, raw, false).unwrap();
        assert_eq!(s.message(&id).unwrap().unsubscribe.unwrap().one_click.as_deref(), Some("https://list.example/u/1"));
        let sent = s.insert_local(&acct, SENT, &mine("x"), true).unwrap();
        assert_eq!(s.message(&sent).unwrap().unsubscribe, None);
    }

    #[test]
    fn blank_html() {
        assert!(is_blank("<p></p>"));
        assert!(is_blank("  <p>&nbsp;</p> "));
        assert!(!is_blank("<p>— Sean</p>"));
        assert!(!is_blank(r#"<p><img src="data:image/png;base64,AAA"></p>"#));
    }
}
