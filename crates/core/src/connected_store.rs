//! Where the apps meet (ADR-0019): a Birthdays calendar from contacts, what
//! you've done with a contact (mail and meetings), and catching up on
//! reminders that came due while the app was closed.

use chrono::{Datelike, NaiveDate};
use rusqlite::{OptionalExtension, params};

use crate::store::{Store, from_json};
use crate::{ContactActivity, ContactField, DueReminder, EventDetail, Occurrence, Repeat, Result, ical, now};

/// Version 9: each contact's birthday, and the Birthdays calendar.
pub(crate) const MIGRATE_V9: &str = r#"
ALTER TABLE contacts ADD COLUMN birthday TEXT;
INSERT OR IGNORE INTO collections (id, account_id, kind, name, color, writable) VALUES ('birthdays', NULL, 'calendar', 'Birthdays', '#db2777', 0);
"#;

/// Birthday "events" are addressed as `birthday:<contact id>`.
pub const BIRTHDAY_PREFIX: &str = "birthday:";
const BIRTHDAYS: &str = "birthdays";

/// When the reminder worker last checked, so the next launch can catch up.
const REMINDERS_CHECKED: &str = "reminders_checked";

/// Catch-up looks back at most this far.
const CATCH_UP_WINDOW: i64 = 7 * 24 * 3600;
/// A missed reminder still matters if its event started less than this ago.
const STILL_RELEVANT: i64 = 3600;
/// Contact activity looks this far back and ahead for meetings.
const ACTIVITY_WINDOW: i64 = 365 * 24 * 3600;

/// A birthday ("YYYY-MM-DD" or "--MM-DD") as a yearly all-day event, so the
/// calendar's own engine places it at local midnight in every zone.
fn birthday_ics(name: &str, birthday: &str) -> Option<(String, Option<i32>)> {
    let (year, md) = match birthday.strip_prefix("--") {
        Some(md) => (None, md.to_string()),
        None => (birthday.get(..4).and_then(|y| y.parse().ok()), birthday.get(5..)?.to_string()),
    };
    // An unknown year starts the series in a leap year, so Feb 29 exists.
    let first = NaiveDate::parse_from_str(&format!("{}-{md}", year.unwrap_or(2000)), "%Y-%m-%d").ok()?;
    let next = first.succ_opt()?;
    let summary = name.replace(['\r', '\n'], " ");
    let ics = format!(
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Mailbird//Birthdays//EN\r\nBEGIN:VEVENT\r\nUID:birthday\r\nDTSTART;VALUE=DATE:{}\r\nDTEND;VALUE=DATE:{}\r\nRRULE:FREQ=YEARLY\r\nSUMMARY:{summary}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
        first.format("%Y%m%d"),
        next.format("%Y%m%d"),
    );
    Some((ics, year))
}

/// "Ana turns 34", or "Ana's birthday" without a year.
fn birthday_title(name: &str, born: Option<i32>, start: i64) -> String {
    // All-day starts are local midnight; noon UTC that day is the same date everywhere.
    let year = chrono::DateTime::from_timestamp(start + 12 * 3600, 0).map(|d| d.year());
    match (born, year) {
        (Some(b), Some(y)) if y > b => format!("{name} turns {}", y - b),
        _ => format!("{name}’s birthday"),
    }
}

impl Store {
    /// Birthday occurrences overlapping `[from, to)`, unless the Birthdays
    /// calendar is hidden.
    pub(crate) fn birthdays(&self, from: i64, to: i64) -> Result<Vec<Occurrence>> {
        let hidden: bool = self.db.query_row("SELECT hidden FROM collections WHERE id = ?1", [BIRTHDAYS], |r| r.get(0)).optional()?.unwrap_or(true);
        if hidden {
            return Ok(vec![]);
        }
        let tz = self.time_zone()?;
        let people: Vec<(String, String, String)> = {
            let mut st = self.db.prepare("SELECT id, full_name, birthday FROM contacts WHERE state <> 'deleted' AND birthday IS NOT NULL")?;
            st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<rusqlite::Result<_>>()?
        };
        let mut out = Vec::new();
        for (id, name, birthday) in people {
            let Some((ics, born)) = birthday_ics(&name, &birthday) else { continue };
            for o in ical::occurrences(&ics, &tz, from, to).unwrap_or_default() {
                out.push(Occurrence {
                    event_id: format!("{BIRTHDAY_PREFIX}{id}"),
                    calendar_id: BIRTHDAYS.into(),
                    title: birthday_title(&name, born, o.start),
                    location: None,
                    start: o.start,
                    end: o.end,
                    original_start: o.original,
                    all_day: true,
                    recurring: true,
                    meeting_url: None,
                    contact_id: Some(id.clone()),
                    travel: None,
                    meeting_app_url: None,
                });
            }
        }
        Ok(out)
    }

    /// A birthday as a read-only event, for the event view.
    pub(crate) fn birthday_event(&self, contact_id: &str, start: Option<i64>) -> Result<EventDetail> {
        let from = start.map_or_else(now, |s| s - 1);
        let occurrence = self
            .birthdays(from, from + 367 * 24 * 3600)?
            .into_iter()
            .find(|o| o.contact_id.as_deref() == Some(contact_id))
            .ok_or_else(|| crate::Error::NotFound("that contact has no birthday".into()))?;
        Ok(EventDetail { occurrence, notes: None, repeat: Repeat::Yearly, time_zone: None, organizer: None, attendees: vec![], url: None, writable: false, reminders: vec![], meeting: None, manage: vec![] })
    }

    /// Fill in birthdays for contacts stored before the column existed.
    pub(crate) fn backfill_birthdays(&self) -> Result<()> {
        let rows: Vec<(String, String)> = {
            let mut st = self.db.prepare("SELECT id, vcf FROM contacts")?;
            st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?
        };
        for (id, vcf) in rows {
            if let Some(b) = crate::vcard::read_contact(&vcf).ok().and_then(|m| m.birthday) {
                self.db.execute("UPDATE contacts SET birthday = ?2 WHERE id = ?1", params![id, b])?;
            }
        }
        Ok(())
    }

    /// Recent conversations with a contact, and meetings they're invited to.
    pub fn contact_activity(&self, contact_id: &str) -> Result<ContactActivity> {
        let emails: Vec<String> = {
            let raw: String = self
                .db
                .query_row("SELECT emails FROM contacts WHERE id = ?1 AND state <> 'deleted'", [contact_id], |r| r.get(0))
                .optional()?
                .ok_or_else(|| crate::Error::NotFound("that contact was deleted".into()))?;
            from_json::<Vec<ContactField>>(raw).into_iter().map(|f| f.value.trim().to_lowercase()).filter(|e| e.contains('@')).collect()
        };
        self.activity_for(&emails)
    }

    /// Who sent mail from `email` (ADR-0036): their card if one lists that
    /// address, else the name they use, plus conversations and meetings.
    pub fn sender_profile(&self, email: &str) -> Result<crate::SenderProfile> {
        let email = email.trim().to_lowercase();
        if !email.contains('@') {
            return Err(crate::Error::Invalid("that isn't an email address".into()));
        }
        let (received, first_seen): (u32, Option<i64>) = self.db.query_row("SELECT count(*), min(date) FROM messages WHERE lower(from_email) = ?1", [&email], |r| Ok((r.get(0)?, r.get(1)?)))?;
        let name: Option<String> = self
            .db
            .query_row("SELECT from_name FROM messages WHERE lower(from_email) = ?1 AND trim(coalesce(from_name, '')) <> '' ORDER BY date DESC LIMIT 1", [&email], |r| r.get(0))
            .optional()?;
        // Two cards can share an address; the one named as they sign wins.
        let contact_id: Option<String> = self
            .db
            .query_row(
                "SELECT c.id FROM contacts c WHERE c.state <> 'deleted'
                   AND EXISTS (SELECT 1 FROM json_each(c.emails) e WHERE lower(trim(json_extract(e.value, '$.value'))) = ?1)
                 ORDER BY lower(c.full_name) = lower(coalesce(?2, '')) DESC, c.full_name LIMIT 1",
                params![&email, &name],
                |r| r.get(0),
            )
            .optional()?;
        let contact = contact_id.map(|id| self.contact(&id)).transpose()?;
        // A contact's other addresses count too: it's the same person.
        let mut emails = vec![email.clone()];
        for f in contact.iter().flat_map(|c| &c.summary.emails) {
            let e = f.value.trim().to_lowercase();
            if e.contains('@') && !emails.contains(&e) {
                emails.push(e);
            }
        }
        let activity = self.activity_for(&emails)?;
        Ok(crate::SenderProfile { email, name, contact, received, first_seen, activity })
    }

    /// Recent conversations with any of `emails`, and meetings they're in.
    fn activity_for(&self, emails: &[String]) -> Result<ContactActivity> {
        if emails.is_empty() {
            return Ok(ContactActivity { threads: vec![], upcoming: vec![], past: vec![] });
        }
        let threads = self.threads_with(emails, 5)?;

        // Meetings name people as ATTENDEE/ORGANIZER "mailto:" addresses.
        let tz = self.time_zone()?;
        let t = now();
        let mut events: Vec<(String, String, String, bool, bool)> = Vec::new();
        {
            let mut st = self.db.prepare(
                "SELECT e.id, e.collection_id, e.ics, e.all_day, e.recurring FROM events e JOIN collections c ON c.id = e.collection_id
                 WHERE c.hidden = 0 AND e.state <> 'deleted' AND e.ics LIKE '%mailto:' || ?1 || '%'",
            )?;
            for email in emails {
                for row in st.query_map([email], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))? {
                    let row = row?;
                    if !events.iter().any(|e| e.0 == row.0) {
                        events.push(row);
                    }
                }
            }
        }
        let mut upcoming = Vec::new();
        let mut past = Vec::new();
        for (id, calendar_id, ics, all_day, recurring) in events {
            for o in ical::occurrences(&ics, &tz, t - ACTIVITY_WINDOW, t + ACTIVITY_WINDOW).unwrap_or_default() {
                let mut occ = Occurrence {
                    event_id: id.clone(),
                    calendar_id: calendar_id.clone(),
                    meeting_url: o.meeting_url.clone(),
                    contact_id: None,
                    travel: o.travel,
                    meeting_app_url: None,
                    title: o.title,
                    location: o.location,
                    start: o.start,
                    end: o.end,
                    original_start: o.original,
                    all_day,
                    recurring,
                };
                occ.meeting_app_url = occ.meeting_url.as_deref().and_then(crate::meeting::app_link);
                if occ.end > t { upcoming.push(occ) } else { past.push(occ) }
            }
        }
        upcoming.sort_by_key(|o| o.start);
        upcoming.truncate(3);
        past.sort_by_key(|o| std::cmp::Reverse(o.start));
        past.truncate(3);
        Ok(ContactActivity { threads, upcoming, past })
    }

    /// When reminders were last checked, if ever.
    pub fn reminders_checked(&self) -> Result<Option<i64>> {
        Ok(self.setting(REMINDERS_CHECKED)?.and_then(|v| v.parse().ok()))
    }

    pub fn set_reminders_checked(&self, at: i64) -> Result<()> {
        self.set_setting(REMINDERS_CHECKED, Some(&at.to_string()))
    }

    /// Reminders that came due between the last check and `until` while
    /// nothing was watching, for events that haven't long started. Looks
    /// back a week at most.
    pub fn missed_reminders(&self, until: i64) -> Result<Vec<DueReminder>> {
        let Some(last) = self.reminders_checked()? else { return Ok(vec![]) };
        let from = last.max(until - CATCH_UP_WINDOW);
        if from >= until {
            return Ok(vec![]);
        }
        let mut due = self.due_reminders(from, until)?;
        due.retain(|r| r.start + STILL_RELEVANT > until);
        // One per occurrence: an event with two reminders is one thing you missed.
        due.dedup_by(|a, b| a.event_id == b.event_id && a.start == b.start);
        Ok(due)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AccountConfig, CollectionKind, ContactInput, EventInput, Provider, Security, ServerConfig};

    fn store() -> (Store, String) {
        let s = Store::open_in_memory().unwrap();
        s.set_time_zone("Europe/Lisbon").unwrap();
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
        (s, a.id)
    }

    fn contact(s: &Store, name: &str, email: &str, birthday: Option<&str>) -> String {
        let book = s.collections(CollectionKind::Contacts).unwrap()[0].id.clone();
        s.create_contact(&ContactInput { photo: None,
            book_id: book,
            full_name: name.into(),
            emails: vec![ContactField { label: None, value: email.into() }],
            phones: vec![],
            org: None,
            title: None,
            note: None,
            birthday: birthday.map(Into::into),
            labels: None,
        })
        .unwrap()
        .summary
        .id
    }

    fn ev(calendar_id: &str, title: &str, start: String, end: String, tz: &str, location: Option<&str>, reminders: Option<Vec<i64>>) -> EventInput {
        EventInput {
            calendar_id: calendar_id.into(),
            title: title.into(),
            location: location.map(Into::into),
            notes: None,
            start,
            end,
            all_day: false,
            time_zone: tz.into(),
            repeat: Repeat::None,
            reminders,
            attendees: None,
            travel: None,
        }
    }

    /// 1 Jan 2027 00:00 UTC, and a year after.
    const Y2027: i64 = 1_798_761_600;
    const YEAR: i64 = 365 * 24 * 3600;

    #[test]
    fn birthdays_calendar() {
        let (s, _) = store();
        let ana = contact(&s, "Ana Duarte", "ana@example.com", Some("1992-03-14"));
        contact(&s, "Marcus Lee", "marcus@example.com", Some("--07-02"));
        contact(&s, "No Birthday", "nb@example.com", None);
        let cals = s.collections(CollectionKind::Calendar).unwrap();
        let bday = cals.iter().find(|c| c.id == "birthdays").unwrap();
        assert!(!bday.writable, "read-only");
        assert!(cals.iter().any(|c| c.id != "birthdays" && c.account_id.is_none() && c.writable), "the device calendar still exists");

        let occ: Vec<_> = s.occurrences(Y2027, Y2027 + YEAR).unwrap().into_iter().filter(|o| o.calendar_id == "birthdays").collect();
        assert_eq!(occ.len(), 2);
        let a = occ.iter().find(|o| o.contact_id.as_deref() == Some(ana.as_str())).unwrap();
        assert_eq!(a.title, "Ana Duarte turns 35");
        assert!(a.all_day);
        assert_eq!(a.start, 1_804_982_400, "14 Mar 2027, local midnight (Lisbon is UTC+0 in March)");
        assert_eq!(occ.iter().find(|o| o.title.starts_with("Marcus")).unwrap().title, "Marcus Lee’s birthday");

        let detail = s.event(&a.event_id, Some(a.start)).unwrap();
        assert!(!detail.writable && detail.occurrence.contact_id.as_deref() == Some(ana.as_str()));

        s.set_collection_hidden("birthdays", true).unwrap();
        assert!(s.occurrences(Y2027, Y2027 + YEAR).unwrap().iter().all(|o| o.calendar_id != "birthdays"), "hiding the calendar hides them");
    }

    #[test]
    fn birthdays_are_backfilled_on_upgrade() {
        let (s, _) = store();
        let id = contact(&s, "Ana", "ana@example.com", Some("1992-03-14"));
        s.db.execute("UPDATE contacts SET birthday = NULL", []).unwrap();
        s.backfill_birthdays().unwrap();
        let b: Option<String> = s.db.query_row("SELECT birthday FROM contacts WHERE id = ?1", [&id], |r| r.get(0)).unwrap();
        assert_eq!(b.as_deref(), Some("1992-03-14"));
    }

    #[test]
    fn meeting_links_on_events() {
        let (s, _) = store();
        let cal = s.collections(CollectionKind::Calendar).unwrap().into_iter().find(|c| c.writable).unwrap().id;
        let e = s
            .create_event(&ev(&cal, "Design crit", "2027-01-05T10:00".into(), "2027-01-05T11:00".into(), "Europe/Lisbon", Some("https://us02web.zoom.us/j/123?pwd=x"), None))
            .unwrap();
        assert_eq!(e.occurrence.meeting_url.as_deref(), Some("https://us02web.zoom.us/j/123?pwd=x"));
        let occ = s.occurrences(Y2027, Y2027 + 30 * 86400).unwrap();
        assert_eq!(occ[0].meeting_url.as_deref(), Some("https://us02web.zoom.us/j/123?pwd=x"), "agenda rows get it too");
    }

    #[test]
    fn contact_activity_lists_mail_and_meetings() {
        let (s, acct) = store();
        let ana = contact(&s, "Ana", "Ana@Example.com", None);
        s.insert_local(&acct, "INBOX", b"From: Ana <ana@example.com>\r\nSubject: Photos\r\nMessage-ID: <p1@x>\r\nDate: Tue, 13 Oct 2026 09:00:00 +0000\r\n\r\nx\r\n", false)
            .unwrap();
        s.insert_local(
            &acct,
            "INBOX",
            b"From: Ana <ana@example.com>\r\nSubject: Re: Photos\r\nMessage-ID: <p2@x>\r\nIn-Reply-To: <p1@x>\r\nDate: Tue, 13 Oct 2026 10:00:00 +0000\r\n\r\nx\r\n",
            false,
        )
        .unwrap();
        s.insert_local(
            &acct,
            "Sent",
            b"From: me@example.com\r\nTo: ANA@example.com\r\nSubject: Dinner\r\nMessage-ID: <d1@x>\r\nDate: Tue, 13 Oct 2026 11:00:00 +0000\r\n\r\nx\r\n",
            true,
        )
        .unwrap();
        s.insert_local(&acct, "INBOX", b"From: Bob <bob@example.com>\r\nSubject: Other\r\nDate: Tue, 13 Oct 2026 12:00:00 +0000\r\n\r\nx\r\n", false).unwrap();
        // A meeting she's invited to, in the next weeks.
        let cal = s.collections(CollectionKind::Calendar).unwrap().into_iter().find(|c| c.writable).unwrap().id;
        let soon = chrono::DateTime::from_timestamp(now() + 7 * 86400, 0).unwrap().format("%Y-%m-%dT10:00").to_string();
        let later = chrono::DateTime::from_timestamp(now() + 7 * 86400, 0).unwrap().format("%Y-%m-%dT11:00").to_string();
        let e = s.create_event(&ev(&cal, "Print review", soon, later, "Europe/Lisbon", None, None)).unwrap();
        let ics: String = s.db.query_row("SELECT ics FROM events WHERE id = ?1", [&e.occurrence.event_id], |r| r.get(0)).unwrap();
        let with_ana = ics.replace("END:VEVENT", "ATTENDEE;CN=Ana:mailto:ana@example.com\r\nEND:VEVENT");
        s.db.execute("UPDATE events SET ics = ?2 WHERE id = ?1", params![e.occurrence.event_id, with_ana]).unwrap();

        let a = s.contact_activity(&ana).unwrap();
        assert_eq!(
            a.threads.iter().map(|t| t.subject.as_str()).collect::<Vec<_>>(),
            ["Dinner", "Re: Photos"],
            "one row per conversation, newest first, including mail you sent her"
        );
        assert_eq!(a.upcoming.len(), 1);
        assert_eq!(a.upcoming[0].title, "Print review");
        assert!(a.past.is_empty());
    }

    #[test]
    fn missed_reminders_catch_up_once() {
        let (s, _) = store();
        assert!(s.missed_reminders(now()).unwrap().is_empty(), "nothing before the first check");
        let cal = s.collections(CollectionKind::Calendar).unwrap().into_iter().find(|c| c.writable).unwrap().id;
        // Starts in 20 minutes, with a 30-minute reminder: due 10 minutes ago.
        let start = now() + 20 * 60;
        let fmt = |t: i64| chrono::DateTime::from_timestamp(t, 0).unwrap().format("%Y-%m-%dT%H:%M").to_string();
        s.create_event(&ev(&cal, "Call", fmt(start), fmt(start + 1800), "UTC", None, Some(vec![30, 25]))).unwrap();
        // One that's long over doesn't count.
        s.create_event(&ev(&cal, "Old", fmt(now() - 5 * 3600), fmt(now() - 4 * 3600), "UTC", None, Some(vec![10]))).unwrap();
        s.set_reminders_checked(now() - 6 * 3600).unwrap();
        let missed = s.missed_reminders(now()).unwrap();
        assert_eq!(missed.iter().map(|r| r.title.as_str()).collect::<Vec<_>>(), ["Call"], "one per occurrence, only ones still relevant");
        s.set_reminders_checked(now()).unwrap();
        assert!(s.missed_reminders(now()).unwrap().is_empty(), "once");
    }

    #[test]
    fn sender_profile_finds_the_card_or_the_name() {
        let (s, acct) = store();
        let ana = contact(&s, "Ana", "ana@example.com", None);
        let _other_card = contact(&s, "A. Duarte", "ana@example.com", None);
        s.insert_local(&acct, "INBOX", b"From: Ana D <Ana@Example.com>\r\nSubject: Photos\r\nMessage-ID: <s1@x>\r\nDate: Tue, 13 Oct 2026 09:00:00 +0000\r\n\r\nx\r\n", false).unwrap();
        s.insert_local(&acct, "INBOX", b"From: Ana <ana@example.com>\r\nSubject: More photos\r\nMessage-ID: <s2@x>\r\nDate: Wed, 14 Oct 2026 09:00:00 +0000\r\n\r\nx\r\n", false).unwrap();
        s.insert_local(&acct, "INBOX", b"From: Lena <lena@example.de>\r\nSubject: Hallo\r\nMessage-ID: <s3@x>\r\nDate: Wed, 14 Oct 2026 10:00:00 +0000\r\n\r\nx\r\n", false).unwrap();

        let p = s.sender_profile(" ANA@example.com ").unwrap();
        assert_eq!(p.email, "ana@example.com");
        assert_eq!(p.contact.as_ref().map(|c| c.summary.id.as_str()), Some(ana.as_str()), "matched to the card named as they sign, ignoring case");
        assert_eq!((p.received, p.first_seen), (2, Some(1_791_882_000)));
        assert_eq!(p.name.as_deref(), Some("Ana"), "the newest message's name");
        assert_eq!(p.activity.threads.len(), 2);

        let lena = s.sender_profile("lena@example.de").unwrap();
        assert!(lena.contact.is_none(), "not a contact");
        assert_eq!((lena.name.as_deref(), lena.received), (Some("Lena"), 1));

        let nobody = s.sender_profile("new@example.org").unwrap();
        assert_eq!((nobody.received, nobody.first_seen, nobody.name), (0, None, None));
        assert!(s.sender_profile("not an address").is_err());
    }
}
