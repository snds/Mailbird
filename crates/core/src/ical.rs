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
    /// Minutes before the start, from the master's editable alarms.
    pub reminders: Vec<i64>,
    /// Minutes to get there (Apple's `X-APPLE-TRAVEL-DURATION`).
    pub travel: Option<i64>,
}

/// One occurrence of an event, in absolute time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Instance {
    pub start: i64,
    pub end: i64,
    /// The slot this occurrence fills in the series (its RECURRENCE-ID).
    /// Differs from `start` when one occurrence was moved.
    pub original: i64,
    pub title: String,
    pub location: Option<String>,
    /// Minutes to get there: this occurrence's own, else the series'.
    pub travel: Option<i64>,
}

fn parse(ics: &str) -> Result<ICalendar> {
    ICalendar::parse(ics).map_err(|_| Error::Parse("not a valid iCalendar event".into()))
}

/// "2026-10-20T15:00" for `ts` in `zone`: the editor's local form.
pub(crate) fn local_input(ts: i64, zone: &str) -> String {
    DateTime::from_timestamp(ts, 0).unwrap_or_default().with_timezone(&tz(zone)).format("%Y-%m-%dT%H:%M").to_string()
}

/// The instant a local wall time in `zone` names (the earlier one when clocks fall back).
pub(crate) fn local_to_utc(date: chrono::NaiveDate, minutes: u32, zone: &str) -> Option<i64> {
    use chrono::TimeZone;
    let t = date.and_hms_opt(minutes / 60, minutes % 60, 0)?;
    tz(zone).from_local_datetime(&t).earliest().map(|d| d.timestamp())
}

/// The local calendar date of `ts` in `zone`.
pub(crate) fn local_date(ts: i64, zone: &str) -> chrono::NaiveDate {
    DateTime::from_timestamp(ts, 0).unwrap_or_default().with_timezone(&tz(zone)).date_naive()
}

/// An IANA zone; unknown names fall back to UTC rather than floating time.
fn tz(name: &str) -> Tz {
    Tz::from_str(name).or_else(|_| Tz::from_str("UTC")).unwrap_or_default()
}

/// Apple Calendar's travel time, which iCloud and macOS/iOS read and write.
/// There's no standard property for it, so we use theirs (ADR-0029).
const TRAVEL: &str = "X-APPLE-TRAVEL-DURATION";

fn is_travel(p: &ICalendarProperty) -> bool {
    matches!(p, ICalendarProperty::Other(n) if n.eq_ignore_ascii_case(TRAVEL))
}

/// Whole minutes in an ISO 8601 duration ("PT1H30M", "P0DT0H45M0S").
fn duration_minutes(s: &str) -> Option<i64> {
    let s = s.trim().to_ascii_uppercase();
    let rest = s.strip_prefix('P')?;
    let (mut total, mut num, mut time) = (0i64, String::new(), false);
    for ch in rest.chars() {
        match ch {
            'T' => time = true,
            '0'..='9' => num.push(ch),
            unit => {
                let n: i64 = num.parse().ok()?;
                num.clear();
                total += match (unit, time) {
                    ('W', false) => n * 7 * 24 * 60,
                    ('D', false) => n * 24 * 60,
                    ('H', true) => n * 60,
                    ('M', true) => n,
                    ('S', true) => n / 60,
                    _ => return None,
                };
            }
        }
    }
    num.is_empty().then_some(total)
}

/// A component's travel time in minutes, if it has a positive one.
fn travel_of(c: &ICalendarComponent) -> Option<i64> {
    let e = c.entries.iter().find(|e| is_travel(&e.name))?;
    let m = match e.values.first()? {
        ICalendarValue::Duration(d) => d.as_seconds() / 60,
        v => duration_minutes(v.as_text()?)?,
    };
    (m > 0).then_some(m.min(24 * 60))
}

/// Sets (or with 0, removes) travel time on the component `find` locates.
/// `None` leaves it alone.
fn set_travel(cal: &mut ICalendar, find: impl Fn(&ICalendar) -> Option<usize>, minutes: Option<i64>) -> Result<()> {
    let Some(m) = minutes else { return Ok(()) };
    if !(0..=24 * 60).contains(&m) {
        return Err(Error::Invalid("travel time is up to a day".into()));
    }
    let fresh = if m > 0 { entries(&[format!("{TRAVEL};VALUE=DURATION:PT{m}M")])? } else { vec![] };
    let i = find(cal).ok_or_else(|| Error::Parse("no event".into()))?;
    let c = &mut cal.components[i];
    c.entries.retain(|e| !is_travel(&e.name));
    c.entries.extend(fresh);
    Ok(())
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

/// A zone named by TZID, resolved against the object's own VTIMEZONEs first
/// (Outlook writes names like "Pacific Standard Time"), then IANA.
fn zone(cal: &ICalendar, tzid: Option<&str>, local_tz: &str) -> Tz {
    cal.build_tz_resolver().with_default(tz(local_tz)).resolve_or_default(tzid)
}

/// RECURRENCE-ID of an override, as Unix seconds.
fn rid_ts(cal: &ICalendar, c: &ICalendarComponent, local_tz: &str) -> Option<i64> {
    let e = c.property(&ICalendarProperty::RecurrenceId)?;
    let Some(ICalendarValue::PartialDateTime(dt)) = e.values.first() else { return None };
    dt.to_date_time_with_tz(zone(cal, e.tz_id(), local_tz)).map(|d| d.timestamp())
}

/// calcard pairs an override with its series only when both carry the same
/// SEQUENCE; clients routinely bump it on the override alone, which would
/// show that occurrence twice. Expansion ignores SEQUENCE.
fn for_expansion(cal: &ICalendar) -> ICalendar {
    let mut c = cal.clone();
    for comp in c.components.iter_mut().filter(|c| c.component_type == ICalendarComponentType::VEvent) {
        comp.entries.retain(|e| e.name != ICalendarProperty::Sequence);
    }
    c
}

fn expand_all(cal: &ICalendar, local_tz: &str) -> Vec<Instance> {
    let series_travel = master_index(cal).and_then(|m| travel_of(&cal.components[m]));
    let exp = for_expansion(cal).expand_dates(tz(local_tz), EXPAND_LIMIT);
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
            let original = if c.has_property(&ICalendarProperty::RecurrenceId) { rid_ts(cal, c, local_tz).unwrap_or(start) } else { start };
            Some(Instance {
                start,
                end,
                original,
                title: text(c, ICalendarProperty::Summary).unwrap_or_default(),
                location: text(c, ICalendarProperty::Location),
                travel: if is_date_only(c) { None } else { travel_of(c).or(series_travel) },
            })
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
        reminders: reminders_of(&cal, i),
        travel: if is_date_only(c) { None } else { travel_of(c) },
    })
}

// ── Reminders (VALARM) ───────────────────────────────────────────────────────

/// A display or sound alarm relative to the start: the kind the editor
/// offers. Its lead time in minutes (0 = at the start, negative = after).
/// Email alarms, absolute times, and end-relative triggers stay as they are.
fn editable_alarm(c: &ICalendarComponent) -> Option<i64> {
    use calcard::icalendar::{ICalendarAction, ICalendarParameterValue, ICalendarRelated};
    if c.component_type != ICalendarComponentType::VAlarm {
        return None;
    }
    let action = c.property(&ICalendarProperty::Action).and_then(|e| e.values.first());
    if !matches!(action, Some(ICalendarValue::Action(ICalendarAction::Display | ICalendarAction::Audio))) {
        return None;
    }
    let trigger = c.property(&ICalendarProperty::Trigger)?;
    let end_related = trigger.params.iter().any(|p| matches!(p.value, ICalendarParameterValue::Related(ICalendarRelated::End)));
    match trigger.values.first() {
        Some(ICalendarValue::Duration(d)) if !end_related => Some(-d.as_seconds() / 60),
        _ => None,
    }
}

fn reminders_of(cal: &ICalendar, event: usize) -> Vec<i64> {
    let mut out: Vec<i64> = cal.components[event].component_ids.iter().filter_map(|id| cal.components.get(*id as usize).and_then(editable_alarm)).collect();
    out.sort_unstable();
    out.dedup();
    out
}

/// Replaces the editable alarms of the event `find` locates (the index
/// shifts as components are removed, so it is looked up again).
fn set_reminders(cal: &mut ICalendar, find: impl Fn(&ICalendar) -> Option<usize>, minutes: &[i64]) -> Result<()> {
    let i = find(cal).ok_or_else(|| Error::Parse("no event".into()))?;
    let old: Vec<u32> = cal.components[i].component_ids.iter().copied().filter(|id| cal.components.get(*id as usize).and_then(editable_alarm).is_some()).collect();
    cal.remove_component_ids(&old);
    let i = find(cal).ok_or_else(|| Error::Parse("no event".into()))?;
    let mut mins = minutes.to_vec();
    mins.sort_unstable();
    mins.dedup();
    let alarms: String = mins
        .iter()
        .map(|m| {
            let trigger = if *m >= 0 { format!("-PT{m}M") } else { format!("PT{}M", -m) };
            format!("BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Reminder\r\nTRIGGER:{trigger}\r\nEND:VALARM\r\n")
        })
        .collect();
    let snippet = parse(&format!("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:x\r\n{alarms}END:VEVENT\r\nEND:VCALENDAR\r\n"))?;
    for alarm in snippet.components.into_iter().filter(|c| c.component_type == ICalendarComponentType::VAlarm) {
        cal.components.push(alarm);
        let id = (cal.components.len() - 1) as u32;
        cal.components[i].component_ids.push(id);
    }
    Ok(())
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
pub(crate) fn esc(s: &str) -> String {
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
    let mut cal = parse(&ics)?;
    if let Some(r) = &input.reminders {
        set_reminders(&mut cal, master_index, r)?;
    }
    if !input.all_day {
        set_travel(&mut cal, master_index, input.travel)?;
    }
    Ok(finish(cal))
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
    if let Some(r) = &input.reminders {
        set_reminders(&mut cal, master_index, r)?;
    }
    // An all-day event has no start to travel to.
    set_travel(&mut cal, master_index, if input.all_day { Some(0) } else { input.travel })?;
    Ok(finish(cal))
}

/// A property naming one slot of the series, written in the same form as
/// the master's DTSTART (date, zoned local time, UTC, or floating), as
/// RFC 5545 requires for EXDATE and RECURRENCE-ID.
fn slot_line(cal: &ICalendar, master: &ICalendarComponent, prop: &str, at: i64, local_tz: &str) -> Result<String> {
    let dtstart = master.property(&ICalendarProperty::Dtstart).ok_or_else(|| Error::Parse("event has no start".into()))?;
    let at = DateTime::from_timestamp(at, 0).ok_or_else(|| Error::Invalid("bad occurrence time".into()))?;
    let utc = matches!(dtstart.values.first(), Some(ICalendarValue::PartialDateTime(dt)) if dt.tz_hour.is_some());
    Ok(if is_date_only(master) {
        format!("{prop};VALUE=DATE:{}", at.with_timezone(&tz(local_tz)).format("%Y%m%d"))
    } else if let Some(tzid) = dtstart.tz_id() {
        // Quote names a parameter can't carry bare ("Romance Standard Time").
        let name = if tzid.contains([' ', ':', ';', ',']) { format!("\"{tzid}\"") } else { tzid.to_string() };
        format!("{prop};TZID={name}:{}", at.with_timezone(&zone(cal, Some(tzid), local_tz)).format("%Y%m%dT%H%M%S"))
    } else if utc {
        format!("{prop}:{}", at.format("%Y%m%dT%H%M%SZ"))
    } else {
        format!("{prop}:{}", at.with_timezone(&tz(local_tz)).format("%Y%m%dT%H%M%S"))
    })
}

fn override_index(cal: &ICalendar, original: i64, local_tz: &str) -> Option<usize> {
    cal.components.iter().position(|c| c.component_type == ICalendarComponentType::VEvent && c.has_property(&ICalendarProperty::RecurrenceId) && rid_ts(cal, c, local_tz) == Some(original))
}

fn sequence(c: &ICalendarComponent) -> i64 {
    c.property(&ICalendarProperty::Sequence)
        .and_then(|e| e.values.first())
        .and_then(|v| if let ICalendarValue::Integer(n) = v { Some(*n) } else { None })
        .unwrap_or(0)
}

/// Removes one occurrence of a series: an EXDATE at its slot, and any
/// override that had moved it. `original` is the slot, `local_tz` the zone
/// it was expanded in (all-day dates land on that day).
pub fn skip_occurrence(ics: &str, original: i64, local_tz: &str) -> Result<String> {
    let mut cal = parse(ics)?;
    let m = master_index(&cal).ok_or_else(|| Error::Parse("no event".into()))?;
    let line = slot_line(&cal, &cal.components[m], "EXDATE", original, local_tz)?;
    let fresh = entries(&[line])?;
    cal.components[m].entries.extend(fresh);
    if let Some(o) = override_index(&cal, original, local_tz) {
        cal.remove_component_ids(&[o as u32]);
    }
    Ok(finish(cal))
}

/// Properties an override or a split series gets from `input`; the rest it
/// inherits from the series master.
const SCHEDULE_PROPS: [ICalendarProperty; 13] = [
    ICalendarProperty::Summary,
    ICalendarProperty::Location,
    ICalendarProperty::Description,
    ICalendarProperty::Dtstart,
    ICalendarProperty::Dtend,
    ICalendarProperty::Duration,
    ICalendarProperty::Rrule,
    ICalendarProperty::Rdate,
    ICalendarProperty::Exdate,
    ICalendarProperty::RecurrenceId,
    ICalendarProperty::Sequence,
    ICalendarProperty::Dtstamp,
    ICalendarProperty::LastModified,
];

/// Edits one occurrence only (RFC 5545 §3.8.4.4): updates its override, or
/// adds one that inherits the master's attendees, alarms, and other
/// properties. A non-recurring event is simply edited.
pub fn edit_occurrence(ics: &str, original: i64, input: &EventInput, local_tz: &str) -> Result<String> {
    let mut cal = parse(ics)?;
    let m = master_index(&cal).ok_or_else(|| Error::Parse("no event to edit".into()))?;
    if !cal.components[m].is_recurrent() {
        return edit_event(ics, input);
    }
    let single = EventInput { repeat: Repeat::None, ..input.clone() };
    let mut lines = describe_lines(&single);
    lines.extend(schedule_lines(&single)?);
    lines.push(format!("DTSTAMP:{}", stamp_now()));
    lines.push(format!("LAST-MODIFIED:{}", stamp_now()));
    // Keep SEQUENCE in step with the master, as most servers expect.
    lines.push(format!("SEQUENCE:{}", sequence(&cal.components[m])));

    if let Some(o) = override_index(&cal, original, local_tz) {
        let fresh = entries(&lines)?;
        let c = &mut cal.components[o];
        c.entries.retain(|e| !SCHEDULE_PROPS.contains(&e.name) || e.name == ICalendarProperty::RecurrenceId);
        c.entries.extend(fresh);
        if let Some(r) = &input.reminders {
            set_reminders(&mut cal, |c| override_index(c, original, local_tz), r)?;
        }
        set_travel(&mut cal, |c| override_index(c, original, local_tz), if input.all_day { Some(0) } else { input.travel })?;
        return Ok(finish(cal));
    }
    lines.push(slot_line(&cal, &cal.components[m], "RECURRENCE-ID", original, local_tz)?);
    let fresh = entries(&lines)?;
    let master = cal.components[m].clone();
    let mut inherited: Vec<ICalendarEntry> = master.entries.iter().filter(|e| !SCHEDULE_PROPS.contains(&e.name)).cloned().collect();
    inherited.extend(fresh);
    // Alarms are sub-components; give the override its own copies.
    let mut ids = Vec::new();
    for id in &master.component_ids {
        if let Some(alarm) = cal.components.get(*id as usize).filter(|c| c.component_type == ICalendarComponentType::VAlarm).cloned() {
            cal.components.push(alarm);
            ids.push((cal.components.len() - 1) as u32);
        }
    }
    cal.components.push(ICalendarComponent { component_type: ICalendarComponentType::VEvent, entries: inherited, component_ids: ids });
    let new_id = (cal.components.len() - 1) as u32;
    cal.components[0].component_ids.push(new_id);
    if let Some(r) = &input.reminders {
        set_reminders(&mut cal, |c| override_index(c, original, local_tz), r)?;
    }
    set_travel(&mut cal, |c| override_index(c, original, local_tz), if input.all_day { Some(0) } else { input.travel })?;
    Ok(finish(cal))
}

/// The RRULE part after the split point: UNTIL just before `original`, in
/// UTC (or a date for all-day series), as RFC 5545 requires.
fn until_value(master: &ICalendarComponent, original: i64, local_tz: &str) -> Result<calcard::common::PartialDateTime> {
    let line = if is_date_only(master) {
        let day_before = DateTime::from_timestamp(original - 86_400, 0).ok_or_else(|| Error::Invalid("bad occurrence time".into()))?;
        format!("RRULE:FREQ=DAILY;UNTIL={}", day_before.with_timezone(&tz(local_tz)).format("%Y%m%d"))
    } else {
        let before = DateTime::from_timestamp(original - 1, 0).ok_or_else(|| Error::Invalid("bad occurrence time".into()))?;
        format!("RRULE:FREQ=DAILY;UNTIL={}", before.format("%Y%m%dT%H%M%SZ"))
    };
    let parsed = entries(&[line])?;
    match parsed.into_iter().next().and_then(|e| e.values.into_iter().next()) {
        Some(ICalendarValue::RecurrenceRule(r)) => r.until.ok_or_else(|| Error::Parse("bad UNTIL".into())),
        _ => Err(Error::Parse("bad UNTIL".into())),
    }
}

/// Ends a series just before the occurrence at `original` (for "delete
/// this and following" and the first half of a split). Overrides from
/// that slot on are dropped with it.
pub fn end_series_before(ics: &str, original: i64, local_tz: &str) -> Result<String> {
    let mut cal = parse(ics)?;
    let m = master_index(&cal).ok_or_else(|| Error::Parse("no event".into()))?;
    let until = until_value(&cal.components[m], original, local_tz)?;
    for e in cal.components[m].entries.iter_mut().filter(|e| e.name == ICalendarProperty::Rrule) {
        for v in e.values.iter_mut() {
            if let ICalendarValue::RecurrenceRule(r) = v {
                r.count = None;
                r.until = Some(until.clone());
            }
        }
    }
    let later: Vec<u32> = cal
        .components
        .iter()
        .enumerate()
        .filter(|(_, c)| c.component_type == ICalendarComponentType::VEvent && c.has_property(&ICalendarProperty::RecurrenceId))
        .filter(|(_, c)| rid_ts(&cal, c, local_tz).is_some_and(|t| t >= original))
        .map(|(i, _)| i as u32)
        .collect();
    cal.remove_component_ids(&later);
    Ok(finish(cal))
}

/// "This and following": a new series with its own UID from `original`
/// on, carrying the old one's attendees, alarms, and other properties.
/// With `Repeat::Custom` the old rule continues (a COUNT shrinks by the
/// occurrences already past). Pair with `end_series_before` on the old one.
pub fn split_series(ics: &str, original: i64, new_uid: &str, input: &EventInput, local_tz: &str) -> Result<String> {
    let mut cal = parse(ics)?;
    let m = master_index(&cal).ok_or_else(|| Error::Parse("no event".into()))?;
    let before = expand_all(&cal, local_tz).iter().filter(|o| o.original < original).count() as u32;
    let mut rule = cal.components[m].property(&ICalendarProperty::Rrule).cloned();
    if let Some(ICalendarValue::RecurrenceRule(r)) = rule.as_mut().and_then(|e| e.values.first_mut()) {
        r.count = r.count.map(|c| c.saturating_sub(before).max(1));
    }
    // The new series starts clean: no overrides from the old one.
    let overrides: Vec<u32> = cal
        .components
        .iter()
        .enumerate()
        .filter(|(i, c)| *i != m && c.component_type == ICalendarComponentType::VEvent)
        .map(|(i, _)| i as u32)
        .collect();
    cal.remove_component_ids(&overrides);
    let m = master_index(&cal).ok_or_else(|| Error::Parse("no event".into()))?;
    let mut lines = describe_lines(input);
    lines.extend(schedule_lines(input)?);
    lines.push(format!("UID:{new_uid}"));
    lines.push("SEQUENCE:0".into());
    lines.push(format!("DTSTAMP:{}", stamp_now()));
    let fresh = entries(&lines)?;
    let master = &mut cal.components[m];
    master.entries.retain(|e| !SCHEDULE_PROPS.contains(&e.name) && e.name != ICalendarProperty::Uid);
    master.entries.extend(fresh);
    if input.repeat == Repeat::Custom {
        master.entries.extend(rule);
    }
    if let Some(r) = &input.reminders {
        set_reminders(&mut cal, master_index, r)?;
    }
    set_travel(&mut cal, master_index, if input.all_day { Some(0) } else { input.travel })?;
    Ok(finish(cal))
}


// ── Shape: an event in plain terms, for APIs that don't speak iCalendar ─────

/// A recurrence rule's parts (RFC 5545 §3.3.10), as written.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Rule {
    /// "DAILY", "WEEKLY", "MONTHLY", "YEARLY", …
    pub freq: String,
    pub interval: u32,
    pub count: Option<u32>,
    /// The last day the series may run, in the event's zone ("YYYY-MM-DD").
    pub until: Option<String>,
    /// (ordinal, weekday): `(0, "MO")` every Monday, `(-1, "FR")` the last Friday.
    pub byday: Vec<(i32, String)>,
    pub bymonthday: Vec<i32>,
    pub bymonth: Vec<u32>,
    pub bysetpos: Vec<i32>,
    pub wkst: Option<String>,
    /// Parts not listed above (BYHOUR, BYWEEKNO…).
    pub other: Vec<String>,
}

/// One moved or edited occurrence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OverrideShape {
    /// The slot it fills (RECURRENCE-ID), Unix seconds.
    pub original: i64,
    pub start: i64,
    pub end: i64,
    pub title: String,
    pub location: Option<String>,
    pub notes: Option<String>,
}

/// What another calendar API needs to recreate an event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Shape {
    pub meta: EventMeta,
    /// The master's own start and end (Unix seconds). All-day events start
    /// at midnight on `local_tz`'s clock.
    pub start: i64,
    pub end: i64,
    pub rule: Option<Rule>,
    pub exdates: Vec<i64>,
    pub overrides: Vec<OverrideShape>,
}

fn prop_ts(cal: &ICalendar, c: &ICalendarComponent, prop: ICalendarProperty, local_tz: &str) -> Option<i64> {
    let e = c.property(&prop)?;
    let Some(ICalendarValue::PartialDateTime(dt)) = e.values.first() else { return None };
    dt.to_date_time_with_tz(zone(cal, e.tz_id(), local_tz)).map(|d| d.timestamp())
}

/// The master's RRULE, read from the text (calcard keeps the parts typed;
/// other APIs want them by name).
fn rule_of(ics: &str, until_tz: &Tz) -> Option<Rule> {
    let unfolded = ics.replace("\r\n ", "").replace("\r\n\t", "").replace("\n ", "");
    // Only a VEVENT's own rule: VTIMEZONEs carry RRULEs for their DST changes.
    let (mut in_event, mut in_override) = (false, false);
    let mut line = None;
    for l in unfolded.lines() {
        match l.trim_end() {
            "BEGIN:VEVENT" => (in_event, in_override) = (true, false),
            "END:VEVENT" => in_event = false,
            l if l.starts_with("RECURRENCE-ID") => in_override = true,
            l if l.starts_with("RRULE") && in_event && !in_override && line.is_none() => line = Some(l.to_string()),
            _ => {}
        }
    }
    let value = line?.split_once(':')?.1.to_string();
    let mut r = Rule { interval: 1, ..Default::default() };
    for part in value.split(';') {
        let Some((k, v)) = part.split_once('=') else { continue };
        let ints = |v: &str| v.split(',').filter_map(|x| x.trim().parse::<i32>().ok()).collect::<Vec<_>>();
        match k.to_ascii_uppercase().as_str() {
            "FREQ" => r.freq = v.to_ascii_uppercase(),
            "INTERVAL" => r.interval = v.parse().unwrap_or(1).max(1),
            "COUNT" => r.count = v.parse().ok(),
            "UNTIL" => {
                let digits: String = v.chars().filter(char::is_ascii_digit).collect();
                r.until = if v.ends_with('Z') && digits.len() >= 14 {
                    chrono::NaiveDateTime::parse_from_str(&digits[..14], "%Y%m%d%H%M%S")
                        .ok()
                        .map(|n| n.and_utc().with_timezone(until_tz).format("%Y-%m-%d").to_string())
                } else {
                    digits.get(..8).map(|d| format!("{}-{}-{}", &d[..4], &d[4..6], &d[6..8]))
                };
            }
            "BYDAY" => {
                r.byday = v
                    .split(',')
                    .filter_map(|d| {
                        let d = d.trim();
                        let (n, day) = d.split_at(d.len().checked_sub(2)?);
                        Some((if n.is_empty() { 0 } else { n.trim_start_matches('+').parse().ok()? }, day.to_ascii_uppercase()))
                    })
                    .collect()
            }
            "BYMONTHDAY" => r.bymonthday = ints(v),
            "BYMONTH" => r.bymonth = ints(v).into_iter().filter_map(|m| u32::try_from(m).ok()).collect(),
            "BYSETPOS" => r.bysetpos = ints(v),
            "WKST" => r.wkst = Some(v.to_ascii_uppercase()),
            _ => r.other.push(part.to_string()),
        }
    }
    Some(r)
}

/// The event in plain terms: the master's times and rule, its skipped
/// slots, and its moved or edited occurrences.
pub fn shape(ics: &str, local_tz: &str) -> Result<Shape> {
    let meta = read_event(ics, local_tz)?;
    let cal = parse(ics)?;
    let m = master_index(&cal).ok_or_else(|| Error::Parse("no event in this calendar object".into()))?;
    let c = &cal.components[m];
    let start = prop_ts(&cal, c, ICalendarProperty::Dtstart, local_tz).unwrap_or(meta.first_start);
    let end = prop_ts(&cal, c, ICalendarProperty::Dtend, local_tz)
        .or_else(|| expand_all(&cal, local_tz).into_iter().find(|o| o.original == start).map(|o| o.end))
        .unwrap_or(if meta.all_day { start + 86_400 } else { start });
    let event_tz = zone(&cal, c.property(&ICalendarProperty::Dtstart).and_then(|e| e.tz_id()), local_tz);
    let exdates = c
        .properties(&ICalendarProperty::Exdate)
        .flat_map(|e| {
            let z = zone(&cal, e.tz_id(), local_tz);
            e.values.iter().filter_map(move |v| match v {
                ICalendarValue::PartialDateTime(dt) => dt.to_date_time_with_tz(z).map(|d| d.timestamp()),
                _ => None,
            })
        })
        .collect();
    let overrides = cal
        .components
        .iter()
        .filter(|o| o.component_type == ICalendarComponentType::VEvent && o.has_property(&ICalendarProperty::RecurrenceId))
        .filter_map(|o| {
            let original = rid_ts(&cal, o, local_tz)?;
            let start = prop_ts(&cal, o, ICalendarProperty::Dtstart, local_tz).unwrap_or(original);
            Some(OverrideShape {
                original,
                start,
                end: prop_ts(&cal, o, ICalendarProperty::Dtend, local_tz).unwrap_or(start),
                title: text(o, ICalendarProperty::Summary).unwrap_or_else(|| meta.title.clone()),
                location: text(o, ICalendarProperty::Location),
                notes: text(o, ICalendarProperty::Description),
            })
        })
        .collect();
    Ok(Shape { rule: if meta.recurring { rule_of(ics, &event_tz) } else { None }, meta, start, end, exdates, overrides })
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
            reminders: None,
            attendees: None,
            travel: None,
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

    /// Weekly Tuesdays 09:30 Lisbon, 4 times from 2026-10-20 (no exceptions).
    const PLAIN: &str = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:p\r\nSUMMARY:Review\r\nSEQUENCE:3\r\nDTSTART;TZID=Europe/Lisbon:20261020T093000\r\nDTEND;TZID=Europe/Lisbon:20261020T100000\r\nRRULE:FREQ=WEEKLY;COUNT=4\r\nATTENDEE;CN=Ana:mailto:ana@example.com\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    /// The series' slots, from expansion (DST ends Oct 25, so they aren't 7×24h apart).
    fn slots(ics: &str) -> Vec<i64> {
        occurrences(ics, "UTC", 0, i64::MAX).unwrap().iter().map(|o| o.original).collect()
    }

    #[test]
    fn overrides_match_their_slot_whatever_their_sequence() {
        let ics = SERIES.replace("RECURRENCE-ID;", "SEQUENCE:7\r\nRECURRENCE-ID;");
        assert_eq!(occurrences(&ics, "UTC", 0, i64::MAX).unwrap().len(), 3, "no duplicate for a bumped SEQUENCE");
        let moved = occurrences(&ics, "UTC", 0, i64::MAX).unwrap().into_iter().find(|o| o.title == "Standup (moved)").unwrap();
        assert_eq!(moved.original, 1_793_698_200, "remembers its slot (09:30 WET)");
        assert_ne!(moved.start, moved.original);
    }

    #[test]
    fn editing_one_occurrence_adds_an_override_that_inherits() {
        let s = slots(PLAIN);
        let mut i = input("2026-10-27T14:00", "2026-10-27T15:00");
        i.title = "Review (moved)".into();
        let once = edit_occurrence(PLAIN, s[1], &i, "UTC").unwrap();
        let all = occurrences(&once, "UTC", 0, i64::MAX).unwrap();
        assert_eq!(all.len(), 4, "still four");
        let moved = all.iter().find(|o| o.original == s[1]).unwrap();
        assert_eq!(moved.title, "Review (moved)");
        assert_eq!(moved.start, 1_793_109_600, "14:00 Lisbon (WET) on the 27th");
        assert!(all.iter().filter(|o| o.original != s[1]).all(|o| o.title == "Review"));
        let override_part = &once[once.rfind("BEGIN:VEVENT").unwrap()..];
        assert!(override_part.contains("ana@example.com"), "attendees inherited");
        assert!(override_part.contains("BEGIN:VALARM"), "alarm inherited");
        assert!(override_part.contains("SEQUENCE:3"), "sequence in step with the master");

        // Editing it again updates the same override.
        i.title = "Review (moved again)".into();
        let twice = edit_occurrence(&once, s[1], &i, "UTC").unwrap();
        assert_eq!(twice.matches("RECURRENCE-ID").count(), 1);
        assert_eq!(occurrences(&twice, "UTC", 0, i64::MAX).unwrap().len(), 4);

        // Deleting the moved occurrence removes the override too.
        let gone = skip_occurrence(&twice, s[1], "UTC").unwrap();
        assert!(!gone.contains("RECURRENCE-ID"));
        assert_eq!(occurrences(&gone, "UTC", 0, i64::MAX).unwrap().len(), 3);
    }

    #[test]
    fn ending_a_series_keeps_only_what_came_before() {
        let s = slots(PLAIN);
        let edited = edit_occurrence(PLAIN, s[3], &input("2026-11-10T12:00", "2026-11-10T13:00"), "UTC").unwrap();
        let ended = end_series_before(&edited, s[2], "UTC").unwrap();
        assert_eq!(slots(&ended), s[..2]);
        assert!(!ended.contains("COUNT="), "COUNT becomes UNTIL");
        assert!(!ended.contains("RECURRENCE-ID"), "later overrides go with it");
        assert!(read_event(&ended, "UTC").unwrap().last_end.is_some());
    }

    #[test]
    fn splitting_continues_the_rule_under_a_new_uid() {
        let mut i = input("2026-11-03T10:00", "2026-11-03T10:30");
        i.repeat = Repeat::Custom;
        i.title = "Review v2".into();
        let s = slots(PLAIN);
        let tail = split_series(PLAIN, s[2], "p2", &i, "UTC").unwrap();
        let meta = read_event(&tail, "UTC").unwrap();
        assert_eq!(meta.uid, "p2");
        assert_eq!(meta.attendees.len(), 1, "attendees carried over");
        let all = occurrences(&tail, "UTC", 0, i64::MAX).unwrap();
        assert_eq!(all.len(), 2, "COUNT=4 minus the two already past");
        assert!(all.iter().all(|o| o.title == "Review v2"));
        assert_eq!(all[0].start, 1_793_700_000, "10:00 Lisbon on Nov 3");
        let head = end_series_before(PLAIN, s[2], "UTC").unwrap();
        assert_eq!(occurrences(&head, "UTC", 0, i64::MAX).unwrap().len() + all.len(), 4, "nothing lost or doubled");
    }

    #[test]
    fn windows_style_zone_names_resolve_through_their_vtimezone() {
        let ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTIMEZONE\r\nTZID:Romance Standard Time\r\nBEGIN:STANDARD\r\nDTSTART:16010101T030000\r\nTZOFFSETFROM:+0200\r\nTZOFFSETTO:+0100\r\nRRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10\r\nEND:STANDARD\r\nBEGIN:DAYLIGHT\r\nDTSTART:16010101T020000\r\nTZOFFSETFROM:+0100\r\nTZOFFSETTO:+0200\r\nRRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3\r\nEND:DAYLIGHT\r\nEND:VTIMEZONE\r\nBEGIN:VEVENT\r\nUID:w\r\nSUMMARY:Sync\r\nDTSTART;TZID=Romance Standard Time:20261020T090000\r\nDTEND;TZID=Romance Standard Time:20261020T093000\r\nRRULE:FREQ=DAILY;COUNT=3\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let all = occurrences(ics, "UTC", 0, i64::MAX).unwrap();
        assert_eq!(all[0].start, 1_792_479_600, "09:00 at +02:00");
        let skipped = skip_occurrence(ics, all[1].original, "UTC").unwrap();
        assert!(skipped.contains("EXDATE;TZID=\"Romance Standard Time\":20261021T090000"), "{skipped}");
        assert_eq!(occurrences(&skipped, "UTC", 0, i64::MAX).unwrap().len(), 2);
    }

    #[test]
    fn reminders_read_write_and_keep_other_alarms() {
        assert_eq!(read_event(SERIES, "UTC").unwrap().reminders, [10], "existing 10-minute alarm");
        // An email alarm and an absolute one aren't the editor's to touch.
        let mixed = SERIES.replace("END:VALARM\r\nEND:VEVENT\r\nBEGIN:VEVENT", "END:VALARM\r\nBEGIN:VALARM\r\nACTION:EMAIL\r\nSUMMARY:x\r\nDESCRIPTION:x\r\nATTENDEE:mailto:a@b.example\r\nTRIGGER:-P1D\r\nEND:VALARM\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER;VALUE=DATE-TIME:20261019T080000Z\r\nEND:VALARM\r\nEND:VEVENT\r\nBEGIN:VEVENT");
        let mut i = input("2026-10-20T09:30", "2026-10-20T09:45");
        i.repeat = Repeat::Custom;
        i.reminders = Some(vec![60, 0, 60]);
        let edited = edit_event(&mixed, &i).unwrap();
        assert_eq!(read_event(&edited, "UTC").unwrap().reminders, [0, 60], "replaced, deduped, sorted");
        assert!(edited.contains("ACTION:EMAIL"), "email alarm kept");
        assert!(edited.contains("20261019T080000Z"), "absolute alarm kept");
        assert!(!edited.contains("-PT10M"), "old display alarm replaced");
        i.reminders = None;
        assert_eq!(read_event(&edit_event(&edited, &i).unwrap(), "UTC").unwrap().reminders, [0, 60], "None leaves them be");
        i.reminders = Some(vec![]);
        assert!(read_event(&edit_event(&edited, &i).unwrap(), "UTC").unwrap().reminders.is_empty());

        let mut n = input("2026-10-14T12:30", "2026-10-14T13:30");
        n.reminders = Some(vec![15]);
        let created = new_event("r1", &n).unwrap();
        assert!(created.contains("TRIGGER:-PT15M"));
        assert_eq!(read_event(&created, "UTC").unwrap().reminders, [15]);
    }

    #[test]
    fn travel_time_reads_apples_and_round_trips() {
        let apple = SERIES.replacen("SUMMARY:Standup\r\n", "SUMMARY:Standup\r\nX-APPLE-TRAVEL-DURATION;VALUE=DURATION:PT1H30M\r\n", 1);
        assert_eq!(read_event(&apple, "UTC").unwrap().travel, Some(90), "Apple's property, hours and minutes");
        let all = occurrences(&apple, "UTC", 0, i64::MAX).unwrap();
        assert!(all.iter().all(|o| o.travel == Some(90)), "every occurrence, the moved one too");
        assert_eq!(read_event(SERIES, "UTC").unwrap().travel, None);
        assert_eq!(duration_minutes("P0DT0H45M0S"), Some(45));
        assert_eq!(duration_minutes("P1D"), Some(24 * 60));
        assert_eq!(duration_minutes("PT"), Some(0));
        assert_eq!(duration_minutes("45M"), None);

        let mut n = input("2026-10-14T12:30", "2026-10-14T13:30");
        n.travel = Some(20);
        let created = new_event("t1", &n).unwrap();
        assert!(created.contains("X-APPLE-TRAVEL-DURATION;VALUE=DURATION:PT20M"), "written the way Apple reads it:\n{created}");
        assert_eq!(read_event(&created, "UTC").unwrap().travel, Some(20));
        n.travel = None;
        let kept = edit_event(&created, &n).unwrap();
        assert_eq!(read_event(&kept, "UTC").unwrap().travel, Some(20), "None keeps it");
        n.travel = Some(45);
        let changed = edit_event(&kept, &n).unwrap();
        assert_eq!(read_event(&changed, "UTC").unwrap().travel, Some(45));
        assert_eq!(changed.matches("X-APPLE-TRAVEL-DURATION").count(), 1, "replaced, not added");
        n.travel = Some(0);
        assert_eq!(read_event(&edit_event(&changed, &n).unwrap(), "UTC").unwrap().travel, None, "0 removes it");
        n.travel = Some(25 * 60);
        assert!(edit_event(&changed, &n).is_err(), "more than a day is a mistake");
        let mut day = input("2026-10-14", "2026-10-15");
        day.all_day = true;
        day.travel = None;
        assert!(!edit_event(&changed, &day).unwrap().contains("X-APPLE-TRAVEL"), "an all-day event drops it");

        // One occurrence can have its own.
        let mut one = input("2026-11-10T10:00", "2026-11-10T10:30");
        one.travel = Some(15);
        let edited = edit_occurrence(SERIES, 1_794_303_000, &one, "UTC").unwrap();
        let by_start: Vec<_> = occurrences(&edited, "UTC", 0, i64::MAX).unwrap().into_iter().map(|o| (o.original, o.travel)).collect();
        assert!(by_start.contains(&(1_794_303_000, Some(15))) && by_start.iter().filter(|(_, t)| t.is_some()).count() == 1, "{by_start:?}");
    }

    #[test]
    fn skipping_one_occurrence_adds_an_exdate() {
        let skipped = skip_occurrence(SERIES, 1_794_303_000, "UTC").unwrap(); // Nov 10
        let all = occurrences(&skipped, "UTC", 0, i64::MAX).unwrap();
        assert_eq!(all.len(), 2);
        assert!(all.iter().all(|o| o.start != 1_794_303_000));
    }

    #[test]
    fn shape_names_rule_slots_and_overrides() {
        let sh = shape(SERIES, "America/New_York").unwrap();
        let lisbon = |d: &str| chrono::NaiveDateTime::parse_from_str(d, "%Y%m%dT%H%M%S").unwrap().and_local_timezone(tz("Europe/Lisbon")).unwrap().timestamp();
        assert_eq!((sh.start, sh.end), (lisbon("20261020T093000"), lisbon("20261020T094500")));
        let r = sh.rule.unwrap();
        assert_eq!((r.freq.as_str(), r.interval, r.count, r.byday.clone()), ("WEEKLY", 1, Some(4), vec![(0, "TU".to_string())]));
        assert_eq!(sh.exdates, vec![lisbon("20261027T093000")]);
        assert_eq!(sh.overrides.len(), 1);
        let o = &sh.overrides[0];
        assert_eq!((o.original, o.start, o.title.as_str()), (lisbon("20261103T093000"), lisbon("20261103T110000"), "Standup (moved)"));

        let monthly = SERIES.replace("RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=4", "RRULE:FREQ=MONTHLY;INTERVAL=2;BYDAY=-1FR;UNTIL=20270101T000000Z");
        let r = shape(&monthly, "UTC").unwrap().rule.unwrap();
        assert_eq!((r.interval, r.byday.clone(), r.until.as_deref()), (2, vec![(-1, "FR".to_string())], Some("2027-01-01")));
        assert!(shape(&SERIES.replace("RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=4\r\n", ""), "UTC").unwrap().rule.is_none());
        let zoned = new_event("z", &EventInput { repeat: Repeat::Weekly, ..input("2026-10-20T15:00", "2026-10-20T16:00") }).unwrap();
        assert!(zoned.contains("BEGIN:VTIMEZONE"));
        assert_eq!(shape(&zoned, "UTC").unwrap().rule.map(|r| (r.freq, r.byday)), Some(("WEEKLY".to_string(), vec![])), "the zone's DST rules aren't the event's");
    }
}
