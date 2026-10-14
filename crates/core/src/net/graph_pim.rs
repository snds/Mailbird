//! Outlook calendars and contacts over Microsoft Graph, behind the same
//! contract as CalDAV/CardDAV ([`super::dav`]).
//!
//! Outlook.com has no CalDAV or CardDAV, so this adapter translates: Graph
//! events become iCalendar objects and Graph contacts become vCards on the
//! way in, and the store's iCalendar and vCard edits become Graph JSON on the
//! way out. The store, the editors, reminders, and invitations don't know
//! the difference.
//!
//! - **Hrefs** are Graph paths: `/calendars/{id}/` for a calendar,
//!   `/events/{id}` and `/contacts/{id}` for items. A new local item has a
//!   made-up href until Graph picks its id; the push returns
//!   [`DavOutcome::Created`] with the real one.
//! - **Etags** are Graph's `@odata.etag`. A series also folds in its
//!   exceptions' etags (after `#`), so editing one occurrence in Outlook is
//!   noticed. `If-Match` sends only the series' own part.
//! - **Times** come back in UTC (`Prefer: outlook.timezone="UTC"`) and are
//!   written in the event's own zone (`originalStartTimeZone`, which calcard
//!   maps from Windows names to IANA), so a weekly 9:00 stays 9:00 across
//!   daylight saving. Times go out as wall-clock time in an IANA zone.
//! - **Sync** lists every item's id and etag, and fetches only what changed,
//!   like CalDAV without `sync-collection`.
//!
//! What doesn't translate: rules Graph can't express (BYHOUR, several
//! BYMONTHDAY values…) keep the server's rule; Outlook holds one reminder
//! per event; contacts hold at most three emails, two work and two home
//! phones, and one mobile.

use std::collections::HashMap;
use std::str::FromStr;

use calcard::common::timezone::Tz;
use chrono::{DateTime, Datelike, NaiveDate, NaiveDateTime, TimeZone};
use futures::{StreamExt, TryStreamExt};
use serde_json::{Value, json};

use super::dav::{DavPlan, DavResult};
use super::graph::{Api, CHANGED, Reply};
use crate::ical::{self, Rule, Shape, esc};
use crate::{AccountConfig, CollectionKind, DavBatch, DavChange, DavCursor, DavOutcome, Error, RemoteCollection, Result, vcard};

/// Items fetched at once.
const PARALLEL: usize = 8;
const PREFER: &str = "outlook.timezone=\"UTC\", outlook.body-content-type=\"text\"";
const DAYS: [(&str, &str); 7] = [("SU", "sunday"), ("MO", "monday"), ("TU", "tuesday"), ("WE", "wednesday"), ("TH", "thursday"), ("FR", "friday"), ("SA", "saturday")];
const INDEX: [(i32, &str); 5] = [(1, "first"), (2, "second"), (3, "third"), (4, "fourth"), (-1, "last")];

/// Outlook calendars and contacts for one signed-in account.
pub struct Pim {
    api: Api,
    /// The signed-in address: finds your own answer on an invitation.
    address: String,
    /// The device's IANA zone: places all-day events, and is the fallback zone.
    tz: String,
}

fn zone_of(name: Option<&str>) -> Option<Tz> {
    let tz = Tz::from_str(name?).ok()?;
    // Only named zones carry daylight saving; anything else is written in UTC.
    matches!(tz, Tz::Tz(_)).then_some(tz).filter(|t| t.to_string() != "UTC")
}

/// Graph's `"2026-10-14T16:00:00.0000000"` (UTC, as we ask for) → Unix seconds.
fn utc_ts(v: &Value) -> Option<i64> {
    let s = v["dateTime"].as_str()?;
    NaiveDateTime::parse_from_str(s.get(..19)?, "%Y-%m-%dT%H:%M:%S").ok().map(|n| n.and_utc().timestamp())
}

/// `"2026-10-21T16:00:00Z"` (a DateTimeOffset) → Unix seconds.
fn offset_ts(v: &Value) -> Option<i64> {
    DateTime::parse_from_rfc3339(v.as_str()?).ok().map(|d| d.timestamp())
}

/// iCalendar parameter values can't carry `:;,` bare.
fn param(s: &str) -> String {
    let s = s.replace('"', "");
    if s.contains([':', ';', ',']) { format!("\"{s}\"") } else { s }
}

fn etag_of(item: &Value) -> String {
    item["@odata.etag"].as_str().map(str::to_owned).unwrap_or_else(|| format!("W/\"{}\"", item["changeKey"].as_str().unwrap_or_default()))
}

/// The series' own etag, plus a digest of its exceptions' (see the module docs).
fn series_etag(item: &Value) -> String {
    let mut parts: Vec<String> = item["exceptionOccurrences"].as_array().into_iter().flatten().map(etag_of).collect();
    if parts.is_empty() {
        return etag_of(item);
    }
    parts.sort();
    let digest = ring::digest::digest(&ring::digest::SHA256, parts.join(",").as_bytes());
    let hex: String = digest.as_ref()[..6].iter().map(|b| format!("{b:02x}")).collect();
    format!("{}#{hex}", etag_of(item))
}

/// What `If-Match` sends for a stored etag.
fn if_match(etag: &str) -> &str {
    etag.split('#').next().unwrap_or(etag)
}

/// How an occurrence time is written: in the event's zone, as a date, or in UTC.
pub struct Clock {
    tz: Option<Tz>,
    all_day: bool,
    /// Zone for all-day dates.
    day_tz: Tz,
}

impl Clock {
    fn line(&self, prop: &str, ts: i64) -> String {
        let at = DateTime::from_timestamp(ts, 0).unwrap_or_default();
        if self.all_day {
            format!("{prop};VALUE=DATE:{}", at.with_timezone(&self.day_tz).format("%Y%m%d"))
        } else if let Some(tz) = &self.tz {
            format!("{prop};TZID={tz}:{}", at.with_timezone(tz).format("%Y%m%dT%H%M%S"))
        } else {
            format!("{prop}:{}", at.format("%Y%m%dT%H%M%SZ"))
        }
    }

    fn zone(&self) -> &Tz {
        self.tz.as_ref().unwrap_or(&self.day_tz)
    }
}

fn day_code(name: &str) -> Option<&'static str> {
    DAYS.iter().find(|(_, n)| n.eq_ignore_ascii_case(name)).map(|(c, _)| *c)
}

fn day_name(code: &str) -> Option<&'static str> {
    DAYS.iter().find(|(c, _)| c.eq_ignore_ascii_case(code)).map(|(_, n)| *n)
}

/// Graph's `patternedRecurrence` → an RRULE value. `start` is the series'
/// first start on its own clock; parts that only restate it are left out, so
/// a plain "every week" stays editable as such.
pub fn rrule(rec: &Value, start: NaiveDateTime, clock: &Clock) -> Option<String> {
    let p = &rec["pattern"];
    let interval = p["interval"].as_u64().unwrap_or(1).max(1);
    let days: Vec<&str> = p["daysOfWeek"].as_array().into_iter().flatten().filter_map(|d| d.as_str().and_then(day_code)).collect();
    let index = INDEX.iter().find(|(_, n)| p["index"].as_str() == Some(n)).map(|(i, _)| *i).unwrap_or(1);
    let month = p["month"].as_u64().unwrap_or(0) as u32;
    let mday = p["dayOfMonth"].as_u64().unwrap_or(0) as u32;
    let start_day = DAYS[start.weekday().num_days_from_sunday() as usize].0;
    let relative = |parts: &mut Vec<String>| {
        if days.len() == 1 {
            parts.push(format!("BYDAY={index}{}", days[0]));
        } else {
            parts.push(format!("BYDAY={}", days.join(",")));
            parts.push(format!("BYSETPOS={index}"));
        }
    };
    let mut parts = Vec::new();
    match p["type"].as_str()? {
        "daily" => parts.push("FREQ=DAILY".to_string()),
        "weekly" => {
            parts.push("FREQ=WEEKLY".into());
            if !(days.len() == 1 && days[0] == start_day) && !days.is_empty() {
                parts.push(format!("BYDAY={}", days.join(",")));
                if interval > 1 {
                    let wkst = p["firstDayOfWeek"].as_str().and_then(day_code).unwrap_or("SU");
                    parts.push(format!("WKST={wkst}"));
                }
            }
        }
        "absoluteMonthly" => {
            parts.push("FREQ=MONTHLY".into());
            if mday != start.day() {
                parts.push(format!("BYMONTHDAY={mday}"));
            }
        }
        "relativeMonthly" => {
            parts.push("FREQ=MONTHLY".into());
            relative(&mut parts);
        }
        "absoluteYearly" => {
            parts.push("FREQ=YEARLY".into());
            if month != start.month() || mday != start.day() {
                parts.push(format!("BYMONTH={month}"));
                parts.push(format!("BYMONTHDAY={mday}"));
            }
        }
        "relativeYearly" => {
            parts.push("FREQ=YEARLY".into());
            parts.push(format!("BYMONTH={month}"));
            relative(&mut parts);
        }
        _ => return None,
    }
    if interval > 1 {
        parts.insert(1, format!("INTERVAL={interval}"));
    }
    let r = &rec["range"];
    match r["type"].as_str() {
        Some("numbered") => parts.push(format!("COUNT={}", r["numberOfOccurrences"].as_u64().unwrap_or(1).max(1))),
        Some("endDate") => {
            let end = NaiveDate::parse_from_str(r["endDate"].as_str()?, "%Y-%m-%d").ok()?;
            if clock.all_day {
                parts.push(format!("UNTIL={}", end.format("%Y%m%d")));
            } else {
                // The end of that day on the event's clock, in UTC (RFC 5545 §3.3.10).
                let last = clock.zone().from_local_datetime(&end.and_hms_opt(23, 59, 59)?).earliest()?;
                parts.push(format!("UNTIL={}", last.with_timezone(&chrono::Utc).format("%Y%m%dT%H%M%SZ")));
            }
        }
        _ => {}
    }
    Some(parts.join(";"))
}

fn partstat(response: Option<&str>) -> &'static str {
    match response {
        Some("accepted" | "organizer") => "ACCEPTED",
        Some("declined") => "DECLINED",
        Some("tentativelyAccepted") => "TENTATIVE",
        _ => "NEEDS-ACTION",
    }
}

fn describe(e: &Value, lines: &mut Vec<String>) {
    lines.push(format!("SUMMARY:{}", esc(e["subject"].as_str().unwrap_or_default().trim())));
    if let Some(l) = e["location"]["displayName"].as_str().map(str::trim).filter(|l| !l.is_empty()) {
        lines.push(format!("LOCATION:{}", esc(l)));
    }
    if let Some(b) = e["body"]["content"].as_str().map(str::trim).filter(|b| !b.is_empty()) {
        lines.push(format!("DESCRIPTION:{}", esc(b)));
    }
}

/// A Graph event (with its `exceptionOccurrences`) as an iCalendar object.
/// `device_tz` places all-day events that have no zone of their own.
pub fn event_to_ics(e: &Value, device_tz: &str) -> Result<String> {
    let bad = || Error::Parse("Outlook sent an event without a start".into());
    let all_day = e["isAllDay"].as_bool().unwrap_or(false);
    let tz = zone_of(e["originalStartTimeZone"].as_str());
    let day_tz = tz.unwrap_or_else(|| Tz::from_str(device_tz).unwrap_or_default());
    let clock = Clock { tz, all_day, day_tz };
    let start = utc_ts(&e["start"]).ok_or_else(bad)?;
    let end = utc_ts(&e["end"]).unwrap_or(start);
    let uid = e["iCalUId"].as_str().or(e["id"].as_str()).unwrap_or_default();

    let mut lines = vec![format!("UID:{uid}")];
    if let Some(m) = e["lastModifiedDateTime"].as_str().and_then(|s| DateTime::parse_from_rfc3339(s).ok()) {
        lines.push(format!("DTSTAMP:{}", m.with_timezone(&chrono::Utc).format("%Y%m%dT%H%M%SZ")));
    }
    describe(e, &mut lines);
    lines.push(clock.line("DTSTART", start));
    lines.push(clock.line("DTEND", end));
    let local_start = DateTime::from_timestamp(start, 0).unwrap_or_default().with_timezone(clock.zone()).naive_local();
    if let Some(rule) = e.get("recurrence").filter(|r| !r.is_null()).and_then(|r| rrule(r, local_start, &clock)) {
        lines.push(format!("RRULE:{rule}"));
        // "OID.{series id}.2026-10-28": that day's slot, at the series' time.
        for c in e["cancelledOccurrences"].as_array().into_iter().flatten().filter_map(Value::as_str) {
            let Some(day) = c.get(c.len().saturating_sub(10)..).and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok()) else {
                continue;
            };
            let at = clock.zone().from_local_datetime(&day.and_time(local_start.time())).earliest();
            if let Some(at) = at {
                lines.push(clock.line("EXDATE", at.timestamp()));
            }
        }
    }
    if e["isCancelled"].as_bool() == Some(true) {
        lines.push("STATUS:CANCELLED".into());
    }
    if let Some(url) = e["onlineMeeting"]["joinUrl"].as_str().filter(|u| !u.is_empty()) {
        lines.push(format!("URL:{url}"));
    }
    let attendees = e["attendees"].as_array().cloned().unwrap_or_default();
    if !attendees.is_empty() {
        let o = &e["organizer"]["emailAddress"];
        if let Some(addr) = o["address"].as_str() {
            lines.push(format!("ORGANIZER;CN={}:mailto:{addr}", param(o["name"].as_str().unwrap_or(addr))));
        }
        for a in &attendees {
            let Some(addr) = a["emailAddress"]["address"].as_str() else {
                continue;
            };
            let name = param(a["emailAddress"]["name"].as_str().unwrap_or(addr));
            lines.push(format!("ATTENDEE;CN={name};PARTSTAT={}:mailto:{addr}", partstat(a["status"]["response"].as_str())));
        }
    }
    let mut body: String = lines.iter().map(|l| format!("{l}\r\n")).collect();
    if e["isReminderOn"].as_bool() == Some(true) {
        let m = e["reminderMinutesBeforeStart"].as_i64().unwrap_or(15);
        body.push_str(&format!("BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Reminder\r\nTRIGGER:-PT{m}M\r\nEND:VALARM\r\n"));
    }
    let mut ics = format!("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Mailbird//Outlook//EN\r\nBEGIN:VEVENT\r\n{body}END:VEVENT\r\n");
    for x in e["exceptionOccurrences"].as_array().into_iter().flatten() {
        let (Some(original), Some(s)) = (offset_ts(&x["originalStart"]), utc_ts(&x["start"])) else {
            continue;
        };
        let mut lines = vec![format!("UID:{uid}"), clock.line("RECURRENCE-ID", original)];
        describe(x, &mut lines);
        lines.push(clock.line("DTSTART", s));
        lines.push(clock.line("DTEND", utc_ts(&x["end"]).unwrap_or(s)));
        ics.push_str("BEGIN:VEVENT\r\n");
        for l in lines {
            ics.push_str(&l);
            ics.push_str("\r\n");
        }
        ics.push_str("END:VEVENT\r\n");
    }
    ics.push_str("END:VCALENDAR\r\n");
    // Round-trip through the parser: it adds VTIMEZONEs and rejects anything broken.
    ical::read_event(&ics, device_tz)?;
    Ok(ics)
}

/// `{ dateTime, timeZone }` for Graph: wall-clock time in an IANA zone.
fn graph_time(ts: i64, tz: &Tz, all_day: bool) -> Value {
    let local = DateTime::from_timestamp(ts, 0).unwrap_or_default().with_timezone(tz);
    let dt = if all_day { local.format("%Y-%m-%dT00:00:00").to_string() } else { local.format("%Y-%m-%dT%H:%M:%S").to_string() };
    json!({ "dateTime": dt, "timeZone": tz.to_string() })
}

/// An RRULE → Graph's `patternedRecurrence`, or `None` when Graph can't
/// express it (then the server's rule is left as it is).
pub fn recurrence(rule: &Rule, start: NaiveDateTime) -> Option<Value> {
    if !rule.other.is_empty() || rule.bysetpos.len() > 1 {
        return None;
    }
    let names = |days: &[(i32, String)]| days.iter().map(|(_, d)| day_name(d)).collect::<Option<Vec<_>>>();
    let plain_days = rule.byday.iter().all(|(n, _)| *n == 0);
    let start_day = DAYS[start.weekday().num_days_from_sunday() as usize].1;
    let index_name = |i: i32| INDEX.iter().find(|(n, _)| *n == i).map(|(_, s)| *s);
    // Relative patterns: one ordinal day ("the last Friday"), or several days with one BYSETPOS.
    let relative = || -> Option<(Vec<&'static str>, &'static str)> {
        match (rule.byday.as_slice(), rule.bysetpos.as_slice()) {
            ([(n, d)], []) if *n != 0 => Some((vec![day_name(d)?], index_name(*n)?)),
            (days, [pos]) if !days.is_empty() && plain_days => Some((names(days)?, index_name(*pos)?)),
            _ => None,
        }
    };
    let interval = rule.interval.max(1);
    let pattern = match rule.freq.as_str() {
        "DAILY" if rule.byday.is_empty() && rule.bymonthday.is_empty() => {
            json!({ "type": "daily", "interval": interval })
        }
        // "Every weekday" arrives as FREQ=DAILY;BYDAY=MO,…,FR.
        "DAILY" | "WEEKLY" if plain_days && rule.bymonthday.is_empty() && rule.bysetpos.is_empty() => {
            let days = if rule.byday.is_empty() { vec![start_day] } else { names(&rule.byday)? };
            let first = rule.wkst.as_deref().and_then(day_name).unwrap_or("sunday");
            json!({ "type": "weekly", "interval": interval, "daysOfWeek": days, "firstDayOfWeek": first })
        }
        "MONTHLY" | "YEARLY" => {
            let yearly = rule.freq == "YEARLY";
            let month = match rule.bymonth.as_slice() {
                [] => start.month(),
                [m] => *m,
                _ => return None,
            };
            if !rule.byday.is_empty() {
                let (days, index) = relative()?;
                let kind = if yearly { "relativeYearly" } else { "relativeMonthly" };
                let mut p = json!({ "type": kind, "interval": interval, "daysOfWeek": days, "index": index });
                if yearly {
                    p["month"] = json!(month);
                }
                p
            } else {
                let day = match rule.bymonthday.as_slice() {
                    [] => start.day(),
                    [d] if *d > 0 => *d as u32,
                    _ => return None,
                };
                let kind = if yearly { "absoluteYearly" } else { "absoluteMonthly" };
                let mut p = json!({ "type": kind, "interval": interval, "dayOfMonth": day });
                if yearly {
                    p["month"] = json!(month);
                }
                p
            }
        }
        _ => return None,
    };
    let start_date = start.format("%Y-%m-%d").to_string();
    let range = match (rule.count, &rule.until) {
        (Some(n), _) => {
            json!({ "type": "numbered", "startDate": start_date, "numberOfOccurrences": n })
        }
        (None, Some(until)) => {
            json!({ "type": "endDate", "startDate": start_date, "endDate": until })
        }
        (None, None) => json!({ "type": "noEnd", "startDate": start_date }),
    };
    Some(json!({ "pattern": pattern, "range": range }))
}

/// Whether two recurrences mean the same (Graph echoes extra fields back).
fn same_recurrence(a: &Value, b: &Value) -> bool {
    let key = |r: &Value| {
        let p = &r["pattern"];
        let mut days: Vec<String> = p["daysOfWeek"].as_array().into_iter().flatten().filter_map(|d| d.as_str().map(str::to_ascii_lowercase)).collect();
        days.sort();
        let multi_day = matches!(p["type"].as_str(), Some("weekly" | "relativeMonthly" | "relativeYearly"));
        let month = if matches!(p["type"].as_str(), Some("absoluteYearly" | "relativeYearly")) { p["month"].as_u64() } else { None };
        let day = if matches!(p["type"].as_str(), Some("absoluteMonthly" | "absoluteYearly")) { p["dayOfMonth"].as_u64() } else { None };
        let index = if p["type"].as_str().is_some_and(|t| t.starts_with("relative")) { p["index"].as_str().map(str::to_owned) } else { None };
        let rg = &r["range"];
        let kind = rg["type"].as_str().unwrap_or("noEnd").to_owned();
        let end = if kind == "endDate" { rg["endDate"].as_str().map(str::to_owned) } else { None };
        let count = if kind == "numbered" { rg["numberOfOccurrences"].as_u64() } else { None };
        (p["type"].as_str().map(str::to_owned), p["interval"].as_u64().unwrap_or(1), if multi_day { days } else { vec![] }, month, day, index, kind, end, count)
    };
    key(a) == key(b)
}

/// The event's own zone as an IANA name, else the device's.
fn push_zone(shape: &Shape, device_tz: &str) -> Tz {
    zone_of(shape.meta.time_zone.as_deref()).unwrap_or_else(|| Tz::from_str(device_tz).unwrap_or_default())
}

/// The Graph fields for an event the account organizes (or a plain event).
pub fn event_json(shape: &Shape, device_tz: &str) -> Value {
    let m = &shape.meta;
    let day_tz = Tz::from_str(device_tz).unwrap_or_default();
    let tz = if m.all_day { day_tz } else { push_zone(shape, device_tz) };
    let mut v = json!({
        "subject": m.title,
        "body": { "contentType": "text", "content": m.notes.clone().unwrap_or_default() },
        "location": { "displayName": m.location.clone().unwrap_or_default() },
        "start": graph_time(shape.start, &tz, m.all_day),
        "end": graph_time(shape.end, &tz, m.all_day),
        "isAllDay": m.all_day,
    });
    reminder_fields(m.reminders.as_slice(), &mut v);
    if !m.attendees.is_empty() {
        v["attendees"] = m
            .attendees
            .iter()
            .filter(|a| m.organizer.as_ref().is_none_or(|o| !o.email.eq_ignore_ascii_case(&a.email)))
            .map(|a| json!({ "emailAddress": { "address": a.email, "name": a.name.clone().unwrap_or_else(|| a.email.clone()) }, "type": "required" }))
            .collect::<Vec<_>>()
            .into();
    }
    v
}

/// Outlook keeps one reminder: the one closest to the start.
fn reminder_fields(minutes: &[i64], v: &mut Value) {
    match minutes.iter().copied().filter(|m| *m >= 0).min() {
        Some(m) => {
            v["isReminderOn"] = json!(true);
            v["reminderMinutesBeforeStart"] = json!(m);
        }
        None => v["isReminderOn"] = json!(false),
    }
}

/// A Graph contact as a vCard 4.0.
pub fn contact_to_vcf(c: &Value) -> String {
    let s = |k: &str| c[k].as_str().map(str::trim).filter(|v| !v.is_empty());
    let given = s("givenName").unwrap_or_default();
    let family = s("surname").unwrap_or_default();
    let emails: Vec<&str> = c["emailAddresses"].as_array().into_iter().flatten().filter_map(|e| e["address"].as_str()).filter(|a| !a.is_empty()).collect();
    let full = s("displayName")
        .map(str::to_owned)
        .or_else(|| Some(format!("{given} {family}").trim().to_owned()).filter(|n| !n.is_empty()))
        .or_else(|| emails.first().map(|e| e.to_string()))
        .unwrap_or_else(|| "Unnamed".into());
    let mut lines = vec!["BEGIN:VCARD".to_string(), "VERSION:4.0".into(), format!("UID:{}", c["id"].as_str().unwrap_or_default()), format!("FN:{}", esc(&full))];
    lines.push(format!("N:{};{};{};;", esc(family), esc(given), esc(s("middleName").unwrap_or_default())));
    for e in &emails {
        lines.push(format!("EMAIL:{e}"));
    }
    for (key, label) in [("businessPhones", "work"), ("homePhones", "home")] {
        for p in c[key].as_array().into_iter().flatten().filter_map(Value::as_str).filter(|p| !p.is_empty()) {
            lines.push(format!("TEL;TYPE={label}:{p}"));
        }
    }
    if let Some(p) = s("mobilePhone") {
        lines.push(format!("TEL;TYPE=cell:{p}"));
    }
    if let Some(o) = s("companyName") {
        lines.push(format!("ORG:{}", esc(o)));
    }
    if let Some(t) = s("jobTitle") {
        lines.push(format!("TITLE:{}", esc(t)));
    }
    if let Some(n) = s("personalNotes") {
        lines.push(format!("NOTE:{}", esc(n)));
    }
    if let Some(b) = s("birthday").and_then(|b| b.get(..10)) {
        lines.push(format!("BDAY:{}", b.replace('-', "")));
    }
    // Outlook categories are labels.
    let categories: Vec<String> = c["categories"].as_array().into_iter().flatten().filter_map(Value::as_str).map(|l| esc(&l.replace(',', " "))).filter(|l| !l.is_empty()).collect();
    if !categories.is_empty() {
        lines.push(format!("CATEGORIES:{}", categories.join(",")));
    }
    lines.push("END:VCARD".into());
    lines.iter().map(|l| format!("{l}\r\n")).collect()
}

/// The Graph fields for a vCard. Every field is sent, so clearing one clears it.
pub fn contact_json(vcf: &str) -> Result<Value> {
    let m = vcard::read_contact(vcf)?;
    let label = |f: &crate::ContactField| f.label.clone().unwrap_or_default();
    let mut business = Vec::new();
    let mut home = Vec::new();
    let mut mobile = None;
    for p in &m.phones {
        match label(p).as_str() {
            "home" => home.push(p.value.clone()),
            "cell" | "mobile" | "iphone" if mobile.is_none() => mobile = Some(p.value.clone()),
            _ if mobile.is_none() && p.label.is_none() => mobile = Some(p.value.clone()),
            _ => business.push(p.value.clone()),
        }
    }
    business.truncate(2);
    home.truncate(2);
    let birthday = m.birthday.as_deref().filter(|b| b.len() == 10 && !b.starts_with("--")).map(|b| format!("{b}T12:00:00Z"));
    Ok(json!({
        "displayName": m.full_name,
        "givenName": m.given,
        "surname": m.family,
        "emailAddresses": m.emails.iter().take(3).map(|e| json!({ "address": e.value, "name": m.full_name })).collect::<Vec<_>>(),
        "businessPhones": business,
        "homePhones": home,
        "mobilePhone": mobile,
        "companyName": m.org,
        "jobTitle": m.title,
        "personalNotes": m.note.clone().unwrap_or_default(),
        "birthday": birthday,
        "categories": m.labels,
    }))
}

/// A reply's body, or `None` when the item is gone (404) or changed (412):
/// both mean the server's copy wins.
fn found(r: Result<Reply>) -> Result<Option<Value>> {
    match r {
        Ok(Reply::Ok(v)) => Ok(Some(v)),
        Ok(Reply::Gone) => Ok(None),
        Err(Error::Invalid(m)) if m == CHANGED => Ok(None),
        Err(e) => Err(e),
    }
}

/// The collection path a new item's made-up href sits in (`/calendars/x/a.ics` → `/calendars/x/`).
fn parent(href: &str) -> &str {
    href.rfind('/').map(|i| &href[..=i]).unwrap_or("/")
}

/// The Graph item a stored href names: `/events/{id}` → `id`.
fn item_id(href: &str) -> &str {
    href.rsplit('/').next().unwrap_or(href)
}

impl Pim {
    pub fn new(config: &AccountConfig, token: &str, device_tz: &str) -> Result<Self> {
        Ok(Self { api: Api::new(config, token)?.with_prefer(PREFER), address: config.address.clone(), tz: device_tz.to_owned() })
    }

    /// Tries a request with `$expand=exceptionOccurrences`, then without
    /// (for servers that don't offer it, where exceptions are simply missing).
    async fn get_expanded(&self, path: &str, plain: &str) -> Result<Reply> {
        match self.api.get(path).await {
            Err(Error::Invalid(m)) if m != CHANGED => self.api.get(plain).await,
            r => r,
        }
    }

    async fn list_expanded(&self, path: &str, plain: &str) -> Result<Vec<Value>> {
        match self.api.all(path).await {
            Err(Error::Invalid(m)) if m != CHANGED => self.api.all(plain).await,
            r => r,
        }
    }

    pub async fn discover(&self, kind: CollectionKind) -> Result<Vec<RemoteCollection>> {
        Ok(match kind {
            CollectionKind::Calendar => self
                .api
                .all("/calendars?$select=id,name,hexColor,canEdit")
                .await?
                .into_iter()
                .filter_map(|c| {
                    Some(RemoteCollection {
                        href: format!("/calendars/{}/", c["id"].as_str()?),
                        kind,
                        name: c["name"].as_str().unwrap_or("Calendar").to_owned(),
                        color: c["hexColor"].as_str().filter(|h| h.starts_with('#')).map(str::to_owned),
                        writable: c["canEdit"].as_bool().unwrap_or(true),
                        // Exchange sends invitations and replies itself.
                        scheduling: true,
                    })
                })
                .collect(),
            CollectionKind::Contacts => vec![RemoteCollection { href: "/contacts/".into(), kind, name: "Contacts".into(), color: None, writable: true, scheduling: false }],
        })
    }

    /// Changes since `cursor`: every item's etag, then bodies for what changed.
    pub async fn pull(&self, kind: CollectionKind, cursor: &DavCursor) -> Result<DavBatch> {
        let (items, prefix) = match kind {
            CollectionKind::Calendar => {
                let base = format!("{}events?$select=id,changeKey", cursor.href.trim_end_matches('/').to_owned() + "/");
                (self.list_expanded(&format!("{base}&$expand=exceptionOccurrences($select=id,changeKey)"), &base).await?, "/events/")
            }
            CollectionKind::Contacts => (self.api.all("/contacts?$select=id,changeKey").await?, "/contacts/"),
        };
        let on_server: HashMap<String, String> =
            items.iter().filter_map(|i| Some((format!("{prefix}{}", i["id"].as_str()?), if kind == CollectionKind::Calendar { series_etag(i) } else { etag_of(i) }))).collect();
        let removed = cursor.etags.keys().filter(|h| !on_server.contains_key(*h)).cloned().collect();
        let wanted: Vec<(String, String)> = on_server.into_iter().filter(|(h, e)| cursor.etags.get(h) != Some(e)).collect();
        let fetches: Vec<_> = wanted.into_iter().map(|(href, etag)| self.fetch(kind, href, etag)).collect();
        let upserts: Vec<Option<(String, String, String)>> = futures::stream::iter(fetches).buffered(PARALLEL).try_collect().await?;
        Ok(DavBatch { sync_token: None, upserts: upserts.into_iter().flatten().collect(), removed })
    }

    /// One changed item's body, or `None` if it's gone (or doesn't translate).
    async fn fetch(&self, kind: CollectionKind, href: String, etag: String) -> Result<Option<(String, String, String)>> {
        let id = item_id(&href).to_owned();
        let body = match kind {
            CollectionKind::Calendar => match self.get_expanded(&format!("/events/{id}?$expand=exceptionOccurrences"), &format!("/events/{id}")).await? {
                // One event that doesn't translate mustn't stop the calendar.
                Reply::Ok(e) => event_to_ics(&e, &self.tz).ok(),
                Reply::Gone => None,
            },
            CollectionKind::Contacts => match self.api.get(&format!("/contacts/{id}")).await? {
                Reply::Ok(c) => Some(contact_to_vcf(&c)),
                Reply::Gone => None,
            },
        };
        Ok(body.map(|b| (href, etag, b)))
    }

    /// Pushes one local change. The server wins any race: a 412 or a 404 on
    /// an edit comes back as `Conflict`, like CalDAV.
    pub async fn push(&self, kind: CollectionKind, change: &DavChange) -> Result<DavOutcome> {
        let id = item_id(&change.href).to_owned();
        let item = match kind {
            CollectionKind::Calendar => "events",
            CollectionKind::Contacts => "contacts",
        };
        let Some(body) = &change.body else {
            // Never reached the server: nothing to delete there.
            let Some(etag) = &change.etag else {
                return Ok(DavOutcome::Deleted);
            };
            return match self.api.delete(&format!("/{item}/{id}"), Some(if_match(etag))).await {
                Ok(_) => Ok(DavOutcome::Deleted),
                Err(Error::Invalid(m)) if m == CHANGED => Ok(DavOutcome::Conflict),
                Err(e) => Err(e),
            };
        };
        match kind {
            CollectionKind::Contacts => {
                let json = contact_json(body)?;
                match &change.etag {
                    None => match self.api.post("/contacts", json).await? {
                        Reply::Ok(v) => Ok(DavOutcome::Created(format!("/contacts/{}", v["id"].as_str().unwrap_or_default()), None)),
                        Reply::Gone => Err(Error::Network("Outlook has no contacts for this account".into())),
                    },
                    Some(etag) => Ok(match found(self.api.patch(&format!("/contacts/{id}"), json, Some(if_match(etag))).await)? {
                        Some(_) => DavOutcome::Saved(None),
                        None => DavOutcome::Conflict,
                    }),
                }
            }
            CollectionKind::Calendar => {
                let shape = ical::shape(body, &self.tz)?;
                let mut json = event_json(&shape, &self.tz);
                let start_local = DateTime::from_timestamp(shape.start, 0).unwrap_or_default().with_timezone(&push_zone(&shape, &self.tz)).naive_local();
                let wanted = shape.rule.as_ref().and_then(|r| recurrence(r, start_local));
                let Some(etag) = &change.etag else {
                    if let Some(r) = &wanted {
                        json["recurrence"] = r.clone();
                    }
                    let calendar = parent(&change.href);
                    let Reply::Ok(v) = self.api.post(&format!("{calendar}events"), json).await? else {
                        return Err(Error::Network("Outlook couldn't find this calendar — it may have been removed".into()));
                    };
                    let new_id = v["id"].as_str().unwrap_or_default().to_owned();
                    self.push_occurrences(&new_id, &shape).await?;
                    return Ok(DavOutcome::Created(format!("/events/{new_id}"), None));
                };
                let Some(server) = found(self.api.get(&format!("/events/{id}?$select=isOrganizer,recurrence,responseStatus")).await)? else {
                    return Ok(DavOutcome::Conflict);
                };
                if server["isOrganizer"].as_bool() == Some(false) {
                    return self.respond(&id, &shape, &server, etag).await;
                }
                // Changing the rule makes Outlook drop the series' exceptions, so
                // only send it when it really changed; occurrences are reapplied below.
                match (&wanted, server.get("recurrence").filter(|r| !r.is_null())) {
                    (Some(w), Some(s)) if same_recurrence(w, s) => {}
                    (Some(w), _) => json["recurrence"] = w.clone(),
                    (None, Some(_)) if shape.rule.is_none() => json["recurrence"] = Value::Null,
                    _ => {}
                }
                if found(self.api.patch(&format!("/events/{id}"), json, Some(if_match(etag))).await)?.is_none() {
                    return Ok(DavOutcome::Conflict);
                }
                self.push_occurrences(&id, &shape).await?;
                Ok(DavOutcome::Saved(None))
            }
        }
    }

    /// Invitations: answer through Graph (which emails the organizer), and
    /// keep the reminder. Nothing else of someone else's event is ours to edit.
    async fn respond(&self, id: &str, shape: &Shape, server: &Value, etag: &str) -> Result<DavOutcome> {
        // The reminder first: answering changes the event's etag.
        let mut v = json!({});
        reminder_fields(&shape.meta.reminders, &mut v);
        match self.api.patch(&format!("/events/{id}"), v, Some(if_match(etag))).await {
            Ok(_) => {}
            Err(Error::Invalid(m)) if m == CHANGED => return Ok(DavOutcome::Conflict),
            Err(e) => return Err(e),
        }
        let me = shape.meta.attendees.iter().find(|a| a.email.eq_ignore_ascii_case(&self.address));
        let now = server["responseStatus"]["response"].as_str();
        let action = me.and_then(|a| match a.status.as_deref() {
            Some("accepted") if now != Some("accepted") => Some("accept"),
            Some("declined") if now != Some("declined") => Some("decline"),
            Some("tentative") if now != Some("tentativelyAccepted") => Some("tentativelyAccept"),
            _ => None,
        });
        if let Some(action) = action {
            self.api.post(&format!("/events/{id}/{action}"), json!({ "sendResponse": true })).await?;
        }
        Ok(DavOutcome::Saved(None))
    }

    /// Moved, edited, and skipped occurrences: Graph keeps them as separate
    /// instances of the series, found by the slot they fill.
    async fn push_occurrences(&self, series: &str, shape: &Shape) -> Result<()> {
        let slots: Vec<i64> = shape.overrides.iter().map(|o| o.original).chain(shape.exdates.iter().copied()).collect();
        let (Some(from), Some(to)) = (slots.iter().min(), slots.iter().max()) else {
            return Ok(());
        };
        let iso = |t: i64| DateTime::from_timestamp(t, 0).unwrap_or_default().format("%Y-%m-%dT%H:%M:%SZ").to_string();
        let instances = self
            .api
            .all(&format!("/events/{series}/instances?startDateTime={}&endDateTime={}&$select=id,originalStart,subject,start", iso(from - 86_400), iso(to + 2 * 86_400)))
            .await?;
        let find = |slot: i64| instances.iter().find(|i| offset_ts(&i["originalStart"]).is_some_and(|t| (t - slot).abs() < 60)).and_then(|i| i["id"].as_str());
        let tz = if shape.meta.all_day { Tz::from_str(&self.tz).unwrap_or_default() } else { push_zone(shape, &self.tz) };
        for slot in &shape.exdates {
            if let Some(id) = find(*slot) {
                self.api.delete(&format!("/events/{id}"), None).await?;
            }
        }
        for o in &shape.overrides {
            let Some(id) = find(o.original) else { continue };
            let body = json!({
                "subject": o.title,
                "location": { "displayName": o.location.clone().unwrap_or_default() },
                "body": { "contentType": "text", "content": o.notes.clone().or_else(|| shape.meta.notes.clone()).unwrap_or_default() },
                "start": graph_time(o.start, &tz, shape.meta.all_day),
                "end": graph_time(o.end, &tz, shape.meta.all_day),
            });
            self.api.patch(&format!("/events/{id}"), body, None).await?;
        }
        Ok(())
    }
}

/// Pushes each collection's local changes, then pulls its server changes
/// (the same order and cursor handling as [`super::dav::sync`]).
pub async fn sync(pim: &Pim, plans: Vec<DavPlan>) -> Result<Vec<DavResult>> {
    let mut out = Vec::new();
    for plan in plans {
        let mut outcomes = Vec::new();
        let mut cursor = plan.cursor;
        for change in &plan.changes {
            let outcome = pim.push(plan.kind, change).await?;
            cursor.etags.remove(&change.href);
            outcomes.push((change.item_id.clone(), outcome));
        }
        let batch = pim.pull(plan.kind, &cursor).await?;
        out.push(DavResult { collection_id: plan.collection_id, outcomes, batch });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Repeat;

    fn weekly_series() -> Value {
        json!({
            "id": "AAMkSeries", "iCalUId": "040000008200E00074C5B7101A82E008", "@odata.etag": "W/\"etag1\"",
            "subject": "Design review", "body": { "contentType": "text", "content": "Agenda; tokens, variants" },
            "location": { "displayName": "Room 4" },
            "isAllDay": false, "originalStartTimeZone": "Pacific Standard Time",
            "start": { "dateTime": "2026-10-14T16:00:00.0000000", "timeZone": "UTC" },
            "end": { "dateTime": "2026-10-14T17:00:00.0000000", "timeZone": "UTC" },
            "recurrence": {
                "pattern": { "type": "weekly", "interval": 1, "daysOfWeek": ["wednesday"], "firstDayOfWeek": "sunday" },
                "range": { "type": "endDate", "startDate": "2026-10-14", "endDate": "2026-12-16" }
            },
            "isReminderOn": true, "reminderMinutesBeforeStart": 10,
            "organizer": { "emailAddress": { "name": "Sam Lee", "address": "sam@contoso.com" } },
            "attendees": [{ "emailAddress": { "name": "Ana, PM", "address": "ana@contoso.com" }, "status": { "response": "tentativelyAccepted" } }],
            "cancelledOccurrences": ["OID.AAMkSeries.2026-10-28"],
            "exceptionOccurrences": [{
                "@odata.etag": "W/\"x1\"", "subject": "Design review (moved)",
                "originalStart": "2026-11-04T17:00:00Z",
                "start": { "dateTime": "2026-11-05T17:00:00.0000000", "timeZone": "UTC" },
                "end": { "dateTime": "2026-11-05T18:00:00.0000000", "timeZone": "UTC" }
            }]
        })
    }

    #[test]
    fn outlook_series_becomes_icalendar() {
        let ics = event_to_ics(&weekly_series(), "Europe/Lisbon").unwrap();
        assert!(ics.contains("UID:040000008200E00074C5B7101A82E008"));
        assert!(ics.contains("DTSTART;TZID=America/Los_Angeles:20261014T090000"), "written on the event's own clock: {ics}");
        assert!(ics.contains("RRULE:FREQ=WEEKLY;UNTIL=20261217T075959Z"), "a plain weekly rule, ending at the end of Dec 16 in LA: {ics}");
        assert!(ics.contains("EXDATE;TZID=America/Los_Angeles:20261028T090000"));
        assert!(ics.contains("RECURRENCE-ID;TZID=America/Los_Angeles:20261104T090000"), "Nov 4 is after the DST change, still 9:00 there: {ics}");
        assert!(ics.contains("ATTENDEE;CN=\"Ana, PM\";PARTSTAT=TENTATIVE:mailto:ana@contoso.com"));
        assert!(ics.contains("DESCRIPTION:Agenda\\; tokens\\, variants"));
        let meta = ical::read_event(&ics, "Europe/Lisbon").unwrap();
        assert_eq!((meta.repeat, meta.reminders.clone()), (Repeat::Custom, vec![10]), "UNTIL makes it custom; one reminder");
        let occ = ical::occurrences(&ics, "Europe/Lisbon", 0, i64::MAX / 2).unwrap();
        assert_eq!(occ.len(), 9, "Oct 14 – Dec 16 is ten Wednesdays, one cancelled");
        assert!(occ.iter().any(|o| o.title == "Design review (moved)"));
    }

    #[test]
    fn all_day_and_plain_events() {
        let e = json!({
            "id": "AAMkDay", "subject": "Offsite", "isAllDay": true, "originalStartTimeZone": "W. Europe Standard Time",
            "start": { "dateTime": "2026-10-19T22:00:00.0000000", "timeZone": "UTC" },
            "end": { "dateTime": "2026-10-21T22:00:00.0000000", "timeZone": "UTC" },
            "isReminderOn": false, "attendees": []
        });
        let ics = event_to_ics(&e, "UTC").unwrap();
        assert!(ics.contains("DTSTART;VALUE=DATE:20261020") && ics.contains("DTEND;VALUE=DATE:20261022"), "{ics}");
        assert!(!ics.contains("ORGANIZER") && !ics.contains("VALARM"));
        let utc = json!({ "id": "x", "subject": "Call", "originalStartTimeZone": "tzone://Microsoft/Utc", "start": { "dateTime": "2026-10-19T09:00:00.0000000" }, "end": { "dateTime": "2026-10-19T09:30:00.0000000" } });
        assert!(event_to_ics(&utc, "UTC").unwrap().contains("DTSTART:20261019T090000Z"));
    }

    #[test]
    fn rules_translate_both_ways() {
        let start = NaiveDateTime::parse_from_str("2026-10-30T09:00:00", "%Y-%m-%dT%H:%M:%S").unwrap(); // a Friday
        let clock = Clock { tz: zone_of(Some("Europe/Lisbon")), all_day: false, day_tz: Tz::from_str("UTC").unwrap() };
        let rel = json!({ "pattern": { "type": "relativeMonthly", "interval": 2, "daysOfWeek": ["friday"], "index": "last" }, "range": { "type": "numbered", "numberOfOccurrences": 6 } });
        assert_eq!(rrule(&rel, start, &clock).as_deref(), Some("FREQ=MONTHLY;INTERVAL=2;BYDAY=-1FR;COUNT=6"));
        let weekdays =
            json!({ "pattern": { "type": "weekly", "interval": 1, "daysOfWeek": ["monday", "tuesday", "wednesday", "thursday", "friday"] }, "range": { "type": "noEnd" } });
        assert_eq!(rrule(&weekdays, start, &clock).as_deref(), Some("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"));
        let yearly = json!({ "pattern": { "type": "absoluteYearly", "interval": 1, "month": 10, "dayOfMonth": 30 }, "range": { "type": "noEnd" } });
        assert_eq!(rrule(&yearly, start, &clock).as_deref(), Some("FREQ=YEARLY"), "restating the start is left out");

        let rule = |s: &str| {
            ical::shape(&format!("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART;TZID=Europe/Lisbon:20261030T090000\r\nDTEND;TZID=Europe/Lisbon:20261030T100000\r\nRRULE:{s}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"), "UTC").unwrap().rule.unwrap()
        };
        let back = recurrence(&rule("FREQ=MONTHLY;INTERVAL=2;BYDAY=-1FR;COUNT=6"), start).unwrap();
        assert!(same_recurrence(&back, &rel), "{back}");
        let w = recurrence(&rule("FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR"), start).unwrap();
        assert!(same_recurrence(&w, &weekdays), "every weekday: {w}");
        assert_eq!(recurrence(&rule("FREQ=WEEKLY"), start).unwrap()["pattern"]["daysOfWeek"], json!(["friday"]));
        let until = recurrence(&rule("FREQ=WEEKLY;UNTIL=20261231T235959Z"), start).unwrap();
        assert_eq!(until["range"], json!({ "type": "endDate", "startDate": "2026-10-30", "endDate": "2026-12-31" }));
        assert!(recurrence(&rule("FREQ=DAILY;BYHOUR=9,17"), start).is_none(), "Graph can't say this; the server's rule stays");
        assert!(recurrence(&rule("FREQ=MONTHLY;BYMONTHDAY=1,15"), start).is_none());
    }

    #[test]
    fn events_go_out_on_their_own_clock() {
        let ics = event_to_ics(&weekly_series(), "Europe/Lisbon").unwrap();
        let shape = ical::shape(&ics, "Europe/Lisbon").unwrap();
        let v = event_json(&shape, "Europe/Lisbon");
        assert_eq!(v["start"], json!({ "dateTime": "2026-10-14T09:00:00", "timeZone": "America/Los_Angeles" }));
        assert_eq!((v["isReminderOn"].clone(), v["reminderMinutesBeforeStart"].clone()), (json!(true), json!(10)));
        assert_eq!(v["attendees"][0]["emailAddress"]["address"], "ana@contoso.com", "the organizer isn't invited to their own meeting");
        assert_eq!(shape.exdates.len(), 1);
        assert_eq!(shape.overrides.len(), 1);
        let start = DateTime::from_timestamp(shape.start, 0).unwrap().with_timezone(&push_zone(&shape, "UTC")).naive_local();
        let back = recurrence(shape.rule.as_ref().unwrap(), start).unwrap();
        assert!(same_recurrence(&back, &weekly_series()["recurrence"]), "unchanged rules aren't resent: {back}");
    }

    #[test]
    fn contacts_translate_both_ways() {
        let c = json!({
            "id": "AAMkC1", "displayName": "Ana Duarte", "givenName": "Ana", "surname": "Duarte",
            "emailAddresses": [{ "name": "Ana", "address": "ana@example.com" }],
            "businessPhones": ["+1 555 0100"], "homePhones": [], "mobilePhone": "+1 555 0199",
            "companyName": "Contoso; Ltd", "jobTitle": "Designer", "personalNotes": "Met at Config", "birthday": "1990-05-01T11:59:00Z",
            "categories": ["Clay club", "Red category"]
        });
        let vcf = contact_to_vcf(&c);
        assert!(vcf.contains("UID:AAMkC1\r\n") && vcf.contains("N:Duarte;Ana;;;") && vcf.contains("ORG:Contoso\\; Ltd"));
        let meta = vcard::read_contact(&vcf).unwrap();
        assert_eq!((meta.full_name.as_str(), meta.birthday.as_deref()), ("Ana Duarte", Some("1990-05-01")));
        let back = contact_json(&vcf).unwrap();
        assert_eq!(back["businessPhones"], json!(["+1 555 0100"]));
        assert_eq!(back["mobilePhone"], "+1 555 0199");
        assert_eq!(back["birthday"], "1990-05-01T12:00:00Z");
        assert_eq!(back["emailAddresses"][0]["address"], "ana@example.com");
        assert_eq!(back["companyName"], "Contoso; Ltd");
        assert_eq!(meta.labels, vec!["Clay club", "Red category"], "categories are labels");
        assert_eq!(back["categories"], json!(["Clay club", "Red category"]));
    }

    #[test]
    fn hrefs_and_etags() {
        assert_eq!(parent("/calendars/AAMkCal/0f3e.ics"), "/calendars/AAMkCal/");
        assert_eq!(item_id("/events/AAMk1"), "AAMk1");
        let e = series_etag(&weekly_series());
        assert!(e.starts_with("W/\"etag1\"#") && if_match(&e) == "W/\"etag1\"");
        assert_eq!(series_etag(&json!({ "changeKey": "ck" })), "W/\"ck\"");
    }
}
