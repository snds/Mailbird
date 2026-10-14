//! Meeting invitations: iTIP (RFC 5546) messages carried by email (iMIP,
//! RFC 6047). Reading an invitation, answering it, and writing the
//! REQUEST / CANCEL an organizer sends, and the COUNTER a guest sends to
//! propose another time (with the organizer's DECLINECOUNTER).
//!
//! Servers with CalDAV scheduling (RFC 6638, `calendar-auto-schedule`) send
//! these messages themselves when an event they hold changes; the store
//! only emails them for calendars on servers without it.

use calcard::icalendar::{ICalendar, ICalendarComponentType, ICalendarParameterName, ICalendarProperty, ICalendarValue};
use chrono::DateTime;

use crate::{Address, Attendee, Error, Result};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InviteMeta {
    /// "REQUEST", "CANCEL", "REPLY", …
    pub method: String,
    pub uid: String,
    pub sequence: i64,
    pub organizer: Option<Address>,
    pub attendees: Vec<Attendee>,
    /// COMMENT: a guest's note with a counter-proposal or a reply.
    pub comment: Option<String>,
    /// The master has an RRULE.
    pub recurring: bool,
}

fn parse(ics: &str) -> Result<ICalendar> {
    ICalendar::parse(ics).map_err(|_| Error::Parse("not a valid invitation".into()))
}

fn finish(cal: ICalendar) -> String {
    cal.to_string().replace("\r\n", "\n").replace('\n', "\r\n")
}

fn addr(e: &calcard::icalendar::ICalendarEntry) -> Option<Address> {
    let email = e.calendar_address()?.to_string();
    let name = e.parameter(&ICalendarParameterName::Cn).and_then(|v| v.as_text()).map(str::to_owned);
    Some(Address { name, email })
}

fn same(a: &str, b: &str) -> bool {
    a.trim().eq_ignore_ascii_case(b.trim())
}

/// Text for a parameter value, quoted when it must be.
fn param(v: &str) -> String {
    let clean = v.replace('"', "'");
    if clean.contains([',', ';', ':', ' ']) { format!("\"{clean}\"") } else { clean }
}

fn attendee_line(a: &Address, status: &str, rsvp: bool) -> String {
    let cn = a.name.as_deref().filter(|n| !n.trim().is_empty()).map(|n| format!(";CN={}", param(n))).unwrap_or_default();
    let rsvp = if rsvp { ";RSVP=TRUE" } else { "" };
    format!("ATTENDEE{cn};ROLE=REQ-PARTICIPANT;PARTSTAT={status}{rsvp}:mailto:{}", a.email.trim())
}

fn organizer_line(a: &Address) -> String {
    let cn = a.name.as_deref().filter(|n| !n.trim().is_empty()).map(|n| format!(";CN={}", param(n))).unwrap_or_default();
    format!("ORGANIZER{cn}:mailto:{}", a.email.trim())
}

fn entries(lines: &[String]) -> Result<Vec<calcard::icalendar::ICalendarEntry>> {
    let body: String = lines.iter().map(|l| format!("{l}\r\n")).collect();
    let cal = parse(&format!("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\n{body}END:VEVENT\r\nEND:VCALENDAR\r\n"))?;
    Ok(cal.components.into_iter().find(|c| c.component_type == ICalendarComponentType::VEvent).map(|c| c.entries).unwrap_or_default())
}

fn stamp_now() -> String {
    DateTime::from_timestamp(crate::now(), 0).unwrap_or_default().format("%Y%m%dT%H%M%SZ").to_string()
}

/// The iTIP method and who's involved, from the first VEVENT.
pub fn read_invite(ics: &str) -> Result<InviteMeta> {
    let cal = parse(ics)?;
    let method = cal
        .components
        .iter()
        .find(|c| c.component_type == ICalendarComponentType::VCalendar)
        .and_then(|c| c.property(&ICalendarProperty::Method))
        .and_then(|e| e.values.first())
        .and_then(|v| v.as_text())
        .unwrap_or("PUBLISH")
        .to_ascii_uppercase();
    let ev = cal
        .components
        .iter()
        .find(|c| c.component_type == ICalendarComponentType::VEvent && !c.has_property(&ICalendarProperty::RecurrenceId))
        .or_else(|| cal.components.iter().find(|c| c.component_type == ICalendarComponentType::VEvent))
        .ok_or_else(|| Error::Parse("the invitation has no event".into()))?;
    Ok(InviteMeta {
        method,
        uid: ev.uid().unwrap_or_default().to_string(),
        sequence: ev
            .property(&ICalendarProperty::Sequence)
            .and_then(|e| e.values.first())
            .and_then(|v| if let ICalendarValue::Integer(n) = v { Some(*n) } else { None })
            .unwrap_or(0),
        organizer: ev.property(&ICalendarProperty::Organizer).and_then(addr),
        attendees: ev
            .properties(&ICalendarProperty::Attendee)
            .filter_map(|e| {
                let a = addr(e)?;
                let status = e.parameter(&ICalendarParameterName::Partstat).and_then(|v| v.as_text()).map(|s| s.to_ascii_lowercase());
                Some(Attendee { name: a.name, email: a.email, status })
            })
            .collect(),
        comment: ev.property(&ICalendarProperty::Comment).and_then(|e| e.values.first()).and_then(|v| v.as_text()).map(str::to_owned).filter(|c| !c.trim().is_empty()),
        recurring: ev.has_property(&ICalendarProperty::Rrule),
    })
}

fn utc(ts: i64) -> String {
    DateTime::from_timestamp(ts, 0).unwrap_or_default().format("%Y%m%dT%H%M%SZ").to_string()
}

/// One VEVENT's worth of lines as an iTIP message with `method`.
fn message(method: &str, lines: &[String]) -> Result<String> {
    let body: String = lines.iter().map(|l| format!("{l}\r\n")).collect();
    let text = format!("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Mailbird//EN\r\nMETHOD:{method}\r\nBEGIN:VEVENT\r\n{body}END:VEVENT\r\nEND:VCALENDAR\r\n");
    // Round-trip so the result is known-valid and canonically folded.
    Ok(finish(parse(&text)?))
}

/// A guest's METHOD:COUNTER (RFC 5546 §3.2.7): the invitation with another
/// time, sent to the organizer, who accepts or declines it. Only for single
/// events: proposing a new time for a whole series isn't something people do.
pub fn counter(ics: &str, me: &Address, start: i64, end: i64, comment: Option<&str>) -> Result<String> {
    let m = read_invite(ics)?;
    if m.recurring {
        return Err(Error::Invalid("you can propose a new time for a single event, not a series".into()));
    }
    if end <= start {
        return Err(Error::Invalid("the new time ends before it starts".into()));
    }
    let org = m.organizer.as_ref().ok_or_else(|| Error::Invalid("this invitation has no organizer to ask".into()))?;
    let cal = parse(ics)?;
    let ev = cal.components.iter().find(|c| c.component_type == ICalendarComponentType::VEvent).ok_or_else(|| Error::Parse("the invitation has no event".into()))?;
    let status = m.attendees.iter().find(|a| same(&a.email, &me.email)).and_then(|a| a.status.clone()).unwrap_or_else(|| "needs-action".into());
    let mut lines = vec![format!("UID:{}", m.uid), format!("SEQUENCE:{}", m.sequence), format!("DTSTAMP:{}", stamp_now()), organizer_line(org)];
    lines.push(attendee_line(me, &status.to_ascii_uppercase(), false));
    for prop in [ICalendarProperty::Summary, ICalendarProperty::Location] {
        if let Some(v) = ev.property(&prop).and_then(|e| e.values.first()).and_then(|v| v.as_text()) {
            lines.push(format!("{}:{}", prop.as_str(), crate::ical::esc(v)));
        }
    }
    lines.push(format!("DTSTART:{}", utc(start)));
    lines.push(format!("DTEND:{}", utc(end)));
    if let Some(c) = comment.map(str::trim).filter(|c| !c.is_empty()) {
        lines.push(format!("COMMENT:{}", crate::ical::esc(c)));
    }
    message("COUNTER", &lines)
}

/// The organizer's METHOD:DECLINECOUNTER: the original time stands.
pub fn decline_counter(counter_ics: &str) -> Result<String> {
    let m = read_invite(counter_ics)?;
    let org = m.organizer.as_ref().ok_or_else(|| Error::Parse("the proposal names no organizer".into()))?;
    let guest = m.attendees.first().ok_or_else(|| Error::Parse("the proposal names no guest".into()))?;
    let who = Address { name: guest.name.clone(), email: guest.email.clone() };
    let lines = vec![format!("UID:{}", m.uid), format!("SEQUENCE:{}", m.sequence), format!("DTSTAMP:{}", stamp_now()), organizer_line(org), attendee_line(&who, "NEEDS-ACTION", false)];
    message("DECLINECOUNTER", &lines)
}

/// The calendar object to store from an invitation: CalDAV forbids METHOD
/// in stored resources (RFC 4791 §4.1).
pub fn strip_method(ics: &str) -> Result<String> {
    let mut cal = parse(ics)?;
    for c in cal.components.iter_mut().filter(|c| c.component_type == ICalendarComponentType::VCalendar) {
        c.entries.retain(|e| e.name != ICalendarProperty::Method);
    }
    Ok(finish(cal))
}

/// Sets PARTSTAT ("ACCEPTED", "TENTATIVE", "DECLINED") for every ATTENDEE
/// line matching one of `me`, in the series and each override.
pub fn set_partstat(ics: &str, me: &[String], status: &str) -> Result<String> {
    let mut cal = parse(ics)?;
    let mut found = false;
    for c in cal.components.iter_mut().filter(|c| c.component_type == ICalendarComponentType::VEvent) {
        for e in c.entries.iter_mut().filter(|e| e.name == ICalendarProperty::Attendee) {
            let Some(who) = addr(e) else { continue };
            if !me.iter().any(|m| same(m, &who.email)) {
                continue;
            }
            found = true;
            // Rebuild the line with the new status; RSVP is answered now.
            let rebuilt = entries(&[attendee_line(&who, status, false)])?;
            let mut fresh = rebuilt.into_iter().next().ok_or_else(|| Error::Parse("bad attendee".into()))?;
            // Keep the other parameters (ROLE, CUTYPE, DELEGATED-FROM…) the organizer set.
            for p in &e.params {
                if !matches!(p.name, ICalendarParameterName::Partstat | ICalendarParameterName::Rsvp | ICalendarParameterName::Cn | ICalendarParameterName::Role)
                {
                    fresh.params.push(p.clone());
                }
            }
            if let Some(role) = e.params.iter().find(|p| p.name == ICalendarParameterName::Role) {
                fresh.params.retain(|p| p.name != ICalendarParameterName::Role);
                fresh.params.push(role.clone());
            }
            *e = fresh;
        }
    }
    if !found {
        return Err(Error::Invalid("you aren't on this invitation's guest list".into()));
    }
    Ok(finish(cal))
}

/// A METHOD:REPLY for `me`, answering every VEVENT in the invitation.
pub fn reply(ics: &str, me: &Address, status: &str) -> Result<String> {
    let cal = parse(ics)?;
    let mut out = String::from("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Mailbird//EN\r\nMETHOD:REPLY\r\n");
    for c in cal.components.iter().filter(|c| c.component_type == ICalendarComponentType::VEvent) {
        let mut lines = vec![format!("UID:{}", c.uid().unwrap_or_default()), format!("DTSTAMP:{}", stamp_now())];
        out.push_str("BEGIN:VEVENT\r\n");
        for l in lines.drain(..) {
            out.push_str(&l);
            out.push_str("\r\n");
        }
        // Echo what identifies the event and the occurrence.
        let keep = [ICalendarProperty::Sequence, ICalendarProperty::RecurrenceId, ICalendarProperty::Dtstart, ICalendarProperty::Dtend, ICalendarProperty::Summary, ICalendarProperty::Organizer];
        let mut part = ICalendar { components: vec![c.clone()] };
        part.components[0].entries.retain(|e| keep.contains(&e.name));
        part.components[0].component_ids.clear();
        let body = part.to_string();
        out.push_str(body.trim_start_matches("BEGIN:VEVENT").trim_end().trim_end_matches("END:VEVENT").trim_matches(['\r', '\n']));
        out.push_str("\r\n");
        out.push_str(&attendee_line(me, status, false));
        out.push_str("\r\nEND:VEVENT\r\n");
    }
    out.push_str("END:VCALENDAR\r\n");
    // Round-trip so the result is known-valid and canonically folded.
    Ok(finish(parse(&out)?))
}

/// Who an event invites, and who organizes it (from the master).
pub fn people(ics: &str) -> Result<(Option<Address>, Vec<Attendee>)> {
    let m = read_invite(ics)?;
    Ok((m.organizer, m.attendees))
}

/// Sets the organizer and guest list on the series and each override.
/// Guests already on the list keep their answer; new ones are asked to RSVP.
/// An empty list removes both, making it a plain event again.
pub fn set_attendees(ics: &str, organizer: &Address, guests: &[Address]) -> Result<String> {
    let mut cal = parse(ics)?;
    for c in cal.components.iter_mut().filter(|c| c.component_type == ICalendarComponentType::VEvent) {
        let before: Vec<Attendee> = c
            .properties(&ICalendarProperty::Attendee)
            .filter_map(|e| {
                let a = addr(e)?;
                Some(Attendee { name: a.name, email: a.email, status: e.parameter(&ICalendarParameterName::Partstat).and_then(|v| v.as_text()).map(str::to_owned) })
            })
            .collect();
        c.entries.retain(|e| !matches!(e.name, ICalendarProperty::Attendee | ICalendarProperty::Organizer));
        if guests.is_empty() {
            continue;
        }
        let mut lines = vec![organizer_line(organizer)];
        // The organizer is a participant too, already accepted.
        lines.push(attendee_line(organizer, "ACCEPTED", false));
        for g in guests.iter().filter(|g| !same(&g.email, &organizer.email)) {
            match before.iter().find(|b| same(&b.email, &g.email)) {
                Some(b) => lines.push(attendee_line(g, b.status.as_deref().unwrap_or("NEEDS-ACTION"), false)),
                None => lines.push(attendee_line(g, "NEEDS-ACTION", true)),
            }
        }
        c.entries.extend(entries(&lines)?);
    }
    Ok(finish(cal))
}

/// The message an organizer sends: METHOD:REQUEST with the full event, or
/// METHOD:CANCEL (with STATUS:CANCELLED and a bumped SEQUENCE).
pub fn organizer_message(ics: &str, method: &str) -> Result<String> {
    let mut cal = parse(ics)?;
    let cancel = method.eq_ignore_ascii_case("CANCEL");
    for c in cal.components.iter_mut() {
        match c.component_type {
            ICalendarComponentType::VCalendar => c.entries.retain(|e| e.name != ICalendarProperty::Method),
            ICalendarComponentType::VEvent if cancel => {
                let seq = c
                    .property(&ICalendarProperty::Sequence)
                    .and_then(|e| e.values.first())
                    .and_then(|v| if let ICalendarValue::Integer(n) = v { Some(*n) } else { None })
                    .unwrap_or(0);
                c.entries.retain(|e| !matches!(e.name, ICalendarProperty::Status | ICalendarProperty::Sequence));
                c.entries.extend(entries(&["STATUS:CANCELLED".into(), format!("SEQUENCE:{}", seq + 1)])?);
            }
            _ => {}
        }
    }
    // METHOD lives on VCALENDAR; insert it as text after VERSION.
    let text = finish(cal);
    Ok(text.replacen("VERSION:2.0\r\n", &format!("VERSION:2.0\r\nMETHOD:{}\r\n", method.to_ascii_uppercase()), 1))
}

#[cfg(test)]
mod tests {
    use super::*;

    const INVITE: &str = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Other//EN\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:inv-1@other.example\r\nSEQUENCE:2\r\nDTSTAMP:20261010T100000Z\r\nDTSTART:20261020T130000Z\r\nDTEND:20261020T140000Z\r\nSUMMARY:Design crit\r\nORGANIZER;CN=Priya Raman:mailto:priya@studio.example\r\nATTENDEE;CN=Priya Raman;PARTSTAT=ACCEPTED:mailto:priya@studio.example\r\nATTENDEE;CN=Me;ROLE=OPT-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CUTYPE=INDIVIDUAL:mailto:Me@Studio.example\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

    #[test]
    fn reads_the_method_and_people() {
        let m = read_invite(INVITE).unwrap();
        assert_eq!((m.method.as_str(), m.uid.as_str(), m.sequence), ("REQUEST", "inv-1@other.example", 2));
        assert_eq!(m.organizer.unwrap().email, "priya@studio.example");
        assert_eq!(m.attendees[1].status.as_deref(), Some("needs-action"));
    }

    #[test]
    fn answering_updates_only_my_line_and_keeps_its_parameters() {
        let mine = set_partstat(INVITE, &["me@studio.example".into()], "ACCEPTED").unwrap();
        let m = read_invite(&mine).unwrap();
        assert_eq!(m.attendees[1].status.as_deref(), Some("accepted"), "matched case-insensitively");
        assert_eq!(m.attendees[0].status.as_deref(), Some("accepted"), "organizer untouched");
        assert!(mine.contains("ROLE=OPT-PARTICIPANT") && mine.contains("CUTYPE=INDIVIDUAL"), "{mine}");
        assert!(!mine.contains("RSVP=TRUE"));
        assert!(set_partstat(INVITE, &["stranger@example.com".into()], "ACCEPTED").is_err());
        let stored = strip_method(&mine).unwrap();
        assert!(!stored.contains("METHOD:"), "CalDAV objects carry no METHOD");
    }

    #[test]
    fn replies_carry_uid_sequence_and_one_attendee() {
        let me = Address { name: Some("Me".into()), email: "me@studio.example".into() };
        let r = reply(INVITE, &me, "TENTATIVE").unwrap();
        let m = read_invite(&r).unwrap();
        assert_eq!((m.method.as_str(), m.uid.as_str(), m.sequence), ("REPLY", "inv-1@other.example", 2));
        assert_eq!(m.attendees.len(), 1);
        assert_eq!(m.attendees[0].status.as_deref(), Some("tentative"));
        assert_eq!(m.organizer.unwrap().email, "priya@studio.example");
        assert!(r.contains("DTSTART:20261020T130000Z"));
    }

    #[test]
    fn counters_and_declines() {
        let me = Address { name: Some("Me".into()), email: "me@studio.example".into() };
        // 20 Oct 2026 15:00–16:00 UTC instead of 13:00–14:00.
        let c = counter(INVITE, &me, 1_792_508_400, 1_792_512_000, Some("Clashes with standup; does 3 work?")).unwrap();
        let m = read_invite(&c).unwrap();
        assert_eq!((m.method.as_str(), m.uid.as_str(), m.sequence), ("COUNTER", "inv-1@other.example", 2));
        assert_eq!(m.attendees.len(), 1, "only the proposer");
        assert_eq!(m.organizer.unwrap().email, "priya@studio.example");
        assert_eq!(m.comment.as_deref(), Some("Clashes with standup; does 3 work?"));
        assert!(c.contains("DTSTART:20261020T150000Z") && c.contains("DTEND:20261020T160000Z") && c.contains("SUMMARY:Design crit"), "{c}");
        assert!(counter(INVITE, &me, 10, 5, None).is_err(), "ends before it starts");
        let series = INVITE.replace("SUMMARY:Design crit", "SUMMARY:Design crit\r\nRRULE:FREQ=WEEKLY");
        assert!(counter(&series, &me, 1_792_508_400, 1_792_512_000, None).is_err(), "not for a series");

        let d = decline_counter(&c).unwrap();
        let m = read_invite(&d).unwrap();
        assert_eq!((m.method.as_str(), m.uid.as_str()), ("DECLINECOUNTER", "inv-1@other.example"));
        assert_eq!(m.attendees[0].email, "me@studio.example");
    }

    #[test]
    fn organizers_set_guests_and_send_requests_or_cancels() {
        let plain = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:e1\r\nSEQUENCE:0\r\nDTSTART:20261020T130000Z\r\nDTEND:20261020T140000Z\r\nSUMMARY:Lunch\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let me = Address { name: Some("Sean D".into()), email: "me@studio.example".into() };
        let ana = Address { name: Some("Ana, D.".into()), email: "ana@example.com".into() };
        let invited = set_attendees(plain, &me, std::slice::from_ref(&ana)).unwrap();
        let (org, people) = people(&invited).unwrap();
        assert_eq!(org.unwrap().email, "me@studio.example");
        assert_eq!(people.len(), 2, "organizer is a participant too");
        assert_eq!(people[1].name.as_deref(), Some("Ana, D."), "commas in names survive quoting");
        assert!(invited.contains("RSVP=TRUE"));

        // Ana answered; adding Marcus keeps her answer.
        let answered = set_partstat(&invited, &["ana@example.com".into()], "ACCEPTED").unwrap();
        let marcus = Address { name: None, email: "marcus@example.com".into() };
        let more = set_attendees(&answered, &me, &[ana.clone(), marcus]).unwrap();
        let (_, people) = super::people(&more).unwrap();
        assert_eq!(people.iter().find(|a| a.email == "ana@example.com").unwrap().status.as_deref(), Some("accepted"));
        assert_eq!(people.len(), 3);

        let req = organizer_message(&more, "REQUEST").unwrap();
        assert_eq!(read_invite(&req).unwrap().method, "REQUEST");
        let cancel = organizer_message(&more, "CANCEL").unwrap();
        let c = read_invite(&cancel).unwrap();
        assert_eq!((c.method.as_str(), c.sequence), ("CANCEL", 1));
        assert!(cancel.contains("STATUS:CANCELLED"));

        let cleared = set_attendees(&more, &me, &[]).unwrap();
        assert!(!cleared.contains("ATTENDEE") && !cleared.contains("ORGANIZER"));
    }
}
