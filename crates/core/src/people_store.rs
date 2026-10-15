//! Contacts that look after themselves (ADR-0023): smart groups that keep
//! their own membership, and undoing every contact change since a point in
//! time, whether it came from an edit here or from a sync.

use std::collections::{HashMap, HashSet};

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::pim_store::{CHANGED, child_href};
use crate::store::{SENT, Store, from_json, json};
use crate::{Address, ContactSummary, Error, Result, now, vcard};

/// Schema v11 (contacts half): a history of every contact change. Triggers
/// record it, so edits, merges, deletes, and sync all land here without each
/// write path having to remember. `before`/`after` are the card as it was and
/// became; NULL means it didn't exist (or was waiting to be deleted).
pub(crate) const MIGRATE_V11: &str = r#"
CREATE TABLE contacts_history (
  id            INTEGER PRIMARY KEY,
  collection_id TEXT NOT NULL,
  uid           TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  before        TEXT,
  after         TEXT,
  at            INTEGER NOT NULL
);
CREATE INDEX contacts_history_at ON contacts_history (at);
CREATE TRIGGER contacts_history_insert AFTER INSERT ON contacts WHEN new.state <> 'deleted'
BEGIN
  INSERT INTO contacts_history (collection_id, uid, full_name, before, after, at)
  VALUES (new.collection_id, new.uid, new.full_name, NULL, new.vcf, CAST(strftime('%s', 'now') AS INTEGER));
END;
CREATE TRIGGER contacts_history_update AFTER UPDATE OF vcf, state ON contacts
WHEN (CASE old.state WHEN 'deleted' THEN NULL ELSE old.vcf END) IS NOT (CASE new.state WHEN 'deleted' THEN NULL ELSE new.vcf END)
BEGIN
  INSERT INTO contacts_history (collection_id, uid, full_name, before, after, at)
  VALUES (new.collection_id, new.uid, new.full_name,
          CASE old.state WHEN 'deleted' THEN NULL ELSE old.vcf END,
          CASE new.state WHEN 'deleted' THEN NULL ELSE new.vcf END,
          CAST(strftime('%s', 'now') AS INTEGER));
END;
CREATE TRIGGER contacts_history_delete AFTER DELETE ON contacts WHEN old.state <> 'deleted'
BEGIN
  INSERT INTO contacts_history (collection_id, uid, full_name, before, after, at)
  VALUES (old.collection_id, old.uid, old.full_name, old.vcf, NULL, CAST(strftime('%s', 'now') AS INTEGER));
END;
"#;

/// How far back contacts can be restored.
const KEEP_HISTORY: i64 = 30 * 24 * 3600;

const GROUPS_KEY: &str = "smart_groups";

/// What a smart group matches. Every filled-in rule must hold.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SmartGroupInput {
    pub name: String,
    /// Has any of these labels.
    pub labels: Vec<String>,
    /// Company contains these words (any case).
    pub company: Option<String>,
    /// An email at this domain or its subdomains ("studio.example").
    pub domain: Option<String>,
    pub has_phone: bool,
    pub has_birthday: bool,
    /// You've exchanged mail in the last this-many days.
    pub in_touch_days: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartGroup {
    pub id: String,
    #[serde(flatten)]
    pub rule: SmartGroupInput,
    /// Members right now (filled in when listed).
    #[serde(default)]
    pub count: u32,
}

/// What restoring to a point in time would do, by name.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactsRestore {
    /// Added since: they'd be removed (to Recently deleted).
    pub added: Vec<String>,
    /// Edited since: they'd go back to how they were.
    pub edited: Vec<String>,
    /// Deleted since: they'd come back.
    pub deleted: Vec<String>,
    /// Changes in address books you can't edit, left as they are.
    pub read_only: u32,
}

/// The result of a restore, with what Undo needs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactsRestored {
    pub changed: u32,
    /// Restoring with `after: mark` undoes this restore.
    pub mark: i64,
}

/// Which changes a restore reverses: those since a time, or after a mark.
#[derive(Debug, Clone, Copy)]
pub enum RestorePoint {
    Since(i64),
    After(i64),
}

enum Step {
    Remove { id: String },
    Bring { collection_id: String, uid: String, pending: Option<String>, vcf: String },
    Revert { id: String, collection_id: String, vcf: String },
}

impl Store {
    // ── Smart groups ────────────────────────────────────────────────────

    fn group_rules(&self) -> Result<Vec<SmartGroup>> {
        Ok(self.setting(GROUPS_KEY)?.map(from_json::<Vec<SmartGroup>>).unwrap_or_default())
    }

    /// Smart groups in your order, each with how many people are in it.
    pub fn smart_groups(&self) -> Result<Vec<SmartGroup>> {
        let all = self.contacts(None)?;
        let mut groups = self.group_rules()?;
        for g in &mut groups {
            g.count = self.group_filter(&g.rule)?.apply(&all).count() as u32;
        }
        Ok(groups)
    }

    /// Adds (`id` None) or replaces a smart group.
    pub fn save_smart_group(&self, id: Option<&str>, input: &SmartGroupInput) -> Result<SmartGroup> {
        let rule = check_group(input)?;
        let mut groups = self.group_rules()?;
        let group = SmartGroup { id: id.map(String::from).unwrap_or_else(|| uuid::Uuid::new_v4().to_string()), rule, count: 0 };
        match groups.iter_mut().find(|g| g.id == group.id) {
            Some(g) => *g = group.clone(),
            None if id.is_some() => return Err(Error::NotFound("that smart group was deleted".into())),
            None => groups.push(group.clone()),
        }
        self.set_setting(GROUPS_KEY, Some(&json(&groups)))?;
        Ok(SmartGroup { count: self.group_filter(&group.rule)?.apply(&self.contacts(None)?).count() as u32, ..group })
    }

    pub fn delete_smart_group(&self, id: &str) -> Result<()> {
        let mut groups = self.group_rules()?;
        groups.retain(|g| g.id != id);
        self.set_setting(GROUPS_KEY, Some(&json(&groups)))
    }

    /// The contacts list, narrowed to a label and/or a smart group.
    pub fn contacts_in(&self, search: Option<&str>, label: Option<&str>, group: Option<&str>) -> Result<Vec<ContactSummary>> {
        let list = self.contacts_labeled(search, label)?;
        let Some(group) = group else { return Ok(list) };
        let rule = self.group_rules()?.into_iter().find(|g| g.id == group).ok_or_else(|| Error::NotFound("that smart group was deleted".into()))?.rule;
        Ok(self.group_filter(&rule)?.apply(&list).cloned().collect())
    }

    /// Everything a rule needs beyond the summary, looked up once per list.
    fn group_filter(&self, rule: &SmartGroupInput) -> Result<GroupFilter> {
        let birthdays: HashSet<String> = if rule.has_birthday {
            let mut st = self.db.prepare("SELECT id FROM contacts WHERE birthday IS NOT NULL AND birthday <> ''")?;
            st.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?
        } else {
            HashSet::new()
        };
        let in_touch = match rule.in_touch_days {
            Some(days) => Some(self.addresses_since(now() - i64::from(days) * 86400)?),
            None => None,
        };
        Ok(GroupFilter { rule: rule.clone(), birthdays, in_touch })
    }

    /// Everyone who wrote to you, or you wrote to, since `since`.
    fn addresses_since(&self, since: i64) -> Result<HashSet<String>> {
        let mut out = HashSet::new();
        let mut st = self.db.prepare(&format!("SELECT from_email FROM messages WHERE date >= ?1 AND mailbox <> '{SENT}'"))?;
        for e in st.query_map([since], |r| r.get::<_, String>(0))? {
            out.insert(e?.trim().to_lowercase());
        }
        let mut st = self.db.prepare(&format!("SELECT to_json, cc_json FROM messages WHERE date >= ?1 AND mailbox = '{SENT}'"))?;
        for row in st.query_map([since], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
            let (to, cc) = row?;
            for a in from_json::<Vec<Address>>(to).into_iter().chain(from_json::<Vec<Address>>(cc)) {
                out.insert(a.email.trim().to_lowercase());
            }
        }
        Ok(out)
    }

    // ── Restore to a point in time ──────────────────────────────────────

    /// What `restore_contacts` would do, without doing it.
    pub fn contacts_restore_preview(&self, point: RestorePoint) -> Result<ContactsRestore> {
        let (steps, read_only) = self.restore_plan(point)?;
        let mut out = ContactsRestore { read_only, ..Default::default() };
        for (name, step) in steps {
            match step {
                Step::Remove { .. } => out.added.push(name),
                Step::Revert { .. } => out.edited.push(name),
                Step::Bring { .. } => out.deleted.push(name),
            }
        }
        for v in [&mut out.added, &mut out.edited, &mut out.deleted] {
            v.sort_by_key(|n| n.to_lowercase());
        }
        Ok(out)
    }

    /// Puts every contact back the way it was at `point`: edits reverted,
    /// deleted people back, people added since removed (to Recently
    /// deleted). Address books you can't edit are left alone. The restore is
    /// itself recorded, so `mark` undoes it.
    pub fn restore_contacts(&self, point: RestorePoint) -> Result<ContactsRestored> {
        let (steps, _) = self.restore_plan(point)?;
        let tx = self.db.unchecked_transaction()?;
        let mark: i64 = self.db.query_row("SELECT COALESCE(MAX(id), 0) FROM contacts_history", [], |r| r.get(0))?;
        let changed = steps.len() as u32;
        for (_, step) in steps {
            match step {
                Step::Remove { id } => {
                    let book: String = self.db.query_row("SELECT collection_id FROM contacts WHERE id = ?1", [&id], |r| r.get(0))?;
                    let c = self.writable(&book)?;
                    self.trash_contact(&id)?;
                    self.remove_item(crate::CollectionKind::Contacts, &id, &c)?;
                }
                Step::Revert { id, collection_id, vcf } => {
                    let c = self.writable(&collection_id)?;
                    self.rewrite_contact(&id, &vcf, Self::edit_state(&c))?;
                }
                Step::Bring { collection_id, uid, pending, vcf } => {
                    match pending {
                        // Still waiting to be deleted on the server: call it off.
                        Some(id) => self.rewrite_contact(&id, &vcf, CHANGED)?,
                        None => {
                            let c = self.writable(&collection_id)?;
                            let href = child_href(self.collection_href(&c.id)?.as_deref(), &uid, "vcf");
                            self.insert_contact(&c.id, href.as_deref(), None, &vcf, Self::edit_state(&c))?;
                        }
                    }
                    self.db.execute("DELETE FROM contacts_trash WHERE collection_id = ?1 AND uid = ?2", params![collection_id, uid])?;
                }
            }
        }
        tx.commit()?;
        Ok(ContactsRestored { changed, mark })
    }

    fn restore_plan(&self, point: RestorePoint) -> Result<(Vec<(String, Step)>, u32)> {
        self.db.execute("DELETE FROM contacts_history WHERE at < ?1", [now() - KEEP_HISTORY])?;
        let (cond, arg) = match point {
            RestorePoint::Since(t) => ("at >= ?1", t),
            RestorePoint::After(m) => ("id > ?1", m),
        };
        // The oldest change after the point holds each card's state then.
        let mut target: HashMap<(String, String), Option<String>> = HashMap::new();
        let mut order = Vec::new();
        let mut st = self.db.prepare(&format!("SELECT collection_id, uid, before FROM contacts_history WHERE {cond} ORDER BY id"))?;
        for row in st.query_map([arg], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?)))? {
            let (c, uid, before) = row?;
            if let std::collections::hash_map::Entry::Vacant(e) = target.entry((c, uid)) {
                order.push(e.key().clone());
                e.insert(before);
            }
        }
        let mut steps = Vec::new();
        let mut read_only = 0;
        for key in order {
            let then = target.remove(&key).flatten();
            let (collection_id, uid) = key;
            let row: Option<(String, String, String, String)> = self
                .db
                .query_row("SELECT id, vcf, state, full_name FROM contacts WHERE collection_id = ?1 AND uid = ?2", params![collection_id, uid], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
                })
                .optional()?;
            let now_vcf = row.as_ref().filter(|r| r.2 != "deleted").map(|r| r.1.clone());
            if then == now_vcf {
                continue;
            }
            if self.writable(&collection_id).is_err() {
                read_only += 1;
                continue;
            }
            let name_of = |vcf: &str| vcard::read_contact(vcf).map(|m| m.full_name).unwrap_or_else(|_| "(unreadable contact)".into());
            let step = match (then, row) {
                (None, Some((id, _, _, name))) => (name, Step::Remove { id }),
                (Some(vcf), Some((id, _, state, _))) if state == "deleted" => (name_of(&vcf), Step::Bring { collection_id, uid, pending: Some(id), vcf }),
                (Some(vcf), Some((id, ..))) => (name_of(&vcf), Step::Revert { id, collection_id, vcf }),
                (Some(vcf), None) => (name_of(&vcf), Step::Bring { collection_id, uid, pending: None, vcf }),
                (None, None) => continue,
            };
            steps.push(step);
        }
        Ok((steps, read_only))
    }
}

struct GroupFilter {
    rule: SmartGroupInput,
    birthdays: HashSet<String>,
    in_touch: Option<HashSet<String>>,
}

impl GroupFilter {
    fn matches(&self, c: &ContactSummary) -> bool {
        let r = &self.rule;
        let emails: Vec<String> = c.emails.iter().map(|e| e.value.trim().to_lowercase()).collect();
        (r.labels.is_empty() || c.labels.iter().any(|l| r.labels.iter().any(|w| w.eq_ignore_ascii_case(l))))
            && r.company.as_ref().is_none_or(|w| c.org.as_ref().is_some_and(|o| o.to_lowercase().contains(&w.to_lowercase())))
            && r.domain.as_ref().is_none_or(|d| emails.iter().any(|e| e.rsplit_once('@').is_some_and(|(_, h)| h == d || h.ends_with(&format!(".{d}")))))
            && (!r.has_phone || !c.phones.is_empty())
            && (!r.has_birthday || self.birthdays.contains(&c.id))
            && self.in_touch.as_ref().is_none_or(|seen| emails.iter().any(|e| seen.contains(e)))
    }

    fn apply<'a>(&'a self, list: &'a [ContactSummary]) -> impl Iterator<Item = &'a ContactSummary> + 'a {
        list.iter().filter(|c| self.matches(c))
    }
}

fn check_group(input: &SmartGroupInput) -> Result<SmartGroupInput> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err(Error::Invalid("give the group a name".into()));
    }
    let labels: Vec<String> = input.labels.iter().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect();
    let company = input.company.as_deref().map(str::trim).filter(|c| !c.is_empty()).map(String::from);
    let domain = match input.domain.as_deref().map(|d| d.trim().trim_start_matches('@').to_lowercase()).filter(|d| !d.is_empty()) {
        Some(d) if !d.contains('.') || d.contains('@') || d.contains(char::is_whitespace) => {
            return Err(Error::Invalid(format!("“{d}” isn't a domain like example.com")));
        }
        d => d,
    };
    let in_touch_days = input.in_touch_days.filter(|d| *d > 0);
    if labels.is_empty() && company.is_none() && domain.is_none() && !input.has_phone && !input.has_birthday && in_touch_days.is_none() {
        return Err(Error::Invalid("say who belongs in it: a label, a company, a domain, or one of the checks".into()));
    }
    Ok(SmartGroupInput { name, labels, company, domain, has_phone: input.has_phone, has_birthday: input.has_birthday, in_touch_days })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ContactField, ContactInput};

    fn store() -> (Store, String) {
        let s = Store::open_in_memory().unwrap();
        s.ensure_local_collections().unwrap();
        let book = s.collections(crate::CollectionKind::Contacts).unwrap().into_iter().find(|c| c.writable && c.id != "birthdays").unwrap().id;
        (s, book)
    }

    fn person(book: &str, name: &str, email: &str, org: Option<&str>, labels: &[&str]) -> ContactInput {
        ContactInput { photo: None,
            book_id: book.into(),
            full_name: name.into(),
            emails: vec![ContactField { label: None, value: email.into() }],
            phones: vec![],
            org: org.map(String::from),
            title: None,
            note: None,
            birthday: None,
            labels: Some(labels.iter().map(|l| l.to_string()).collect()),
        }
    }

    fn names(list: &[ContactSummary]) -> Vec<String> {
        let mut v: Vec<String> = list.iter().map(|c| c.full_name.clone()).collect();
        v.sort();
        v
    }

    /// Moves every recorded change back in time, so tests can say "an hour ago".
    fn age(s: &Store, secs: i64) {
        s.db.execute("UPDATE contacts_history SET at = at - ?1", [secs]).unwrap();
    }

    #[test]
    fn smart_groups_keep_their_own_membership() {
        let (s, book) = store();
        s.create_contact(&person(&book, "Priya Raman", "priya@studio.example", Some("Studio"), &["Work"])).unwrap();
        s.create_contact(&person(&book, "Sam Okafor", "sam@build.studio.example", None, &[])).unwrap();
        let mut ana = person(&book, "Ana Duarte", "ana@example.com", Some("Lighthouse Studio"), &["Friends"]);
        ana.birthday = Some("--04-12".into());
        ana.phones = vec![ContactField { label: None, value: "+351 913 555 010".into() }];
        s.create_contact(&ana).unwrap();

        let team = s.save_smart_group(None, &SmartGroupInput { name: "Studio team".into(), domain: Some("@Studio.Example".into()), ..Default::default() }).unwrap();
        assert_eq!(team.rule.domain.as_deref(), Some("studio.example"), "normalized");
        assert_eq!(team.count, 2, "a domain takes its subdomains");
        assert_eq!(names(&s.contacts_in(None, None, Some(&team.id)).unwrap()), ["Priya Raman", "Sam Okafor"]);

        let studio = s.save_smart_group(None, &SmartGroupInput { name: "Studios".into(), company: Some("studio".into()), ..Default::default() }).unwrap();
        assert_eq!(names(&s.contacts_in(None, None, Some(&studio.id)).unwrap()), ["Ana Duarte", "Priya Raman"], "company words, any case");
        let cards = s.save_smart_group(None, &SmartGroupInput { name: "Cards".into(), has_birthday: true, has_phone: true, ..Default::default() }).unwrap();
        assert_eq!(cards.count, 1, "every rule must hold");
        let mixed = s.save_smart_group(None, &SmartGroupInput { name: "Mine".into(), labels: vec!["work".into(), "Friends".into()], ..Default::default() }).unwrap();
        assert_eq!(mixed.count, 2, "any of the labels");

        // Membership follows the cards: a new teammate joins by themselves.
        s.create_contact(&person(&book, "Rui Costa", "rui@studio.example", None, &[])).unwrap();
        assert_eq!(s.smart_groups().unwrap().iter().find(|g| g.id == team.id).unwrap().count, 3);
        // And search narrows inside a group.
        assert_eq!(names(&s.contacts_in(Some("rui"), None, Some(&team.id)).unwrap()), ["Rui Costa"]);

        s.delete_smart_group(&team.id).unwrap();
        assert_eq!(s.smart_groups().unwrap().len(), 3);
        assert!(s.contacts_in(None, None, Some(&team.id)).is_err());
    }

    #[test]
    fn smart_groups_need_a_name_and_a_rule() {
        let (s, _) = store();
        assert!(s.save_smart_group(None, &SmartGroupInput { name: " ".into(), has_phone: true, ..Default::default() }).is_err());
        assert!(s.save_smart_group(None, &SmartGroupInput { name: "Empty".into(), labels: vec![" ".into()], ..Default::default() }).is_err());
        assert!(s.save_smart_group(None, &SmartGroupInput { name: "Typo".into(), domain: Some("studio".into()), ..Default::default() }).is_err());
        assert!(s.save_smart_group(Some("gone"), &SmartGroupInput { name: "Gone".into(), has_phone: true, ..Default::default() }).is_err());
    }

    #[test]
    fn in_touch_counts_mail_both_ways() {
        let (s, book) = store();
        let acct = s
            .add_account(&crate::AccountConfig {
                display_name: "Me".into(),
                address: "me@example.com".into(),
                username: "me".into(),
                provider: crate::Provider::Generic,
                imap: crate::ServerConfig { host: "localhost".into(), port: 143, security: crate::Security::Plain },
                smtp: crate::ServerConfig { host: "localhost".into(), port: 25, security: crate::Security::Plain },
                jmap: None,
                dav: None,
                oauth: None,
            })
            .unwrap()
            .id;
        s.create_contact(&person(&book, "Priya Raman", "priya@studio.example", None, &[])).unwrap();
        s.create_contact(&person(&book, "Marcus Lee", "marcus@example.com", None, &[])).unwrap();
        s.create_contact(&person(&book, "Old Friend", "old@example.com", None, &[])).unwrap();
        s.insert_local(&acct, crate::store::INBOX, b"From: Priya <priya@studio.example>\r\nTo: me@example.com\r\nSubject: Hi\r\n\r\nHi\r\n", false).unwrap();
        s.insert_local(&acct, SENT, b"From: Me <me@example.com>\r\nTo: Marcus <MARCUS@example.com>\r\nSubject: Cabin\r\n\r\nIn?\r\n", true).unwrap();
        s.insert_local(
            &acct,
            crate::store::INBOX,
            b"From: Old <old@example.com>\r\nTo: me@example.com\r\nSubject: Long ago\r\nDate: Mon, 1 Jan 2024 09:00:00 +0000\r\n\r\nHi\r\n",
            false,
        )
        .unwrap();
        let g = s.save_smart_group(None, &SmartGroupInput { name: "Lately".into(), in_touch_days: Some(30), ..Default::default() }).unwrap();
        assert_eq!(names(&s.contacts_in(None, None, Some(&g.id)).unwrap()), ["Marcus Lee", "Priya Raman"]);
    }

    #[test]
    fn restore_undoes_edits_adds_and_deletes_since_a_point() {
        let (s, book) = store();
        let priya = s.create_contact(&person(&book, "Priya Raman", "priya@studio.example", Some("Studio"), &[])).unwrap();
        let sam = s.create_contact(&person(&book, "Sam Okafor", "sam@example.com", None, &[])).unwrap();
        age(&s, 7200);
        let before = s.contacts(None).unwrap();

        // An hour of accidents: an edit, a delete, a new card.
        s.update_contact(&priya.summary.id, &person(&book, "Priya R.", "priya@studio.example", Some("Studio"), &[])).unwrap();
        s.delete_contact(&sam.summary.id).unwrap();
        s.create_contact(&person(&book, "Spam Person", "spam@growth.example", None, &[])).unwrap();
        let point = RestorePoint::Since(now() - 3600);

        let preview = s.contacts_restore_preview(point).unwrap();
        assert_eq!(
            (preview.added.as_slice(), preview.edited.as_slice(), preview.deleted.as_slice()),
            (&["Spam Person".to_string()][..], &["Priya Raman".to_string()][..], &["Sam Okafor".to_string()][..])
        );
        let done = s.restore_contacts(point).unwrap();
        assert_eq!(done.changed, 3);
        let after = s.contacts(None).unwrap();
        assert_eq!(names(&after), names(&before), "back to how it was");
        assert!(s.deleted_contacts().unwrap().iter().any(|d| d.full_name == "Spam Person"), "what it removes waits in Recently deleted");
        assert!(!s.deleted_contacts().unwrap().iter().any(|d| d.full_name == "Sam Okafor"), "what it brings back leaves it");
        let sam_back = after.iter().find(|c| c.full_name == "Sam Okafor").unwrap();
        let uid: String = s.db.query_row("SELECT uid FROM contacts WHERE id = ?1", [&sam_back.id], |r| r.get(0)).unwrap();
        assert_eq!(uid, vcard::read_contact(&s.contact_vcard(&sam_back.id).unwrap().vcf).unwrap().uid, "with its UID");

        // Undo the restore.
        assert_eq!(s.contacts_restore_preview(RestorePoint::After(done.mark)).unwrap().edited, ["Priya R."]);
        s.restore_contacts(RestorePoint::After(done.mark)).unwrap();
        assert_eq!(names(&s.contacts(None).unwrap()), ["Priya R.", "Spam Person"]);
        // Nothing left to do is nothing.
        let again = s.contacts_restore_preview(RestorePoint::Since(now() + 10)).unwrap();
        assert_eq!(again, ContactsRestore::default());
    }

    #[test]
    fn restore_covers_sync_but_not_read_only_books() {
        let (s, book) = store();
        // A sync removes a card the server lost: that's history too.
        let vcf = "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:ana-1\r\nFN:Ana Duarte\r\nEMAIL:ana@example.com\r\nEND:VCARD\r\n";
        s.insert_contact(&book, Some("/dav/ana-1.vcf"), Some("\"e1\""), vcf, "synced").unwrap();
        age(&s, 7200);
        s.apply_dav(&book, &crate::DavBatch { upserts: vec![], removed: vec!["/dav/ana-1.vcf".into()], sync_token: None }).unwrap();
        assert!(s.contacts(None).unwrap().is_empty());
        assert_eq!(s.contacts_restore_preview(RestorePoint::Since(now() - 3600)).unwrap().deleted, ["Ana Duarte"]);

        s.db.execute("UPDATE collections SET writable = 0 WHERE id = ?1", [&book]).unwrap();
        let p = s.contacts_restore_preview(RestorePoint::Since(now() - 3600)).unwrap();
        assert_eq!((p.deleted.len(), p.read_only), (0, 1), "read-only books are left alone, and counted");
    }
}
