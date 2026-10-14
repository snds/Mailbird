//! iCalendar (RFC 5545) events: reading, recurrence expansion, and writing.
//!
//! Parsing, time zones, and recurrence come from `calcard`. Writes never
//! rebuild an event from scratch: edits splice new properties into the parsed
//! original, so alarms, attendees, and properties we don't model survive the
//! round trip.

use std::str::FromStr;

use calcard::common::timezone::Tz;
use calcard::icalendar::{
    ICalendar, ICalendarComponent, ICalendarComponentType, ICalendarEntry, ICalendarFrequency, ICalendarParameterName,
    ICalendarProperty, ICalendarValue,
};
use chrono::DateTime;

use crate::model::{Address, Attendee, EventInput, Repeat};
use crate::{Error, Result};

/// Upper bound on generated occurrences per event. Expansion walks from the
/// first occurrence, so this also bounds how far a daily series reaches
/// (about 27 years); a window past that shows nothing rather than hanging.
const EXPAND_LIMIT: usize = 10_000;

/// What the store indexes about one calendar object resource.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventMeta {
    pub uid: String,
    pub title: String,
    pub location: Option<String>,
    pub notes: Option<String>,
    pub all_day: bool,
    pub recurring: bool,
    pub repeat: Repeat,
    pub time_zone: Option<String>,
    /// Start of the first occurrence (Unix seconds).
    pub first_start: i64,
    /// End of the last occurrence, or `None` for a series with no end.
    pub last_end: Option<i64>,
    pub organizer: Option<Address>,
    pub attendees: Vec<Attendee>,
    pub url: Option<String>,
}

/// One occurrence of an event, in absolute time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Instance {
    pub start: i64,
    pub end: i64,
    pub title: String,
    pub location: Option<String>,
}

fn parse(ics: &str) -> Result<ICalendar> {
    ICalendar::parse(ics).map_err(|_| Error::Parse("not a valid iCalendar event".into()))
}

/// An IANA zone; unknown names fall back to UTC rather than floating time.
fn tz(name: &str) -> Tz {
    Tz::from_str(name).or_else(|_| Tz::from_str("UTC")).unwrap_or_default()
}

fn text(c: &ICalendarComponent, prop: ICalendarProperty) -> Option<String> {
    c.property(&prop).and_then(|e| e.values.first()).and_then(|v| v.as_text()).map(str::to_owned).filter(|s| !s.trim().is_empty())
}

/// The series master: the VEVENT without a RECURRENCE-ID (or the first VEVENT).
fn master_index(cal: &ICalendar) -> Option<usize> {
    let events = || cal.components.iter().enumerate().filter(|(_, c)| c.component_type == ICalendarComponentType::VEvent);
    events().find(|(_, c)| !c.has_property(&ICalendarProperty::RecurrenceId)).or_else(|| events().next()).map(|(i, _)| i)
}

fn is_date_only(c: &ICalendarComponent) -> bool {
    matches!(
        c.property(&ICalendarProperty::Dtstart).and_then(|e| e.values.first()),
        Some(ICalendarValue::PartialDateTime(dt)) if !dt.has_time()
    )
}

fn repeat_of(c: &ICalendarComponent) -> Repeat {
    let Some(ICalendarValue::RecurrenceRule(rule)) = c.property(&ICalendarProperty::Rrule).and_then(|e| e.values.first()) else {
        return Repeat::None;
    };
    // Only the plain "every day/week/month/year" rules are editable as such;
    // anything richer (intervals, BYDAY lists, counts) is kept as-is.
    let plain = rule.interval.is_none_or(|i| i == 1)
        && rule.count.is_none()
        && rule.until.is_none()
        && rule.byday.is_empty()
        && rule.bymonthday.is_empty()
        && rule.bymonth.is_empty()
        && rule.bysetpos.is_empty();
    match (plain, &rule.freq) {
        (true, ICalendarFrequency::Daily) => Repeat::Daily,
        (true, ICalendarFrequency::Weekly) => Repeat::Weekly,
        (true, ICalendarFrequency::Monthly) => Repeat::Monthly,
        (true, ICalendarFrequency::Yearly) => Repeat::Yearly,
        _ => Repeat::Custom,
    }
}

fn person(e: &ICalendarEntry) -> Option<Address> {
    let email = e.calendar_address()?.to_string();
    let name = e.parameter(&ICalendarParameterName::Cn).and_then(|v| v.as_text()).map(str::to_owned);
    Some(Address { name, email })
}

fn expand_all(cal: &ICalendar, local_tz: &str) -> Vec<Instance> {
    let exp = cal.expand_dates(tz(local_tz), EXPAND_LIMIT);
    exp.events
        .into_iter()
        .filter_map(|e| {
            let c = cal.components.get(e.comp_id as usize)?;
            if c.component_type != ICalendarComponentType::VEvent {
                return None;
            }
            let start = e.start.timestamp();
            let end = match e.end {
                calcard::icalendar::dates::TimeOrDelta::Time(t) => t.timestamp(),
                calcard::icalendar::dates::TimeOrDelta::Delta(d) => (e.start + d).timestamp(),
            };
            // A missing DTEND means a zero-length event, or one day for all-day ones.
            let end = if end > start { end } else if is_date_only(c) { start + 86_400 } else { start };
            Some(Instance { start, end, title: text(c, ICalendarProperty::Summary).unwrap_or_default(), location: text(c, ICalendarProperty::Location) })
        })
        .collect()
}

/// Reads what the store indexes. `local_tz` (IANA name) places floating times
/// and all-day dates on this device's clock.
pub fn read_event(ics: &str, local_tz: &str) -> Result<EventMeta> {
    let cal = parse(ics)?;
    let i = master_index(&cal).ok_or_else(|| Error::Parse("no event in this calendar object".into()))?;
    let c = &cal.components[i];
    let instances = expand_all(&cal, local_tz);
    let first_start = instances.iter().map(|o| o.start).min().ok_or_else(|| Error::Parse("event has no valid start".into()))?;
    let recurring = c.is_recurrent();
    // An endless rule (or one we stopped expanding) has no last occurrence.
    let last_end = if recurring && (instances.len() >= EXPAND_LIMIT || rrule_unbounded(c)) {
        None
    } else {
        instances.iter().map(|o| o.end).max()
    };
    Ok(EventMeta {
        uid: c.uid().unwrap_or_default().to_string(),
        title: text(c, ICalendarProperty::Summary).unwrap_or_default(),
        location: text(c, ICalendarProperty::Location),
        notes: text(c, ICalendarProperty::Description),
        all_day: is_date_only(c),
        recurring,
        repeat: repeat_of(c),
        time_zone: c.property(&ICalendarProperty::Dtstart).and_then(|e| e.tz_id()).map(str::to_owned),
        first_start,
        last_end,
        organizer: c.property(&ICalendarProperty::Organizer).and_then(person),
        attendees: c
            .properties(&ICalendarProperty::Attendee)
            .filter_map(|e| {
                let who = person(e)?;
                let status = e.parameter(&ICalendarParameterName::Partstat).and_then(|v| v.as_text()).map(|s| s.to_ascii_lowercase());
                Some(Attendee { name: who.name, email: who.email, status })
            })
            .collect(),
        url: text(c, ICalendarProperty::Url),
    })
}

fn rrule_unbounded(c: &ICalendarComponent) -> bool {
    c.properties(&ICalendarProperty::Rrule).any(|e| matches!(e.values.first(), Some(ICalendarValue::RecurrenceRule(r)) if r.count.is_none() && r.until.is_none()))
}

/// Occurrences overlapping `[from, to)` (Unix seconds), earliest first.
pub fn occurrences(ics: &str, local_tz: &str, from: i64, to: i64) -> Result<Vec<Instance>> {
    let cal = parse(ics)?;
    let mut out: Vec<_> = expand_all(&cal, local_tz).into_iter().filter(|o| o.start < to && o.end.max(o.start + 1) > from).collect();
    out.sort_by_key(|o| o.start);
    Ok(out)
}

// ── Writing ──────────────────────────────────────────────────────────────────

/// RFC 5545 §3.3.11 text escaping.
fn esc(s: &str) -> String {
    s.replace('\\', "\\\\").replace(';', "\\;").replace(',', "\\,").replace("\r\n", "\\n").replace('\n', "\\n")
}

/// "2026-10-14" → "20261014"; "2026-10-14T09:30" → "20261014T093000".
fn local_stamp(s: &str, all_day: bool) -> Result<String> {
    let bad = || Error::Invalid(format!("“{s}” isn't a date and time"));
    let digits: String = s.chars().filter(char::is_ascii_digit).collect();
    match (all_day, digits.len()) {
        (true, n) if n >= 8 => Ok(digits[..8].to_string()),
        (false, 12) => Ok(format!("{}T{}00", &digits[..8], &digits[8..12])),
        (false, 14) => Ok(format!("{}T{}", &digits[..8], &digits[8..14])),
        _ => Err(bad()),
    }
}

fn stamp_now() -> String {
    DateTime::from_timestamp(crate::now(), 0).unwrap_or_default().format("%Y%m%dT%H%M%SZ").to_string()
}

/// The schedule properties for `input`, as iCalendar lines.
fn schedule_lines(input: &EventInput) -> Result<Vec<String>> {
    let start = local_stamp(&input.start, input.all_day)?;
    let end = local_stamp(&input.end, input.all_day)?;
    if end < start || (end == start && input.all_day) {
        return Err(Error::Invalid("the event ends before it starts".into()));
    }
    let mut lines = if input.all_day {
        vec![format!("DTSTART;VALUE=DATE:{start}"), format!("DTEND;VALUE=DATE:{end}")]
    } else {
        if Tz::from_str(&input.time_zone).is_err() {
            return Err(Error::Invalid(format!("unknown time zone “{}”", input.time_zone)));
        }
        let tzid = &input.time_zone;
        vec![format!("DTSTART;TZID={tzid}:{start}"), format!("DTEND;TZID={tzid}:{end}")]
    };
    let freq = match input.repeat {
        Repeat::Daily => Some("DAILY"),
        Repeat::Weekly => Some("WEEKLY"),
        Repeat::Monthly => Some("MONTHLY"),
        Repeat::Yearly => Some("YEARLY"),
        Repeat::None | Repeat::Custom => None,
    };
    if let Some(freq) = freq {
        lines.push(format!("RRULE:FREQ={freq}"));
    }
    Ok(lines)
}

fn describe_lines(input: &EventInput) -> Vec<String> {
    let mut lines = vec![format!("SUMMARY:{}", esc(input.title.trim()))];
    if let Some(l) = input.location.as_deref().map(str::trim).filter(|l| !l.is_empty()) {
        lines.push(format!("LOCATION:{}", esc(l)));
    }
    if let Some(n) = input.notes.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
        lines.push(format!("DESCRIPTION:{}", esc(n)));
    }
    lines
}

/// Parses property lines through calcard so every value gets its proper type.
fn entries(lines: &[String]) -> Result<Vec<ICalendarEntry>> {
    let body: String = lines.iter().map(|l| format!("{l}\r\n")).collect();
    let cal = parse(&format!("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\n{body}END:VEVENT\r\nEND:VCALENDAR\r\n"))?;
    let ev = cal.components.into_iter().find(|c| c.component_type == ICalendarComponentType::VEvent);
    Ok(ev.map(|c| c.entries).unwrap_or_default())
}

fn finish(mut cal: ICalendar) -> String {
    cal.add_missing_timezones();
    cal.to_string().replace("\r\n", "\n").replace('\n', "\r\n")
}

/// A new calendar object resource for `input`.
pub fn new_event(uid: &str, input: &EventInput) -> Result<String> {
    let mut lines = vec![format!("UID:{uid}"), format!("DTSTAMP:{}", stamp_now()), "SEQUENCE:0".to_string()];
    lines.extend(describe_lines(input));
    lines.extend(schedule_lines(input)?);
    let body: String = lines.iter().map(|l| format!("{l}\r\n")).collect();
    let ics = format!("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Mailbird//EN\r\nCALSCALE:GREGORIAN\r\nBEGIN:VEVENT\r\n{body}END:VEVENT\r\nEND:VCALENDAR\r\n");
    Ok(finish(parse(&ics)?))
}

/// Applies `input` to the series master, keeping everything else.
/// `Repeat::Custom` keeps the existing recurrence rule untouched.
pub fn edit_event(ics: &str, input: &EventInput) -> Result<String> {
    let mut cal = parse(ics)?;
    let i = master_index(&cal).ok_or_else(|| Error::Parse("no event to edit".into()))?;
    let keep_rule = input.repeat == Repeat::Custom;
    let seq = cal.components[i]
        .property(&ICalendarProperty::Sequence)
        .and_then(|e| e.values.first())
        .and_then(|v| if let ICalendarValue::Integer(n) = v { Some(*n) } else { None })
        .unwrap_or(0);
    let mut lines = describe_lines(input);
    lines.extend(schedule_lines(input)?);
    lines.push(format!("SEQUENCE:{}", seq + 1));
    lines.push(format!("DTSTAMP:{}", stamp_now()));
    lines.push(format!("LAST-MODIFIED:{}", stamp_now()));
    let fresh = entries(&lines)?;
    let master = &mut cal.components[i];
    master.entries.retain(|e| {
        !matches!(
            e.name,
            ICalendarProperty::Summary
                | ICalendarProperty::Location
                | ICalendarProperty::Description
                | ICalendarProperty::Dtstart
                | ICalendarProperty::Dtend
                | ICalendarProperty::Duration
                | ICalendarProperty::Sequence
                | ICalendarProperty::Dtstamp
                | ICalendarProperty::LastModified
        ) && (keep_rule || e.name != ICalendarProperty::Rrule)
    });
    master.entries.extend(fresh);
    Ok(finish(cal))
}

/// Removes one occurrence of a series (an EXDATE at its original start).
/// `local_tz` must be the zone the occurrence was expanded in, so all-day
/// dates land on the right day.
pub fn skip_occurrence(ics: &str, start: i64, local_tz: &str) -> Result<String> {
    let mut cal = parse(ics)?;
    let i = master_index(&cal).ok_or_else(|| Error::Parse("no event".into()))?;
    let c = &cal.components[i];
    let dtstart = c.property(&ICalendarProperty::Dtstart).ok_or_else(|| Error::Parse("event has no start".into()))?;
    let at = DateTime::from_timestamp(start, 0).ok_or_else(|| Error::Invalid("bad occurrence time".into()))?;
    let line = if is_date_only(c) {
        format!("EXDATE;VALUE=DATE:{}", at.with_timezone(&tz(local_tz)).format("%Y%m%d"))
    } else if let Some(tzid) = dtstart.tz_id() {
        format!("EXDATE;TZID={tzid}:{}", at.with_timezone(&tz(tzid)).format("%Y%m%dT%H%M%S"))
    } else {
        format!("EXDATE:{}", at.format("%Y%m%dT%H%M%SZ"))
    };
    let fresh = entries(&[line])?;
    cal.components[i].entries.extend(fresh);
    Ok(finish(cal))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SERIES: &str = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:x\r\nBEGIN:VEVENT\r\nUID:a\r\nSUMMARY:Standup\r\nDTSTART;TZID=Europe/Lisbon:20261020T093000\r\nDTEND;TZID=Europe/Lisbon:20261020T094500\r\nRRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=4\r\nEXDATE;TZID=Europe/Lisbon:20261027T093000\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT10M\r\nEND:VALARM\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:a\r\nRECURRENCE-ID;TZID=Europe/Lisbon:20261103T093000\r\nSUMMARY:Standup (moved)\r\nDTSTART;TZID=Europe/Lisbon:20261103T110000\r\nDTEND;TZID=Europe/Lisbon:20261103T113000\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

    fn input(start: &str, end: &str) -> EventInput {
        EventInput {
            calendar_id: "c".into(),
            title: "Lunch, with Ana; maybe".into(),
            location: Some("Café".into()),
            notes: Some("line one\nline two".into()),
            start: start.into(),
            end: end.into(),
            all_day: false,
            time_zone: "Europe/Lisbon".into(),
            repeat: Repeat::None,
        }
    }

    #[test]
    fn series_expand_with_exdates_overrides_and_dst() {
        let meta = read_event(SERIES, "America/New_York").unwrap();
        assert!(meta.recurring);
        assert_eq!(meta.repeat, Repeat::Custom, "BYDAY + COUNT isn't a plain weekly rule");
        assert_eq!(meta.time_zone.as_deref(), Some("Europe/Lisbon"));
        let all = occurrences(SERIES, "America/New_York", 0, i64::MAX).unwrap();
        // 4 generated, 1 excluded, 1 moved.
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].start, 1_792_485_000); // 2026-10-20 09:30 WEST = 08:30Z
        assert_eq!(all[1].title, "Standup (moved)");
        assert_eq!(all[1].start, 1_793_703_600); // 11:00 WET after the DST change
        assert_eq!(all[2].start - all[2].end, -900);
        assert_eq!(meta.last_end, Some(all[2].end), "COUNT bounds the series");
    }

    #[test]
    fn windows_only_return_overlapping_occurrences() {
        let nov = occurrences(SERIES, "UTC", 1_793_491_200, 1_796_083_200).unwrap(); // November
        assert_eq!(nov.len(), 2);
    }

    #[test]
    fn all_day_events_sit_on_the_device_clock() {
        let ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:b\r\nSUMMARY:Holiday\r\nDTSTART;VALUE=DATE:20261101\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let meta = read_event(ics, "America/New_York").unwrap();
        assert!(meta.all_day);
        let o = occurrences(ics, "America/New_York", 0, i64::MAX).unwrap();
        assert_eq!(o[0].start, 1_793_505_600, "local midnight in New York");
        assert_eq!(o[0].end - o[0].start, 86_400, "a missing DTEND is one day");
    }

    #[test]
    fn new_events_round_trip_and_carry_their_time_zone() {
        let ics = new_event("u1@mailbird", &input("2026-10-14T12:30", "2026-10-14T13:30")).unwrap();
        assert!(ics.contains("BEGIN:VTIMEZONE"), "TZID needs a VTIMEZONE: {ics}");
        assert!(ics.contains("\r\n"));
        let meta = read_event(&ics, "UTC").unwrap();
        assert_eq!(meta.title, "Lunch, with Ana; maybe");
        assert_eq!(meta.notes.as_deref(), Some("line one\nline two"));
        assert_eq!(meta.first_start, 1_791_977_400); // 12:30 WEST = 11:30Z
        assert_eq!(meta.last_end, Some(1_791_981_000));
    }

    #[test]
    fn repeating_and_all_day_inputs() {
        let mut i = input("2026-10-14", "2026-10-15");
        i.all_day = true;
        i.repeat = Repeat::Yearly;
        let ics = new_event("bday", &i).unwrap();
        let meta = read_event(&ics, "UTC").unwrap();
        assert!(meta.all_day && meta.recurring);
        assert_eq!(meta.repeat, Repeat::Yearly);
        assert_eq!(meta.last_end, None, "no end to a birthday");
        assert!(new_event("x", &input("2026-10-14T12:00", "2026-10-14T11:00")).is_err(), "end before start");
        let mut bad = input("2026-10-14T12:00", "2026-10-14T13:00");
        bad.time_zone = "Mars/Olympus".into();
        assert!(new_event("x", &bad).is_err());
    }

    #[test]
    fn edits_keep_what_we_dont_model() {
        let mut i = input("2026-10-20T10:00", "2026-10-20T10:30");
        i.title = "Standup v2".into();
        i.repeat = Repeat::Custom;
        let edited = edit_event(SERIES, &i).unwrap();
        assert!(edited.contains("BEGIN:VALARM"), "alarm survives");
        assert!(edited.contains("BYDAY=TU"), "custom rule kept");
        assert!(edited.contains("SEQUENCE:1"));
        assert!(edited.contains("Standup (moved)"), "overrides kept");
        let meta = read_event(&edited, "UTC").unwrap();
        assert_eq!(meta.title, "Standup v2");
        assert_eq!(meta.location.as_deref(), Some("Café"));

        i.repeat = Repeat::None;
        let single = edit_event(&edited, &i).unwrap();
        let event_part = &single[single.find("BEGIN:VEVENT").unwrap()..];
        assert!(!event_part.contains("RRULE"), "repeat none drops the rule (VTIMEZONE rules aside)");
        assert!(!read_event(&single, "UTC").unwrap().recurring);
    }

    #[test]
    fn skipping_one_occurrence_adds_an_exdate() {
        let skipped = skip_occurrence(SERIES, 1_794_303_000, "UTC").unwrap(); // Nov 10
        let all = occurrences(&skipped, "UTC", 0, i64::MAX).unwrap();
        assert_eq!(all.len(), 2);
        assert!(all.iter().all(|o| o.start != 1_794_303_000));
    }
}
