//! Meeting invitations in the store: reading the one a message carries,
//! answering it, applying cancellations and replies, and inviting guests
//! to your own events.
//!
//! Who emails the iTIP messages depends on the calendar (ADR-0011):
//! - **CalDAV scheduling servers** (RFC 6638: iCloud, Fastmail, Stalwart)
//!   see the change in the event we upload and email the people involved.
//! - **Everything else** (servers without scheduling, on-device
//!   calendars): the store queues the email itself, through the account's
//!   outbox, so it leaves with the next send pass.

use rusqlite::{OptionalExtension, params};

use crate::store::Store;
use crate::{Address, Attendee, CalendarPart, Collection, Draft, Error, Invite, InviteResponse, Result, ical, itip, mime};

/// Settings key prefix: how you answered a counter-proposal, by message.
pub(crate) const COUNTER_ANSWER: &str = "counter_answer:";

fn same(a: &str, b: &str) -> bool {
    a.trim().eq_ignore_ascii_case(b.trim())
}

impl InviteResponse {
    fn partstat(self) -> &'static str {
        match self {
            InviteResponse::Accepted => "ACCEPTED",
            InviteResponse::Tentative => "TENTATIVE",
            InviteResponse::Declined => "DECLINED",
        }
    }
    fn verb(self) -> &'static str {
        match self {
            InviteResponse::Accepted => "Accepted",
            InviteResponse::Tentative => "Tentative",
            InviteResponse::Declined => "Declined",
        }
    }
}

pub(crate) struct Received {
    pub(crate) account_id: String,
    pub(crate) me: Address,
    pub(crate) ics: String,
    pub(crate) meta: itip::InviteMeta,
}

impl Store {
    pub(crate) fn me(&self, account_id: &str) -> Result<Address> {
        let a = self.account(account_id)?;
        Ok(Address { name: Some(a.config.display_name.clone()).filter(|n| !n.trim().is_empty()), email: a.config.address })
    }

    /// The invitation a message carries, if any, as raw parts.
    pub(crate) fn received(&self, message_id: &str) -> Result<Option<Received>> {
        let (account_id, raw): (String, Option<Vec<u8>>) =
            self.db.query_row("SELECT account_id, raw FROM messages WHERE id = ?1", [message_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        let Some(raw) = raw else { return Ok(None) };
        // Cheap check first: most mail has no calendar part.
        if !raw.windows(13).any(|w| w.eq_ignore_ascii_case(b"text/calendar")) && !raw.windows(4).any(|w| w.eq_ignore_ascii_case(b".ics")) {
            return Ok(None);
        }
        let Some(ics) = mime::calendar_part(&raw) else { return Ok(None) };
        let Ok(meta) = itip::read_invite(&ics) else { return Ok(None) };
        Ok(Some(Received { me: self.me(&account_id)?, account_id, ics, meta }))
    }

    /// Our calendar copy of an event, by UID: (id, calendar, ics).
    pub(crate) fn event_by_uid(&self, uid: &str) -> Result<Option<(String, String, String)>> {
        Ok(self
            .db
            .query_row(
                "SELECT e.id, e.collection_id, e.ics FROM events e JOIN collections c ON c.id = e.collection_id
                 WHERE e.uid = ?1 AND e.state != 'deleted' ORDER BY c.writable DESC LIMIT 1",
                [uid],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?)
    }

    /// What the UI shows for a message's invitation.
    pub fn message_invite(&self, message_id: &str) -> Result<Option<Invite>> {
        let Some(rx) = self.received(message_id)? else { return Ok(None) };
        let tz = self.time_zone()?;
        let ev = ical::read_event(&ics_without_method(&rx.ics), &tz).ok();
        let first = ical::occurrences(&ics_without_method(&rx.ics), &tz, i64::MIN / 2, i64::MAX / 2).ok().and_then(|o| o.into_iter().next());
        let copy = self.event_by_uid(&rx.meta.uid)?;
        let my_status = |people: &[Attendee]| people.iter().find(|a| same(&a.email, &rx.me.email)).and_then(|a| a.status.clone());
        let (status, outdated) = match &copy {
            Some((_, _, ics)) => {
                let ours = itip::read_invite(ics).ok();
                (ours.as_ref().and_then(|o| my_status(&o.attendees)), ours.is_some_and(|o| o.sequence > rx.meta.sequence))
            }
            None => (my_status(&rx.meta.attendees), false),
        };
        // A REPLY tells the organizer (you) one guest's answer; a COUNTER, who proposed.
        let from = matches!(rx.meta.method.as_str(), "REPLY" | "COUNTER").then(|| rx.meta.attendees.first().cloned()).flatten();
        let counter = rx.meta.method == "COUNTER";
        let ours = copy.as_ref().and_then(|(_, _, ics)| ical::occurrences(ics, &tz, i64::MIN / 2, i64::MAX / 2).ok()).and_then(|o| o.into_iter().next());
        // What else is on your calendar then: for an invitation, or a proposed new time.
        let conflicts = match (&first, rx.meta.method.as_str()) {
            (Some(o), "REQUEST" | "COUNTER") if !ev.as_ref().is_some_and(|e| e.all_day) => self.conflicts(o.start, o.end, copy.as_ref().map(|(id, _, _)| id.as_str()))?,
            _ => vec![],
        };
        Ok(Some(Invite {
            method: rx.meta.method.to_ascii_lowercase(),
            uid: rx.meta.uid.clone(),
            title: ev.as_ref().map(|e| e.title.clone()).unwrap_or_default(),
            location: ev.as_ref().and_then(|e| e.location.clone()),
            start: first.as_ref().map(|o| o.start),
            end: first.as_ref().map(|o| o.end),
            all_day: ev.as_ref().is_some_and(|e| e.all_day),
            recurring: ev.as_ref().is_some_and(|e| e.recurring),
            organizer: rx.meta.organizer.clone(),
            attendees: rx.meta.attendees.clone(),
            my_status: status,
            event_id: copy.map(|(id, _, _)| id),
            outdated,
            from,
            conflicts,
            current_start: ours.as_ref().filter(|_| counter).map(|o| o.start),
            current_end: ours.as_ref().filter(|_| counter).map(|o| o.end),
            comment: rx.meta.comment.clone(),
            answered: if counter { self.setting(&format!("{COUNTER_ANSWER}{message_id}"))? } else { None },
            proposed: if rx.meta.method == "REQUEST" { self.proposed_time(message_id)? } else { None },
        }))
    }

    /// The calendar an answered invitation lands in: the one asked for, a
    /// writable one on the message's account, or any writable one.
    fn calendar_for_invite(&self, account_id: &str, asked: Option<&str>) -> Result<Collection> {
        if let Some(id) = asked {
            return self.writable(id);
        }
        let cals = self.collections(crate::CollectionKind::Calendar)?;
        cals.iter()
            .find(|c| c.writable && c.account_id.as_deref() == Some(account_id))
            .or_else(|| cals.iter().find(|c| c.writable && !c.hidden))
            .cloned()
            .ok_or_else(|| Error::Invalid("there's no calendar to add this to".into()))
    }

    /// Answers an invitation: puts it in your calendar (unless declined and
    /// not there yet) with your answer, and tells the organizer.
    pub fn respond_to_invite(&self, message_id: &str, response: InviteResponse, calendar_id: Option<&str>) -> Result<Invite> {
        let rx = self.received(message_id)?.ok_or_else(|| Error::NotFound("this message has no invitation".into()))?;
        if rx.meta.method != "REQUEST" {
            return Err(Error::Invalid("only invitations can be answered".into()));
        }
        let me = vec![rx.me.email.clone()];
        let answered = itip::strip_method(&itip::set_partstat(&rx.ics, &me, response.partstat())?)?;
        let target = match self.event_by_uid(&rx.meta.uid)? {
            Some((id, cal, ics)) => {
                let c = self.writable(&cal)?;
                let ours = itip::read_invite(&ics)?;
                // A newer invitation replaces our copy; an older one only changes our answer.
                let body = if rx.meta.sequence >= ours.sequence { answered } else { itip::set_partstat(&ics, &me, response.partstat())? };
                self.rewrite_event(&id, &body, Self::edit_state(&c))?;
                Some(c)
            }
            None if response == InviteResponse::Declined => None,
            None => {
                let c = self.calendar_for_invite(&rx.account_id, calendar_id)?;
                let href = crate::pim_store::child_href(self.collection_href(&c.id)?.as_deref(), &file_name(&rx.meta.uid), "ics");
                self.insert_event(&c.id, href.as_deref(), None, &answered, Self::edit_state(&c))?;
                Some(c)
            }
        };
        if !target.as_ref().is_some_and(|c| c.scheduling)
            && let Some(org) = rx.meta.organizer.as_ref().filter(|o| !same(&o.email, &rx.me.email)) {
                let reply = itip::reply(&rx.ics, &rx.me, response.partstat())?;
                let title = itip_title(&rx.ics);
                let who = rx.me.name.clone().unwrap_or_else(|| rx.me.email.clone());
                let body = format!("{who} {} “{title}”.", response.verb().to_lowercase());
                self.queue_itip(&rx.account_id, std::slice::from_ref(org), &format!("{}: {title}", response.verb()), &body, "REPLY", reply)?;
            }
        self.message_invite(message_id)?.ok_or_else(|| Error::NotFound("this message has no invitation".into()))
    }

    /// Applies a CANCEL (removes the event) or a guest's REPLY (records
    /// their answer on your event) from a message.
    pub fn apply_invite_update(&self, message_id: &str) -> Result<Invite> {
        let rx = self.received(message_id)?.ok_or_else(|| Error::NotFound("this message has no invitation".into()))?;
        let (id, cal, ics) = self.event_by_uid(&rx.meta.uid)?.ok_or_else(|| Error::NotFound("this event isn't in your calendar".into()))?;
        let c = self.writable(&cal)?;
        match rx.meta.method.as_str() {
            "CANCEL" => self.remove_item(crate::CollectionKind::Calendar, &id, &c)?,
            "REPLY" => {
                let guest = rx.meta.attendees.first().ok_or_else(|| Error::Parse("the reply names no guest".into()))?;
                let status = guest.status.as_deref().unwrap_or("needs-action").to_ascii_uppercase();
                self.rewrite_event(&id, &itip::set_partstat(&ics, std::slice::from_ref(&guest.email), &status)?, Self::edit_state(&c))?;
            }
            m => return Err(Error::Invalid(format!("nothing to apply for a {m} message"))),
        }
        self.message_invite(message_id)?.ok_or_else(|| Error::NotFound("this message has no invitation".into()))
    }

    pub(crate) fn queue_itip(&self, account_id: &str, to: &[Address], subject: &str, body: &str, method: &str, ics: String) -> Result<()> {
        let draft = Draft {
            account_id: account_id.to_string(),
            to: to.to_vec(),
            cc: vec![],
            subject: subject.to_string(),
            body: body.to_string(),
            body_html: None,
            in_reply_to: None,
            references: vec![],
            attachments: vec![],
            calendar: Some(CalendarPart { method: method.to_string(), ics }),
            follow_up_after: None,
        };
        // No undo window: answers and invitations leave with the next pass.
        self.queue_send(&draft, 0, None)?;
        Ok(())
    }

    /// After saving an event you organize: sets the guest list and, where
    /// the server won't, emails invitations (and cancellations to anyone
    /// removed). Returns the rewritten object.
    pub(crate) fn apply_guests(&self, event_id: &str, before: Option<&str>, guests: &[Address]) -> Result<()> {
        let (cal, ics): (String, String) = self.db.query_row("SELECT collection_id, ics FROM events WHERE id = ?1", [event_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        let c = self.collection(&cal)?;
        let prior: Vec<Attendee> = before.and_then(|b| itip::people(b).ok()).map(|(_, p)| p).unwrap_or_default();
        if guests.is_empty() && prior.is_empty() {
            return Ok(());
        }
        let account_id = c.account_id.clone().ok_or_else(|| Error::Invalid("invitations need a calendar on a mail account".into()))?;
        let me = self.me(&account_id)?;
        let updated = itip::set_attendees(&ics, &me, guests)?;
        self.rewrite_event(event_id, &updated, Self::edit_state(&c))?;
        if c.scheduling {
            return Ok(());
        }
        let title = itip_title(&updated);
        let invited: Vec<Address> = guests.iter().filter(|g| !same(&g.email, &me.email)).cloned().collect();
        if !invited.is_empty() {
            let body = format!("{} invited you to “{title}”.", me.name.clone().unwrap_or_else(|| me.email.clone()));
            self.queue_itip(&account_id, &invited, &format!("Invitation: {title}"), &body, "REQUEST", itip::organizer_message(&updated, "REQUEST")?)?;
        }
        let removed: Vec<Address> = prior
            .iter()
            .filter(|p| !same(&p.email, &me.email) && !guests.iter().any(|g| same(&g.email, &p.email)))
            .map(|p| Address { name: p.name.clone(), email: p.email.clone() })
            .collect();
        if !removed.is_empty() {
            self.queue_itip(&account_id, &removed, &format!("Canceled: {title}"), &format!("“{title}” was canceled."), "CANCEL", itip::organizer_message(before.unwrap_or(&ics), "CANCEL")?)?;
        }
        Ok(())
    }

    /// Before deleting an event you organize on a server without
    /// scheduling: tells the guests it's canceled.
    pub(crate) fn cancel_for_guests(&self, event_id: &str) -> Result<()> {
        let (cal, ics): (String, String) = self.db.query_row("SELECT collection_id, ics FROM events WHERE id = ?1", [event_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        let c = self.collection(&cal)?;
        let Some(account_id) = c.account_id.clone().filter(|_| !c.scheduling) else { return Ok(()) };
        // Most events have no guests; don't touch the account for those.
        let Ok((Some(org), people)) = itip::people(&ics) else { return Ok(()) };
        let me = self.me(&account_id)?;
        if !same(&org.email, &me.email) {
            return Ok(());
        }
        let guests: Vec<Address> = people.iter().filter(|p| !same(&p.email, &me.email)).map(|p| Address { name: p.name.clone(), email: p.email.clone() }).collect();
        if guests.is_empty() {
            return Ok(());
        }
        let title = itip_title(&ics);
        self.queue_itip(&account_id, &guests, &format!("Canceled: {title}"), &format!("“{title}” was canceled."), "CANCEL", itip::organizer_message(&ics, "CANCEL")?)
    }

    /// The guest list of an event, for the editor.
    pub fn event_guests(&self, event_id: &str) -> Result<Vec<Address>> {
        let ics: String = self.db.query_row("SELECT ics FROM events WHERE id = ?1", params![event_id], |r| r.get(0))?;
        let (org, people) = itip::people(&ics).unwrap_or((None, vec![]));
        Ok(people
            .into_iter()
            .filter(|p| org.as_ref().is_none_or(|o| !same(&o.email, &p.email)))
            .map(|p| Address { name: p.name, email: p.email })
            .collect())
    }
}

/// `read_event` and expansion don't care about METHOD, but CalDAV objects
/// must not carry it; strip it when reading an invitation as an event.
pub(crate) fn ics_without_method(ics: &str) -> String {
    itip::strip_method(ics).unwrap_or_else(|_| ics.to_string())
}

pub(crate) fn itip_title(ics: &str) -> String {
    ical::read_event(&ics_without_method(ics), "UTC").map(|e| e.title).ok().filter(|t| !t.is_empty()).unwrap_or_else(|| "(no title)".into())
}

/// A resource name from a UID: UIDs can hold characters a URL path can't.
fn file_name(uid: &str) -> String {
    uid.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') { c } else { '_' }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AccountConfig, CollectionKind, EditScope, EventInput, Provider, RemoteCollection, Repeat, Security, ServerConfig, store::INBOX};

    fn setup(scheduling: bool) -> (Store, String, String) {
        let s = Store::open_in_memory().unwrap();
        s.ensure_local_collections().unwrap();
        let server = ServerConfig { host: "mail.example.com".into(), port: 993, security: Security::Tls };
        let acct = s
            .add_account(&AccountConfig {
                display_name: "Me".into(),
                address: "me@studio.example".into(),
                username: "me@studio.example".into(),
                provider: Provider::Generic,
                imap: server.clone(),
                smtp: server,
                jmap: None,
                dav: None,
                oauth: None,
            })
            .unwrap()
            .id;
        s.sync_collections(&acct, CollectionKind::Calendar, &[RemoteCollection { href: "/cal/work/".into(), kind: CollectionKind::Calendar, name: "Work".into(), color: None, writable: true, scheduling }]).unwrap();
        let cal = s.collections(CollectionKind::Calendar).unwrap().into_iter().find(|c| c.account_id.is_some()).unwrap().id;
        (s, acct, cal)
    }

    fn mail_with(method: &str, extra: &str) -> Vec<u8> {
        let ics = format!(
            "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Other//EN\r\nMETHOD:{method}\r\nBEGIN:VEVENT\r\nUID:inv-1@other.example\r\nSEQUENCE:0\r\nDTSTAMP:20261010T100000Z\r\nDTSTART:20261020T130000Z\r\nDTEND:20261020T140000Z\r\nSUMMARY:Design crit\r\nORGANIZER;CN=Priya Raman:mailto:priya@studio.example\r\nATTENDEE;CN=Priya Raman;PARTSTAT=ACCEPTED:mailto:priya@studio.example\r\nATTENDEE;CN=Me;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:me@studio.example\r\n{extra}END:VEVENT\r\nEND:VCALENDAR\r\n"
        );
        format!(
            "From: Priya Raman <priya@studio.example>\r\nTo: me@studio.example\r\nSubject: Invitation: Design crit\r\nMessage-ID: <{method}@other.example>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nYou're invited.\r\n--b\r\nContent-Type: text/calendar; method={method}; charset=utf-8\r\n\r\n{ics}\r\n--b--\r\n"
        )
        .into_bytes()
    }

    fn outbox_methods(s: &Store) -> Vec<(String, Vec<String>)> {
        s.outbox()
            .unwrap()
            .into_iter()
            .filter_map(|o| o.draft.calendar.map(|c| (c.method, o.draft.to.into_iter().map(|a| a.email).collect())))
            .collect()
    }

    #[test]
    fn accepting_adds_the_event_and_replies_to_the_organizer() {
        let (s, acct, cal) = setup(false);
        let msg = s.insert_local(&acct, INBOX, &mail_with("REQUEST", ""), false).unwrap();
        let inv = s.message(&msg).unwrap().invite.expect("an invitation");
        assert_eq!((inv.method.as_str(), inv.title.as_str(), inv.my_status.as_deref()), ("request", "Design crit", Some("needs-action")));
        assert_eq!(inv.start, Some(1_792_501_200));
        assert!(inv.event_id.is_none());

        let after = s.respond_to_invite(&msg, InviteResponse::Accepted, None).unwrap();
        assert_eq!(after.my_status.as_deref(), Some("accepted"));
        let id = after.event_id.expect("added to the calendar");
        let e = s.event(&id, None).unwrap();
        assert_eq!(e.occurrence.calendar_id, cal, "lands in the account's calendar");
        assert!(e.attendees.iter().any(|a| a.email == "me@studio.example" && a.status.as_deref() == Some("accepted")));
        let stored: String = s.db.query_row("SELECT ics FROM events WHERE id = ?1", [&id], |r| r.get(0)).unwrap();
        assert!(!stored.contains("METHOD:"), "stored without METHOD");
        assert_eq!(outbox_methods(&s), [("REPLY".to_string(), vec!["priya@studio.example".to_string()])]);

        // Changing your mind updates the same event.
        s.respond_to_invite(&msg, InviteResponse::Tentative, None).unwrap();
        assert_eq!(s.message_invite(&msg).unwrap().unwrap().my_status.as_deref(), Some("tentative"));
        assert_eq!(s.occurrences(0, i64::MAX / 2).unwrap().len(), 1);
    }

    #[test]
    fn declining_a_new_invite_only_replies() {
        let (s, acct, _) = setup(false);
        let msg = s.insert_local(&acct, INBOX, &mail_with("REQUEST", ""), false).unwrap();
        let inv = s.respond_to_invite(&msg, InviteResponse::Declined, None).unwrap();
        assert!(inv.event_id.is_none());
        assert!(s.occurrences(0, i64::MAX / 2).unwrap().is_empty());
        assert_eq!(outbox_methods(&s).len(), 1);
    }

    #[test]
    fn scheduling_servers_send_the_reply_themselves() {
        let (s, acct, _) = setup(true);
        let msg = s.insert_local(&acct, INBOX, &mail_with("REQUEST", ""), false).unwrap();
        s.respond_to_invite(&msg, InviteResponse::Accepted, None).unwrap();
        assert!(outbox_methods(&s).is_empty(), "no email: the server replies");
    }

    #[test]
    fn cancellations_and_replies_apply_to_our_copy() {
        let (s, acct, _) = setup(false);
        let req = s.insert_local(&acct, INBOX, &mail_with("REQUEST", ""), false).unwrap();
        s.respond_to_invite(&req, InviteResponse::Accepted, None).unwrap();
        let cancel = s.insert_local(&acct, INBOX, &mail_with("CANCEL", "STATUS:CANCELLED\r\n"), false).unwrap();
        let inv = s.message_invite(&cancel).unwrap().unwrap();
        assert_eq!(inv.method, "cancel");
        assert!(inv.event_id.is_some(), "points at our copy");
        s.apply_invite_update(&cancel).unwrap();
        assert!(s.occurrences(0, i64::MAX / 2).unwrap().is_empty(), "canceled events leave the calendar");
    }

    #[test]
    fn organizing_invites_guests_and_cancels_for_them() {
        let (s, _acct, cal) = setup(false);
        let ana = Address { name: Some("Ana Duarte".into()), email: "ana@example.com".into() };
        let marcus = Address { name: None, email: "marcus@example.com".into() };
        let input = EventInput {
            calendar_id: cal.clone(),
            title: "Lunch".into(),
            location: None,
            notes: None,
            start: "2026-10-20T13:00".into(),
            end: "2026-10-20T14:00".into(),
            all_day: false,
            time_zone: "UTC".into(),
            repeat: Repeat::None,
            reminders: None,
            attendees: Some(vec![ana.clone(), marcus.clone()]),
        };
        let e = s.create_event(&input).unwrap();
        assert_eq!(e.organizer.as_ref().unwrap().email, "me@studio.example");
        assert_eq!(s.event_guests(&e.occurrence.event_id).unwrap().len(), 2);
        assert_eq!(outbox_methods(&s), [("REQUEST".to_string(), vec!["ana@example.com".to_string(), "marcus@example.com".to_string()])]);

        // Dropping Marcus: everyone left gets the update; Marcus a cancellation.
        let fewer = EventInput { attendees: Some(vec![ana.clone()]), ..input.clone() };
        s.update_event(&e.occurrence.event_id, &fewer, EditScope::All, None).unwrap();
        let sent = outbox_methods(&s);
        assert!(sent.contains(&("CANCEL".to_string(), vec!["marcus@example.com".to_string()])));
        assert_eq!(sent.iter().filter(|(m, _)| m == "REQUEST").count(), 2);

        // Deleting tells the remaining guest.
        s.delete_event(&e.occurrence.event_id, None, EditScope::All).unwrap();
        assert_eq!(outbox_methods(&s).iter().filter(|(m, to)| m == "CANCEL" && to == &vec!["ana@example.com".to_string()]).count(), 1);

        // On-device calendars can't send invitations.
        let local = s.collections(CollectionKind::Calendar).unwrap().into_iter().find(|c| c.account_id.is_none()).unwrap().id;
        assert!(s.create_event(&EventInput { calendar_id: local, ..input }).is_err());
    }
}
