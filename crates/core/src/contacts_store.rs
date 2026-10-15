//! Contacts depth (ADR-0020): labels, Recently deleted, signatures turned
//! into contacts, and sharing a card as a file or a QR code.

use qrcode::{EcLevel, QrCode, render::svg};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::pim_store::{CHANGED, child_href};
use crate::signature::{self, SignatureCard};
use crate::store::Store;
use crate::{ContactDetail, ContactField, Error, Result, now, vcard};

/// Schema v10: labels on contacts, and the Recently deleted list.
pub(crate) const MIGRATE_V10: &str = r#"
ALTER TABLE contacts ADD COLUMN labels TEXT NOT NULL DEFAULT '[]';
CREATE TABLE contacts_trash (
  id            TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL,
  uid           TEXT NOT NULL,
  vcf           TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  deleted_at    INTEGER NOT NULL
);
CREATE INDEX contacts_trash_at ON contacts_trash (deleted_at);
"#;

/// How long a deleted contact can be restored.
const KEEP_DELETED: i64 = 30 * 24 * 3600;

/// One label and how many visible contacts carry it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactLabel {
    pub name: String,
    pub count: u32,
}

/// A contact in Recently deleted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletedContact {
    pub id: String,
    pub book_id: String,
    pub full_name: String,
    pub emails: Vec<ContactField>,
    pub deleted_at: i64,
}

/// The same person's card in another address book.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactCopy {
    pub id: String,
    pub book_id: String,
    pub full_name: String,
}

/// A card as a file to save or send.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactExport {
    pub file_name: String,
    pub vcf: String,
}

/// What a message's signature adds: a new contact, or details missing from
/// one you have.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactSuggestion {
    /// The contact it would update; None means a new one.
    pub contact_id: Option<String>,
    /// The card to open in the editor: the signature, merged over the
    /// contact's own fields when there is one.
    pub card: SignatureCard,
    /// What's new, for the prompt ("phone", "title", "company").
    pub adds: Vec<String>,
}

impl Store {
    /// Copies a contact into Recently deleted before it goes.
    pub(crate) fn trash_contact(&self, id: &str) -> Result<()> {
        self.db.execute(
            "INSERT INTO contacts_trash (id, collection_id, uid, vcf, full_name, deleted_at)
             SELECT ?2, collection_id, uid, vcf, full_name, ?3 FROM contacts WHERE id = ?1",
            params![id, uuid::Uuid::new_v4().to_string(), now()],
        )?;
        Ok(())
    }

    /// Recently deleted, newest first. Older than 30 days is gone for good.
    pub fn deleted_contacts(&self) -> Result<Vec<DeletedContact>> {
        self.db.execute("DELETE FROM contacts_trash WHERE deleted_at < ?1", [now() - KEEP_DELETED])?;
        let mut st = self.db.prepare("SELECT id, collection_id, full_name, vcf, deleted_at FROM contacts_trash ORDER BY deleted_at DESC, rowid DESC")?;
        let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, i64>(4)?)))?;
        let mut out = Vec::new();
        for row in rows {
            let (id, book_id, full_name, vcf, deleted_at) = row?;
            let emails = vcard::read_contact(&vcf).map(|m| m.emails).unwrap_or_default();
            out.push(DeletedContact { id, book_id, full_name, emails, deleted_at });
        }
        Ok(out)
    }

    /// Puts a deleted contact back, with its UID (so note links find it
    /// again). It returns to its address book, or this device's when that
    /// book is gone or read-only now. If the server hasn't been told about
    /// the delete yet, the delete is simply called off.
    pub fn restore_contact(&self, trash_id: &str) -> Result<ContactDetail> {
        let (book_id, uid, vcf): (String, String, String) = self
            .db
            .query_row("SELECT collection_id, uid, vcf FROM contacts_trash WHERE id = ?1", [trash_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .optional()?
            .ok_or_else(|| Error::NotFound("that contact is no longer in Recently deleted".into()))?;
        let tx = self.db.unchecked_transaction()?;
        let pending: Option<(String, String)> =
            self.db.query_row("SELECT id, state FROM contacts WHERE collection_id = ?1 AND uid = ?2", params![book_id, uid], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
        let id = match pending {
            // Still waiting to be deleted on the server: keep it there.
            Some((id, state)) if state == "deleted" => {
                self.rewrite_contact(&id, &vcf, CHANGED)?;
                id
            }
            // Already back (a sync brought it, or a second restore).
            Some((id, _)) => id,
            None => {
                let book = match self.writable(&book_id) {
                    Ok(c) => c,
                    Err(_) => {
                        let local: String = self.db.query_row(
                            "SELECT id FROM collections WHERE account_id IS NULL AND kind = 'contacts' AND writable = 1 AND id <> 'birthdays' LIMIT 1",
                            [],
                            |r| r.get(0),
                        )?;
                        self.writable(&local)?
                    }
                };
                let href = child_href(self.collection_href(&book.id)?.as_deref(), &uid, "vcf");
                self.insert_contact(&book.id, href.as_deref(), None, &vcf, Self::edit_state(&book))?
            }
        };
        self.db.execute("DELETE FROM contacts_trash WHERE id = ?1", [trash_id])?;
        tx.commit()?;
        self.contact(&id)
    }

    /// The same person's cards in other address books: a shared email or
    /// phone number, in a different book (Apple's unified contacts). Lets the
    /// card say where else it lives, so you edit the copy you mean.
    pub fn contact_copies(&self, id: &str) -> Result<Vec<ContactCopy>> {
        let me = self.contact(id)?.summary;
        let emails: Vec<String> = me.emails.iter().map(|e| vcard::normalize_email(&e.value)).collect();
        let phones: Vec<String> = me.phones.iter().map(|p| vcard::normalize_phone(&p.value)).filter(|p| p.len() >= 7).collect();
        let mut out = Vec::new();
        for c in self.contacts(None)? {
            if c.id == me.id || c.book_id == me.book_id {
                continue;
            }
            let shares = c.emails.iter().any(|e| emails.contains(&vcard::normalize_email(&e.value))) || c.phones.iter().any(|p| phones.contains(&vcard::normalize_phone(&p.value)));
            if shares {
                out.push(ContactCopy { id: c.id, book_id: c.book_id, full_name: c.full_name });
            }
        }
        Ok(out)
    }

    /// Photos of the people you have cards for, by email address, so mail
    /// can show a face instead of initials. Embedded photos only (never
    /// fetched), from visible address books.
    pub fn contact_photos(&self) -> Result<std::collections::BTreeMap<String, String>> {
        let mut out = std::collections::BTreeMap::new();
        for c in self.contacts(None)? {
            let Some(photo) = c.photo else { continue };
            for e in &c.emails {
                out.entry(vcard::normalize_email(&e.value)).or_insert_with(|| photo.clone());
            }
        }
        Ok(out)
    }

    /// Every label on a visible contact, alphabetical, with counts.
    pub fn contact_labels(&self) -> Result<Vec<ContactLabel>> {
        let mut st = self.db.prepare(
            "SELECT min(l.value), count(*) FROM contacts k JOIN collections c ON c.id = k.collection_id, json_each(k.labels) l
             WHERE c.hidden = 0 AND k.state != 'deleted' GROUP BY lower(l.value) ORDER BY lower(l.value)",
        )?;
        Ok(st.query_map([], |r| Ok(ContactLabel { name: r.get(0)?, count: r.get(1)? }))?.collect::<rusqlite::Result<_>>()?)
    }

    /// Labels for contacts stored before they had a column.
    pub(crate) fn backfill_labels(&self) -> Result<()> {
        let rows: Vec<(String, String)> = {
            let mut st = self.db.prepare("SELECT id, vcf FROM contacts")?;
            st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?
        };
        for (id, vcf) in rows {
            let labels = vcard::read_contact(&vcf).map(|m| m.labels).unwrap_or_default();
            if !labels.is_empty() {
                self.db.execute("UPDATE contacts SET labels = ?2 WHERE id = ?1", params![id, crate::store::json(&labels)])?;
            }
        }
        Ok(())
    }

    /// The stored card as a `.vcf` file, exactly as the server has it.
    pub fn contact_vcard(&self, id: &str) -> Result<ContactExport> {
        let (name, vcf): (String, String) = self
            .db
            .query_row("SELECT full_name, vcf FROM contacts WHERE id = ?1 AND state != 'deleted'", [id], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?
            .ok_or_else(|| Error::NotFound("that contact was deleted".into()))?;
        let safe: String = name.chars().map(|c| if "/\\:*?\"<>|".contains(c) || c.is_control() { '-' } else { c }).collect();
        let stem: String = safe.trim().trim_matches('.').chars().take(80).collect();
        let stem = stem.trim();
        Ok(ContactExport { file_name: format!("{}.vcf", if stem.is_empty() { "contact" } else { stem }), vcf })
    }

    /// A QR code (SVG) a phone camera turns into a contact. It carries a
    /// short card (name, company, title, phones, emails), not the photo or
    /// notes, so it stays small enough to scan.
    pub fn contact_qr(&self, id: &str) -> Result<String> {
        let c = self.contact(id)?;
        let input = crate::ContactInput { photo: None,
            book_id: String::new(),
            full_name: c.summary.full_name,
            emails: c.summary.emails,
            phones: c.summary.phones,
            org: c.summary.org,
            title: c.title,
            note: None,
            birthday: None,
            labels: None,
        };
        let card = vcard::new_contact("qr", &input)?;
        // The UID and PRODID mean nothing to the phone that scans it.
        let card: String = card.lines().filter(|l| !l.starts_with("UID:") && !l.starts_with("PRODID:")).map(|l| format!("{l}\n")).collect();
        let code = QrCode::with_error_correction_level(card.as_bytes(), EcLevel::M).map_err(|_| Error::Invalid("this card is too long for a QR code".into()))?;
        Ok(code.render::<svg::Color>().min_dimensions(256, 256).quiet_zone(true).dark_color(svg::Color("#000")).light_color(svg::Color("#fff")).build())
    }

    /// What the signature of message `id` could add to your contacts, if
    /// anything: a new contact for its sender, or details yours lacks.
    pub fn contact_suggestion(&self, message_id: &str) -> Result<Option<ContactSuggestion>> {
        let m = self.message(message_id)?;
        let email = vcard::normalize_email(&m.summary.from.email);
        let mine = self.accounts()?.iter().any(|a| vcard::normalize_email(&a.config.address) == email);
        // Newsletters and notifications sign with a company, not a person.
        let people = m.summary.category == crate::Category::People;
        if email.is_empty() || mine || !people {
            return Ok(None);
        }
        let Some(mut card) = signature::from_message(&m.body_text, m.summary.from.name.as_deref()) else { return Ok(None) };
        if !card.emails.iter().any(|e| vcard::normalize_email(&e.value) == email) {
            card.emails.insert(0, ContactField { label: None, value: m.summary.from.email.clone() });
        }
        let existing: Option<String> = self
            .db
            .query_row(
                "SELECT k.id FROM contacts k WHERE k.state != 'deleted'
                   AND EXISTS (SELECT 1 FROM json_each(k.emails) e WHERE lower(json_extract(e.value, '$.value')) = ?1) LIMIT 1",
                [&email],
                |r| r.get(0),
            )
            .optional()?
            // A new address from someone you have under the same name.
            .map_or_else(|| self.contact_named(m.summary.from.name.as_deref()), |id| Ok(Some(id)))?;
        let Some(id) = existing else {
            let mut adds = vec!["contact".to_string()];
            adds.extend(details(&card));
            return Ok(Some(ContactSuggestion { contact_id: None, card, adds }));
        };
        let have = self.contact(&id)?;
        if !have.writable {
            return Ok(None);
        }
        let mut adds = Vec::new();
        let mut merged = SignatureCard {
            full_name: have.summary.full_name.clone(),
            org: have.summary.org.clone(),
            title: have.title.clone(),
            emails: have.summary.emails.clone(),
            phones: have.summary.phones.clone(),
        };
        let new_phones: Vec<_> =
            card.phones.into_iter().filter(|p| !have.summary.phones.iter().any(|h| vcard::normalize_phone(&h.value) == vcard::normalize_phone(&p.value))).collect();
        if !new_phones.is_empty() {
            adds.push(if new_phones.len() == 1 { "phone".into() } else { "phones".into() });
            merged.phones.extend(new_phones);
        }
        let new_emails: Vec<_> =
            card.emails.into_iter().filter(|e| !have.summary.emails.iter().any(|h| vcard::normalize_email(&h.value) == vcard::normalize_email(&e.value))).collect();
        if !new_emails.is_empty() {
            adds.push("email".into());
            merged.emails.extend(new_emails);
        }
        // Only fill blanks: a signature never overwrites what you typed.
        if merged.title.is_none() && card.title.is_some() {
            adds.push("title".into());
            merged.title = card.title;
        }
        if merged.org.is_none() && card.org.is_some() {
            adds.push("company".into());
            merged.org = card.org;
        }
        Ok((!adds.is_empty()).then_some(ContactSuggestion { contact_id: Some(id), card: merged, adds }))
    }
}

impl Store {
    /// The one contact with exactly this name, if there is exactly one.
    fn contact_named(&self, name: Option<&str>) -> Result<Option<String>> {
        let Some(key) = name.map(crate::pim_store::name_key).filter(|k| k.contains(' ')) else { return Ok(None) };
        let mut st = self.db.prepare("SELECT id, full_name FROM contacts WHERE state != 'deleted'")?;
        let ids: Vec<String> = st
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .filter_map(|r| r.ok())
            .filter(|(_, n)| crate::pim_store::name_key(n) == key)
            .map(|(id, _)| id)
            .collect();
        Ok(if ids.len() == 1 { ids.into_iter().next() } else { None })
    }
}

fn details(c: &SignatureCard) -> Vec<String> {
    let mut out = Vec::new();
    if !c.phones.is_empty() {
        out.push("phone".to_string());
    }
    if c.title.is_some() {
        out.push("title".into());
    }
    if c.org.is_some() {
        out.push("company".into());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AccountConfig, CollectionKind, ContactInput, Provider, Security, ServerConfig};

    fn store() -> (Store, String, String) {
        let s = Store::open_in_memory().unwrap();
        s.ensure_local_collections().unwrap();
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
        let local = s.collections(CollectionKind::Contacts).unwrap()[0].id.clone();
        (s, a.id, local)
    }

    fn input(book: &str, name: &str, email: &str, labels: Option<Vec<&str>>) -> ContactInput {
        ContactInput { photo: None,
            book_id: book.into(),
            full_name: name.into(),
            emails: vec![ContactField { label: None, value: email.into() }],
            phones: vec![],
            org: None,
            title: None,
            note: None,
            birthday: None,
            labels: labels.map(|l| l.into_iter().map(String::from).collect()),
        }
    }

    #[test]
    fn copies_in_other_books_and_photos_by_address() {
        let s = Store::open_in_memory().unwrap();
        s.ensure_local_collections().unwrap();
        let local = s.collections(crate::CollectionKind::Contacts).unwrap()[0].id.clone();
        s.db.execute("INSERT INTO collections (id, account_id, kind, name, writable) VALUES ('work', NULL, 'contacts', 'Work', 1)", []).unwrap();
        let card = |book: &str, name: &str, email: &str, phone: &str, photo: Option<&str>| crate::ContactInput {
            book_id: book.into(),
            full_name: name.into(),
            emails: vec![ContactField { label: None, value: email.into() }],
            phones: if phone.is_empty() { vec![] } else { vec![ContactField { label: None, value: phone.into() }] },
            org: None,
            title: None,
            note: None,
            birthday: None,
            labels: None,
            photo: photo.map(String::from),
        };
        let png = format!("data:image/png;base64,{}", { use base64::Engine; base64::engine::general_purpose::STANDARD.encode([0x89u8, b'P', b'N', b'G']) });
        let ana = s.create_contact(&card(&local, "Ana Duarte", "ana@example.com", "", Some(&png))).unwrap();
        let work = s.create_contact(&card("work", "Ana D.", "ANA@example.com", "+351 912 345 678", None)).unwrap();
        s.create_contact(&card(&local, "Ana (old)", "ana@example.com", "", None)).unwrap();
        let by_phone = s.create_contact(&card("work", "Front desk", "desk@example.com", "912 345 678", None)).unwrap();
        let copies = s.contact_copies(&ana.summary.id).unwrap();
        assert_eq!(copies.iter().map(|c| c.full_name.as_str()).collect::<Vec<_>>(), ["Ana D."], "same address, other book; the same book's card isn't a copy");
        let from_work = s.contact_copies(&work.summary.id).unwrap();
        assert!(from_work.iter().any(|c| c.full_name == "Ana Duarte") && !from_work.iter().any(|c| c.id == by_phone.summary.id), "a phone shared within one book isn't a copy");
        let photos = s.contact_photos().unwrap();
        assert_eq!(photos.get("ana@example.com"), Some(&png), "a face for her address");
        assert!(!photos.contains_key("desk@example.com"));
    }

    #[test]
    fn labels_round_trip_filter_and_count() {
        let (s, _, book) = store();
        let ana = s.create_contact(&input(&book, "Ana Duarte", "ana@example.com", Some(vec!["Clay club", "Family", " clay CLUB ", ""]))).unwrap();
        assert_eq!(ana.summary.labels, vec!["Clay club", "Family"], "trimmed, no blanks, no case repeats");
        s.create_contact(&input(&book, "Rui Costa", "rui@clay.example", Some(vec!["clay club"]))).unwrap();
        s.create_contact(&input(&book, "Sam Okafor", "sam@studio.example", None)).unwrap();
        assert_eq!(
            s.contact_labels().unwrap(),
            vec![ContactLabel { name: "Clay club".into(), count: 2 }, ContactLabel { name: "Family".into(), count: 1 }],
            "grouped regardless of case"
        );
        let club: Vec<_> = s.contacts_labeled(None, Some("CLAY CLUB")).unwrap().into_iter().map(|c| c.full_name).collect();
        assert_eq!(club, vec!["Rui Costa", "Ana Duarte"], "by family name");
        assert_eq!(s.contacts_labeled(Some("rui"), Some("family")).unwrap().len(), 0, "search and label together");

        // An edit that doesn't mention labels keeps them; one that does replaces them.
        let id = ana.summary.id.clone();
        assert_eq!(s.update_contact(&id, &input(&book, "Ana D.", "ana@example.com", None)).unwrap().summary.labels, vec!["Clay club", "Family"]);
        assert_eq!(s.update_contact(&id, &input(&book, "Ana D.", "ana@example.com", Some(vec![]))).unwrap().summary.labels, Vec::<String>::new());
        let vcf: String = s.db.query_row("SELECT vcf FROM contacts WHERE id = ?1", [&id], |r| r.get(0)).unwrap();
        assert!(!vcf.contains("CATEGORIES"), "{vcf}");
    }

    #[test]
    fn deleted_contacts_come_back() {
        let (s, _, book) = store();
        let ana = s.create_contact(&input(&book, "Ana Duarte", "ana@example.com", Some(vec!["Family"]))).unwrap();
        let uid: String = s.db.query_row("SELECT uid FROM contacts WHERE id = ?1", [&ana.summary.id], |r| r.get(0)).unwrap();
        s.delete_contact(&ana.summary.id).unwrap();
        assert!(s.contacts(None).unwrap().is_empty());
        let gone = s.deleted_contacts().unwrap();
        assert_eq!(gone.len(), 1);
        assert_eq!((gone[0].full_name.as_str(), gone[0].emails[0].value.as_str()), ("Ana Duarte", "ana@example.com"));

        let back = s.restore_contact(&gone[0].id).unwrap();
        assert_eq!((back.summary.full_name.as_str(), back.summary.labels.clone()), ("Ana Duarte", vec!["Family".to_string()]));
        let uid_now: String = s.db.query_row("SELECT uid FROM contacts WHERE id = ?1", [&back.summary.id], |r| r.get(0)).unwrap();
        assert_eq!(uid_now, uid, "same UID, so note links find it");
        assert!(s.deleted_contacts().unwrap().is_empty());
        assert!(s.restore_contact(&gone[0].id).is_err(), "restored once");

        // Older than 30 days is gone for good.
        s.delete_contact(&back.summary.id).unwrap();
        s.db.execute("UPDATE contacts_trash SET deleted_at = deleted_at - ?1", [KEEP_DELETED + 1]).unwrap();
        assert!(s.deleted_contacts().unwrap().is_empty());
    }

    #[test]
    fn restoring_a_synced_contact_before_the_server_hears() {
        let (s, account, _) = store();
        s.db.execute("INSERT INTO collections (id, account_id, kind, name, href, writable) VALUES ('book-a', ?1, 'contacts', 'Work', '/dav/work/', 1)", [&account]).unwrap();
        let vcf = vcard::new_contact("sam-1", &input("book-a", "Sam Okafor", "sam@studio.example", None)).unwrap();
        let id = s.insert_contact("book-a", Some("/dav/work/sam-1.vcf"), Some("\"e1\""), &vcf, "synced").unwrap();
        s.delete_contact(&id).unwrap();
        let state: String = s.db.query_row("SELECT state FROM contacts WHERE id = ?1", [&id], |r| r.get(0)).unwrap();
        assert_eq!(state, "deleted", "waits for the server");
        let back = s.restore_contact(&s.deleted_contacts().unwrap()[0].id).unwrap();
        assert_eq!(back.summary.id, id, "the same row: the delete is called off");
        let (state, etag): (String, Option<String>) = s.db.query_row("SELECT state, etag FROM contacts WHERE id = ?1", [&id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((state.as_str(), etag.as_deref()), ("changed", Some("\"e1\"")), "re-uploaded over the server copy");

        // A book that's gone: it comes back on this device.
        s.delete_contact(&id).unwrap();
        s.db.execute("DELETE FROM contacts WHERE id = ?1", [&id]).unwrap();
        s.db.execute("DELETE FROM collections WHERE id = 'book-a'", []).unwrap();
        let back = s.restore_contact(&s.deleted_contacts().unwrap()[0].id).unwrap();
        let local = s.collections(CollectionKind::Contacts).unwrap().into_iter().find(|c| c.account_id.is_none()).unwrap();
        assert_eq!(back.summary.book_id, local.id);
    }

    #[test]
    fn merges_can_be_undone() {
        let (s, _, book) = store();
        let a = s.create_contact(&input(&book, "Ana Duarte", "ana@example.com", None)).unwrap().summary.id;
        let b = s.create_contact(&input(&book, "Ana D.", "ana@studio.example", None)).unwrap().summary.id;
        s.merge_contacts(&a, &[b]).unwrap();
        let gone = s.deleted_contacts().unwrap();
        assert_eq!(gone.iter().map(|g| g.full_name.as_str()).collect::<Vec<_>>(), vec!["Ana D."]);
        s.restore_contact(&gone[0].id).unwrap();
        assert_eq!(s.contacts(None).unwrap().len(), 2);
    }

    #[test]
    fn share_as_file_and_qr() {
        let (s, _, book) = store();
        let id = s
            .create_contact(&ContactInput { photo: None, title: Some("Lead".into()), note: Some("private".into()), ..input(&book, "Priya: Raman", "priya@studio.example", None) })
            .unwrap()
            .summary
            .id;
        let file = s.contact_vcard(&id).unwrap();
        assert_eq!(file.file_name, "Priya- Raman.vcf");
        assert!(file.vcf.contains("NOTE:private"), "the file is the whole card");
        let svg = s.contact_qr(&id).unwrap();
        assert!(svg.starts_with("<?xml") && svg.contains("<svg") && svg.len() > 2000, "{}", &svg[..80]);
    }

    #[test]
    fn suggestions_from_signatures() {
        let (s, account, book) = store();
        let raw = |from: &str, body: &str| format!("From: {from}\r\nTo: me@example.com\r\nSubject: Hi\r\nMessage-ID: <{}@x>\r\n\r\n{body}\r\n", uuid::Uuid::new_v4()).into_bytes();
        let sig = "Thursday works.\r\n\r\nBest,\r\nPriya Raman\r\nDesign systems lead | Studio\r\nm: +1 555 010 4410";
        let m = s.insert_local(&account, "INBOX", &raw("Priya Raman <priya@studio.example>", sig), false).unwrap();
        let new = s.contact_suggestion(&m).unwrap().unwrap();
        assert_eq!(new.contact_id, None);
        assert_eq!(new.adds, vec!["contact", "phone", "title", "company"]);
        assert_eq!(new.card.emails[0].value, "priya@studio.example", "the sender's address is on the card");

        // With a contact already: only what's missing, never overwriting.
        let id = s.create_contact(&ContactInput { photo: None, org: Some("Studio Ltd".into()), ..input(&book, "Priya", "PRIYA@studio.example", None) }).unwrap().summary.id;
        let more = s.contact_suggestion(&m).unwrap().unwrap();
        assert_eq!((more.contact_id.as_deref(), more.adds.clone()), (Some(id.as_str()), vec!["phone".to_string(), "title".to_string()]));
        assert_eq!((more.card.full_name.as_str(), more.card.org.as_deref()), ("Priya", Some("Studio Ltd")), "your fields win");
        s.update_contact(
            &id,
            &ContactInput { photo: None, phones: more.card.phones.clone(), title: more.card.title.clone(), org: more.card.org.clone(), ..input(&book, "Priya", "priya@studio.example", None) },
        )
        .unwrap();
        assert_eq!(s.contact_suggestion(&m).unwrap(), None, "nothing new now");

        // A new address under a name you have: add it to that contact.
        let sam = s.create_contact(&ContactInput { photo: None, title: Some("Engineer".into()), ..input(&book, "Sam Okafor", "sam@studio.example", None) }).unwrap().summary.id;
        let other = s.insert_local(&account, "INBOX", &raw("Sam Okafor <sam@example.com>", "Spec attached.\r\n\r\n-- \r\nSam Okafor\r\nEngineer\r\nm: +1 555 010 2200"), false).unwrap();
        let more = s.contact_suggestion(&other).unwrap().unwrap();
        assert_eq!((more.contact_id.as_deref(), more.adds.clone()), (Some(sam.as_str()), vec!["phone".to_string(), "email".to_string()]));
        assert_eq!(more.card.emails.len(), 2);

        // A newsletter's signature is a company's, not a person's.
        let news = s
            .insert_local(&account, "INBOX", format!("List-Id: <club.clay.example>\r\n{}", String::from_utf8(raw("Clay Club <news@clay.example>", sig)).unwrap()).as_bytes(), false)
            .unwrap();
        assert_eq!(s.contact_suggestion(&news).unwrap(), None);

        // No signature, or your own mail: nothing.
        let plain = s.insert_local(&account, "INBOX", &raw("Rui <rui@clay.example>", "See you at the kiln."), false).unwrap();
        assert_eq!(s.contact_suggestion(&plain).unwrap(), None);
        let own = s.insert_local(&account, "INBOX", &raw("Me <me@example.com>", sig), false).unwrap();
        assert_eq!(s.contact_suggestion(&own).unwrap(), None);
    }
}
