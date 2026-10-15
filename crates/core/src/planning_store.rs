//! Calendar planning (ADR-0021): what an invitation clashes with, proposing
//! another time (iTIP COUNTER) and answering a proposal, finding free time,
//! and saved sets of visible calendars.

use crate::invite_store::{COUNTER_ANSWER, itip_title};
use crate::store::{Store, from_json, json};
use crate::{CalendarSet, CollectionKind, EditScope, Error, EventInput, Invite, Occurrence, Result, TimeSlot, ical, itip, now};

/// Settings key prefix: the time you proposed for an invitation, by message.
pub(crate) const PROPOSED: &str = "proposed_time:";
const CALENDAR_SETS: &str = "calendar_sets";
/// How far ahead "find a time" looks.
const FIND_DAYS: i64 = 14;
/// Suggestions start on the half hour.
const GRID: i64 = 30 * 60;

fn same(a: &str, b: &str) -> bool {
    a.trim().eq_ignore_ascii_case(b.trim())
}

fn round_up(t: i64, step: i64) -> i64 {
    t.div_euclid(step) * step + if t.rem_euclid(step) == 0 { 0 } else { step }
}

impl Store {
    /// Timed events in visible calendars overlapping `start..end`, except `skip`
    /// (the invitation's own copy). All-day events don't block time.
    pub(crate) fn conflicts(&self, start: i64, end: i64, skip: Option<&str>) -> Result<Vec<Occurrence>> {
        Ok(self.occurrences(start, end)?.into_iter().filter(|o| !o.all_day && Some(o.event_id.as_str()) != skip && o.start < end && o.end > start).collect())
    }

    /// Proposes another time for an invitation (you're a guest): emails the
    /// organizer a COUNTER. Your answer doesn't change.
    pub fn propose_time(&self, message_id: &str, start: i64, end: i64, comment: Option<&str>) -> Result<Invite> {
        let rx = self.received(message_id)?.ok_or_else(|| Error::NotFound("this message has no invitation".into()))?;
        if rx.meta.method != "REQUEST" {
            return Err(Error::Invalid("only an invitation can get a new time".into()));
        }
        let org = rx.meta.organizer.clone().filter(|o| !same(&o.email, &rx.me.email)).ok_or_else(|| Error::Invalid("you organize this; edit the event instead".into()))?;
        let ics = itip::counter(&rx.ics, &rx.me, start, end, comment)?;
        let title = itip_title(&rx.ics);
        let tz = self.time_zone()?;
        let when = format!("{}–{}", ical::local_input(start, &tz).replace('T', " "), &ical::local_input(end, &tz)[11..]);
        let who = rx.me.name.clone().unwrap_or_else(|| rx.me.email.clone());
        let mut body = format!("{who} proposed a new time for “{title}”: {when} ({tz}).");
        if let Some(c) = comment.map(str::trim).filter(|c| !c.is_empty()) {
            body.push_str(&format!("\n\n{c}"));
        }
        self.queue_itip(&rx.account_id, std::slice::from_ref(&org), &format!("New time proposed: {title}"), &body, "COUNTER", ics)?;
        self.set_setting(&format!("{PROPOSED}{message_id}"), Some(&json(&TimeSlot { start, end })))?;
        self.message_invite(message_id)?.ok_or_else(|| Error::NotFound("this message has no invitation".into()))
    }

    /// The time you proposed for an invitation, if you did.
    pub(crate) fn proposed_time(&self, message_id: &str) -> Result<Option<TimeSlot>> {
        Ok(self.setting(&format!("{PROPOSED}{message_id}"))?.map(from_json))
    }

    /// The counter-proposal a message carries, with your event (you organize it).
    fn counter_for(&self, message_id: &str) -> Result<(crate::invite_store::Received, String, String)> {
        let rx = self.received(message_id)?.ok_or_else(|| Error::NotFound("this message has no invitation".into()))?;
        if rx.meta.method != "COUNTER" {
            return Err(Error::Invalid("this message doesn't propose a new time".into()));
        }
        let (id, cal, ics) = self.event_by_uid(&rx.meta.uid)?.ok_or_else(|| Error::NotFound("this event isn't in your calendar".into()))?;
        let (org, _) = itip::people(&ics)?;
        if !org.is_some_and(|o| same(&o.email, &rx.me.email)) {
            return Err(Error::Invalid("only the organizer can change the time".into()));
        }
        Ok((rx, id, cal))
    }

    /// Takes a guest's proposed time: moves your event and sends everyone the
    /// update. The proposer has accepted it; the others are asked again.
    pub fn accept_counter(&self, message_id: &str) -> Result<Invite> {
        let (rx, id, cal) = self.counter_for(message_id)?;
        let c = self.writable(&cal)?;
        let tz = self.time_zone()?;
        let proposed = ical::occurrences(&crate::invite_store::ics_without_method(&rx.ics), &tz, i64::MIN / 2, i64::MAX / 2)?
            .into_iter()
            .next()
            .ok_or_else(|| Error::Parse("the proposal has no time".into()))?;
        let detail = self.event(&id, None)?;
        if detail.occurrence.recurring {
            return Err(Error::Invalid("this is a repeating event; change it in the calendar".into()));
        }
        let proposer = rx.meta.attendees.first().map(|a| a.email.clone()).unwrap_or_default();
        // A new time needs fresh answers, except from whoever asked for it.
        let mut ics: String = self.db.query_row("SELECT ics FROM events WHERE id = ?1", [&id], |r| r.get(0))?;
        for a in detail.attendees.iter().filter(|a| detail.organizer.as_ref().is_none_or(|o| !same(&o.email, &a.email))) {
            let status = if same(&a.email, &proposer) { "ACCEPTED" } else { "NEEDS-ACTION" };
            ics = itip::set_partstat(&ics, std::slice::from_ref(&a.email), status)?;
        }
        self.rewrite_event(&id, &ics, Self::edit_state(&c))?;
        let zone = detail.time_zone.clone().unwrap_or(tz);
        let input = EventInput {
            calendar_id: cal,
            title: detail.occurrence.title.clone(),
            location: detail.occurrence.location.clone(),
            notes: detail.notes.clone(),
            start: ical::local_input(proposed.start, &zone),
            end: ical::local_input(proposed.end, &zone),
            all_day: false,
            time_zone: zone,
            repeat: detail.repeat,
            reminders: None,
            attendees: Some(self.event_guests(&id)?),
            travel: None,
        };
        // The edit bumps SEQUENCE and, without CalDAV scheduling, emails the REQUEST.
        self.update_event(&id, &input, EditScope::All, None)?;
        self.set_setting(&format!("{COUNTER_ANSWER}{message_id}"), Some("accepted"))?;
        self.message_invite(message_id)?.ok_or_else(|| Error::NotFound("this message has no invitation".into()))
    }

    /// Keeps the original time: tells the proposer with a DECLINECOUNTER.
    pub fn decline_counter(&self, message_id: &str) -> Result<Invite> {
        let (rx, _, _) = self.counter_for(message_id)?;
        let guest = rx.meta.attendees.first().ok_or_else(|| Error::Parse("the proposal names no guest".into()))?;
        let to = crate::Address { name: guest.name.clone(), email: guest.email.clone() };
        let title = itip_title(&rx.ics);
        let who = rx.me.name.clone().unwrap_or_else(|| rx.me.email.clone());
        let body = format!("{who} kept the original time for “{title}”.");
        self.queue_itip(&rx.account_id, &[to], &format!("Time unchanged: {title}"), &body, "DECLINECOUNTER", itip::decline_counter(&rx.ics)?)?;
        self.set_setting(&format!("{COUNTER_ANSWER}{message_id}"), Some("declined"))?;
        self.message_invite(message_id)?.ok_or_else(|| Error::NotFound("this message has no invitation".into()))
    }

    /// Free stretches of `minutes` in your visible calendars, from `from`
    /// over the next two weeks, between `day_start` and `day_end` (minutes
    /// after local midnight), at most two a day, on the half hour.
    pub fn find_times(&self, from: i64, minutes: u32, day_start: u32, day_end: u32, weekdays_only: bool, limit: usize) -> Result<Vec<TimeSlot>> {
        let len = i64::from(minutes) * 60;
        if minutes == 0 || day_end <= day_start || day_end > 24 * 60 || i64::from(day_end - day_start) * 60 < len {
            return Err(Error::Invalid("that length doesn't fit in the day".into()));
        }
        let tz = self.time_zone()?;
        let from = round_up(from.max(now()), GRID);
        let mut busy: Vec<(i64, i64)> = self.occurrences(from, from + (FIND_DAYS + 1) * 86_400)?.into_iter().filter(|o| !o.all_day).map(|o| (o.start - o.travel.unwrap_or(0) * 60, o.end)).collect();
        busy.sort_unstable();
        let mut out = Vec::new();
        let first = ical::local_date(from, &tz);
        for day in first.iter_days().take(FIND_DAYS as usize) {
            use chrono::Datelike;
            if weekdays_only && day.weekday().number_from_monday() > 5 {
                continue;
            }
            let (Some(open), Some(close)) = (ical::local_to_utc(day, day_start, &tz), ical::local_to_utc(day, day_end, &tz)) else { continue };
            let mut at = round_up(open.max(from), GRID);
            let mut today = 0;
            while at + len <= close && today < 2 && out.len() < limit {
                match busy.iter().filter(|(s, e)| *s < at + len && *e > at).map(|(_, e)| *e).max() {
                    Some(end) => at = round_up(end, GRID),
                    None => {
                        out.push(TimeSlot { start: at, end: at + len });
                        today += 1;
                        // The next suggestion that day starts a while later, for choice.
                        at = round_up(at + len.max(2 * 3600), GRID);
                    }
                }
            }
            if out.len() >= limit {
                break;
            }
        }
        Ok(out)
    }

    pub fn calendar_sets(&self) -> Result<Vec<CalendarSet>> {
        Ok(self.setting(CALENDAR_SETS)?.map(from_json).unwrap_or_default())
    }

    /// Saves the calendars visible now as a named set (replacing one with that name).
    pub fn save_calendar_set(&self, name: &str) -> Result<Vec<CalendarSet>> {
        let name = name.trim();
        if name.is_empty() {
            return Err(Error::Invalid("give the set a name".into()));
        }
        let ids: Vec<String> = self.collections(CollectionKind::Calendar)?.into_iter().filter(|c| !c.hidden).map(|c| c.id).collect();
        if ids.is_empty() {
            return Err(Error::Invalid("show at least one calendar first".into()));
        }
        let mut sets = self.calendar_sets()?;
        match sets.iter_mut().find(|s| s.name.eq_ignore_ascii_case(name)) {
            Some(s) => s.calendar_ids = ids,
            None => sets.push(CalendarSet { id: uuid::Uuid::new_v4().to_string(), name: name.to_string(), calendar_ids: ids }),
        }
        self.set_setting(CALENDAR_SETS, Some(&json(&sets)))?;
        Ok(sets)
    }

    pub fn delete_calendar_set(&self, id: &str) -> Result<Vec<CalendarSet>> {
        let mut sets = self.calendar_sets()?;
        sets.retain(|s| s.id != id);
        self.set_setting(CALENDAR_SETS, Some(&json(&sets)))?;
        Ok(sets)
    }

    /// Shows exactly the set's calendars and hides the rest. A calendar
    /// added after the set was saved is hidden too until the set is saved again.
    pub fn apply_calendar_set(&self, id: &str) -> Result<()> {
        let set = self.calendar_sets()?.into_iter().find(|s| s.id == id).ok_or_else(|| Error::NotFound("that calendar set was deleted".into()))?;
        for c in self.collections(CollectionKind::Calendar)? {
            self.set_collection_hidden(&c.id, !set.calendar_ids.contains(&c.id))?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AccountConfig, Address, Provider, RemoteCollection, Repeat, Security, ServerConfig, store::INBOX};

    fn setup() -> (Store, String, String) {
        let s = Store::open_in_memory().unwrap();
        s.set_time_zone("Europe/Lisbon").unwrap();
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
        let work = RemoteCollection { href: "/cal/work/".into(), kind: CollectionKind::Calendar, name: "Work".into(), color: None, writable: true, scheduling: false };
        s.sync_collections(&acct, CollectionKind::Calendar, &[work]).unwrap();
        let cal = s.collections(CollectionKind::Calendar).unwrap().into_iter().find(|c| c.account_id.is_some()).unwrap().id;
        (s, acct, cal)
    }

    fn ev(cal: &str, title: &str, start: &str, end: &str, guests: Option<Vec<Address>>) -> EventInput {
        EventInput {
            calendar_id: cal.into(),
            title: title.into(),
            location: None,
            notes: None,
            start: start.into(),
            end: end.into(),
            all_day: false,
            time_zone: "Europe/Lisbon".into(),
            repeat: Repeat::None,
            reminders: None,
            attendees: guests,
            travel: None,
        }
    }

    fn mail(method: &str, from: &str, uid: &str, people: &str, times: &str) -> Vec<u8> {
        let ics = format!(
            "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Other//EN\r\nMETHOD:{method}\r\nBEGIN:VEVENT\r\nUID:{uid}\r\nSEQUENCE:1\r\nDTSTAMP:20261010T100000Z\r\n{times}SUMMARY:Design crit\r\n{people}END:VEVENT\r\nEND:VCALENDAR\r\n"
        );
        format!(
            "From: {from}\r\nTo: me@studio.example\r\nSubject: Design crit\r\nMessage-ID: <{method}.{}@other.example>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nSee calendar.\r\n--b\r\nContent-Type: text/calendar; method={method}; charset=utf-8\r\n\r\n{ics}\r\n--b--\r\n",
            uuid::Uuid::new_v4()
        )
        .into_bytes()
    }

    fn sent(s: &Store) -> Vec<(String, Vec<String>, String)> {
        s.outbox().unwrap().into_iter().filter_map(|o| o.draft.calendar.map(|c| (c.method, o.draft.to.into_iter().map(|a| a.email).collect(), c.ics))).collect()
    }

    const PRIYA_INVITES: &str = "ORGANIZER;CN=Priya Raman:mailto:priya@studio.example\r\nATTENDEE;PARTSTAT=ACCEPTED:mailto:priya@studio.example\r\nATTENDEE;CN=Me;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:me@studio.example\r\n";
    // 20 Oct 2026, 13:00–14:00 UTC (14:00–15:00 in Lisbon).
    const AT_TWO: &str = "DTSTART:20261020T130000Z\r\nDTEND:20261020T140000Z\r\n";

    #[test]
    fn invitations_show_what_they_clash_with() {
        let (s, acct, cal) = setup();
        s.create_event(&ev(&cal, "Kiln firing", "2026-10-20T14:30", "2026-10-20T16:00", None)).unwrap();
        s.create_event(&ev(&cal, "Lunch", "2026-10-20T12:00", "2026-10-20T13:00", None)).unwrap();
        let m = s.insert_local(&acct, INBOX, &mail("REQUEST", "Priya Raman <priya@studio.example>", "crit-1", PRIYA_INVITES, AT_TWO), false).unwrap();
        let inv = s.message_invite(&m).unwrap().unwrap();
        assert_eq!(inv.conflicts.iter().map(|o| o.title.as_str()).collect::<Vec<_>>(), vec!["Kiln firing"], "overlap only; Lunch ends before it");

        // Once accepted, its own copy doesn't count as a clash.
        s.respond_to_invite(&m, crate::InviteResponse::Accepted, None).unwrap();
        assert_eq!(s.message_invite(&m).unwrap().unwrap().conflicts.len(), 1);
    }

    #[test]
    fn guests_propose_a_new_time() {
        let (s, acct, _) = setup();
        let m = s.insert_local(&acct, INBOX, &mail("REQUEST", "Priya Raman <priya@studio.example>", "crit-1", PRIYA_INVITES, AT_TWO), false).unwrap();
        let inv = s.propose_time(&m, 1_792_508_400, 1_792_512_000, Some("Kiln's on at 2")).unwrap();
        assert_eq!(inv.proposed, Some(TimeSlot { start: 1_792_508_400, end: 1_792_512_000 }), "the card remembers it");
        assert_eq!(inv.my_status.as_deref(), Some("needs-action"), "your answer is unchanged");
        let out = sent(&s);
        assert_eq!((out[0].0.as_str(), out[0].1.clone()), ("COUNTER", vec!["priya@studio.example".to_string()]));
        assert!(out[0].2.contains("DTSTART:20261020T150000Z") && out[0].2.contains("COMMENT:Kiln's on at 2"));
        let draft = &s.outbox().unwrap()[0].draft;
        assert!(draft.body.contains("2026-10-20 16:00–17:00 (Europe/Lisbon)") && draft.subject == "New time proposed: Design crit", "{}", draft.body);
    }

    #[test]
    fn organizers_take_or_turn_down_a_proposal() {
        let (s, acct, cal) = setup();
        let guests = vec![Address { name: Some("Sam".into()), email: "sam@studio.example".into() }, Address { name: None, email: "ana@example.com".into() }];
        let mine = s.create_event(&ev(&cal, "Design crit", "2026-10-20T14:00", "2026-10-20T15:00", Some(guests))).unwrap();
        let uid: String = s.db.query_row("SELECT uid FROM events WHERE id = ?1", [&mine.occurrence.event_id], |r| r.get(0)).unwrap();
        // Ana accepted the original time.
        let ics: String = s.db.query_row("SELECT ics FROM events WHERE id = ?1", [&mine.occurrence.event_id], |r| r.get(0)).unwrap();
        s.rewrite_event(&mine.occurrence.event_id, &itip::set_partstat(&ics, &["ana@example.com".into()], "ACCEPTED").unwrap(), "changed").unwrap();
        s.db.execute("DELETE FROM outbox", []).unwrap();

        let sam = "ORGANIZER:mailto:me@studio.example\r\nATTENDEE;CN=Sam;PARTSTAT=TENTATIVE:mailto:sam@studio.example\r\nCOMMENT:Can we do 4?\r\n";
        let four = "DTSTART:20261020T150000Z\r\nDTEND:20261020T160000Z\r\n";
        let c = s.insert_local(&acct, INBOX, &mail("COUNTER", "Sam <sam@studio.example>", &uid, sam, four), false).unwrap();
        let inv = s.message_invite(&c).unwrap().unwrap();
        assert_eq!((inv.method.as_str(), inv.from.as_ref().map(|f| f.email.as_str()), inv.comment.as_deref()), ("counter", Some("sam@studio.example"), Some("Can we do 4?")));
        assert_eq!((inv.current_start, inv.start), (Some(1_792_501_200), Some(1_792_508_400)), "now 14:00 Lisbon, proposed 16:00");
        assert!(inv.conflicts.is_empty(), "your own event isn't a clash with its new time");

        let after = s.accept_counter(&c).unwrap();
        assert_eq!(after.answered.as_deref(), Some("accepted"));
        let e = s.event(&mine.occurrence.event_id, None).unwrap();
        assert_eq!(e.occurrence.start, 1_792_508_400, "moved");
        let status = |who: &str| e.attendees.iter().find(|a| a.email == who).and_then(|a| a.status.clone());
        assert_eq!((status("sam@studio.example").as_deref(), status("ana@example.com").as_deref()), (Some("accepted"), Some("needs-action")), "asked again, except the proposer");
        let out = sent(&s);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].0, "REQUEST");
        assert_eq!(itip::read_invite(&out[0].2).unwrap().sequence, 1, "the update bumps SEQUENCE");

        // A second proposal, turned down.
        s.db.execute("DELETE FROM outbox", []).unwrap();
        let c2 = s.insert_local(&acct, INBOX, &mail("COUNTER", "Sam <sam@studio.example>", &uid, sam, AT_TWO), false).unwrap();
        assert_eq!(s.decline_counter(&c2).unwrap().answered.as_deref(), Some("declined"));
        let out = sent(&s);
        assert_eq!((out[0].0.as_str(), out[0].1.clone()), ("DECLINECOUNTER", vec!["sam@studio.example".to_string()]));
        assert_eq!(s.event(&mine.occurrence.event_id, None).unwrap().occurrence.start, 1_792_508_400, "the time stands");

        // Only the organizer decides.
        let theirs = s.insert_local(&acct, INBOX, &mail("COUNTER", "Sam <sam@studio.example>", "crit-1", sam.replace("me@studio", "priya@studio").as_str(), four), false).unwrap();
        assert!(s.accept_counter(&theirs).is_err());
    }

    #[test]
    fn find_a_time_skips_busy_hours_and_weekends() {
        let (s, _, cal) = setup();
        // Tue 4 Jun 2030; Lisbon is UTC+1 in June.
        s.create_event(&ev(&cal, "Standup", "2030-06-04T09:00", "2030-06-04T10:00", None)).unwrap();
        s.create_event(&ev(&cal, "Review", "2030-06-04T10:30", "2030-06-04T12:00", None)).unwrap();
        let tue = 1_906_761_600;
        let local = |t: i64| ical::local_input(t, "Europe/Lisbon");
        let slots: Vec<String> = s.find_times(tue, 60, 9 * 60, 17 * 60, true, 4).unwrap().into_iter().map(|t| local(t.start)).collect();
        assert_eq!(slots, vec!["2030-06-04T12:00", "2030-06-04T14:00", "2030-06-05T09:00", "2030-06-05T11:00"]);
        // Friday at 4 (local): the next ones skip the weekend.
        let fri = tue + 3 * 86_400 + 15 * 3600;
        let next: Vec<String> = s.find_times(fri, 90, 9 * 60, 17 * 60, true, 2).unwrap().into_iter().map(|t| local(t.start)).collect();
        assert_eq!(next, vec!["2030-06-10T09:00", "2030-06-10T11:00"], "90 minutes don't fit before 5 on Friday; Monday next");
        assert!(s.find_times(tue, 600, 9 * 60, 17 * 60, true, 2).is_err(), "longer than the day");

        // Travel time before an event is busy too: 12:00 is gone when getting to a 13:30 takes an hour.
        let mut away = ev(&cal, "Site visit", "2030-06-04T13:30", "2030-06-04T14:00", None);
        away.travel = Some(60);
        s.create_event(&away).unwrap();
        let slots: Vec<String> = s.find_times(tue, 60, 9 * 60, 17 * 60, true, 2).unwrap().into_iter().map(|t| local(t.start)).collect();
        assert_eq!(slots, vec!["2030-06-04T14:00", "2030-06-04T16:00"], "noon is gone: that hour is spent getting to the visit");
    }

    #[test]
    fn calendar_sets_switch_what_shows() {
        let (s, _, work) = setup();
        let local = s.collections(CollectionKind::Calendar).unwrap().into_iter().find(|c| c.account_id.is_none() && c.id != "birthdays").unwrap().id;
        s.set_collection_hidden(&local, true).unwrap();
        let sets = s.save_calendar_set("Work").unwrap();
        assert!(sets[0].calendar_ids.contains(&work) && !sets[0].calendar_ids.contains(&local));
        s.set_collection_hidden(&local, false).unwrap();
        s.set_collection_hidden(&work, true).unwrap();
        s.save_calendar_set("Personal").unwrap();
        // Saving under the same name replaces it.
        assert_eq!(s.save_calendar_set("personal").unwrap().len(), 2);

        let work_set = s.calendar_sets().unwrap().into_iter().find(|x| x.name == "Work").unwrap();
        s.apply_calendar_set(&work_set.id).unwrap();
        let hidden = |id: &str| s.collections(CollectionKind::Calendar).unwrap().into_iter().find(|c| c.id == id).unwrap().hidden;
        assert!(!hidden(&work) && hidden(&local));
        assert_eq!(s.delete_calendar_set(&work_set.id).unwrap().len(), 1);
        assert!(s.apply_calendar_set(&work_set.id).is_err());
    }
}
