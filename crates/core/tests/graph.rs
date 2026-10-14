//! Microsoft Graph adapters (Outlook mail, calendars, contacts) and Microsoft
//! token handling against a fake Graph API and token endpoint on 127.0.0.1.
//! Runs offline, in the normal test suite.
//!
//! The fake keeps per-folder delta state with immutable ids, `@removed`
//! entries, and expiring delta links; events with recurrence, exceptions,
//! cancelled occurrences, and instances that stay on their zone's clock
//! across daylight saving; contacts; etags with `If-Match`; and refresh-token
//! rotation. It also refuses any request that doesn't ask for immutable ids.

#![cfg(feature = "net")]

use std::collections::{BTreeMap, HashMap};
use std::str::FromStr;
use std::sync::{Arc, Mutex};

use base64::Engine;
use calcard::common::timezone::Tz;
use chrono::{DateTime, NaiveDate, NaiveDateTime, TimeZone};
use pim_core::{
    AccountConfig, CollectionKind, ContactField, ContactInput, DavChange, DavConfig, DavOutcome, Draft, EditScope, Error, EventInput, Lane, MessageQuery, OAuthAccount,
    OAuthIssuer, Provider, Repeat, Security, ServerConfig, Store,
    net::{dav::DavPlan, graph, graph_pim, oauth},
    store::{ARCHIVE, INBOX, SENT},
};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

struct Msg {
    raw: Vec<u8>,
    folder: String,
    read: bool,
    flagged: bool,
    /// Last change, on the fake's change counter.
    seq: u64,
}

#[derive(Default)]
struct Fake {
    base: String,
    access: String,
    refresh: u32,
    msgs: BTreeMap<String, Msg>,
    next: u32,
    seq: u64,
    /// (seq, folder, id): a message left a folder.
    removals: Vec<(u64, String, String)>,
    /// Delta tokens below this answer 410, as Graph does when sync state expires.
    oldest_delta: u64,
    sent: Vec<Vec<u8>>,
    /// Requests that didn't ask for immutable ids.
    mutable_ids: u32,
    events: BTreeMap<String, Value>,
    calendar_of: HashMap<String, String>,
    change_key: u64,
    /// Series PATCHes that carried a recurrence.
    recurrence_sent: u32,
    responses: Vec<(String, String)>,
    contacts: BTreeMap<String, Value>,
}

impl Fake {
    fn bump(&mut self) -> u64 {
        self.seq += 1;
        self.seq
    }

    fn key(&mut self) -> String {
        self.change_key += 1;
        format!("ck{}", self.change_key)
    }

    fn add(&mut self, subject: &str, folder: &str, read: bool) -> String {
        self.next += 1;
        let id = format!("AAMk-{:03}", self.next);
        let raw = format!("From: Ada <ada@example.com>\r\nTo: me@outlook.com\r\nSubject: {subject}\r\nMessage-ID: <{id}@example.com>\r\nDate: Tue, 13 Oct 2026 10:{:02}:00 +0000\r\n\r\nBody of {subject}\r\n", self.next % 60);
        let seq = self.bump();
        self.msgs.insert(id.clone(), Msg { raw: raw.into_bytes(), folder: folder.into(), read, flagged: false, seq });
        id
    }

    fn touch(&mut self, id: &str, f: impl FnOnce(&mut Msg)) {
        let seq = self.bump();
        let m = self.msgs.get_mut(id).unwrap();
        f(m);
        m.seq = seq;
    }

    fn move_to(&mut self, id: &str, folder: &str) {
        let seq = self.bump();
        let m = self.msgs.get_mut(id).unwrap();
        self.removals.push((seq, m.folder.clone(), id.to_owned()));
        m.folder = folder.into();
        m.seq = seq;
    }

    fn delete(&mut self, id: &str) {
        let seq = self.bump();
        let m = self.msgs.remove(id).unwrap();
        self.removals.push((seq, m.folder, id.to_owned()));
    }

    /// Newest first.
    fn in_folder(&self, folder: &str) -> Vec<(&String, &Msg)> {
        let mut v: Vec<_> = self.msgs.iter().filter(|(_, m)| m.folder == folder).collect();
        v.reverse();
        v
    }

    fn entry(id: &str, m: &Msg) -> Value {
        json!({ "id": id, "isRead": m.read, "flag": { "flagStatus": if m.flagged { "flagged" } else { "notFlagged" } } })
    }

    fn subject_of(&self, id: &str) -> String {
        let raw = String::from_utf8_lossy(&self.msgs[id].raw).to_string();
        raw.lines().find_map(|l| l.strip_prefix("Subject: ")).unwrap_or_default().to_owned()
    }

    // ── Calendar ────────────────────────────────────────────────────────

    fn put_event(&mut self, calendar: &str, mut e: Value) -> String {
        let id = e["id"].as_str().map(str::to_owned).unwrap_or_else(|| format!("ev-{}", self.events.len() + 1));
        let k = self.key();
        e["id"] = json!(id);
        e["changeKey"] = json!(k);
        e["@odata.etag"] = json!(format!("W/\"{k}\""));
        if e.get("iCalUId").is_none() {
            e["iCalUId"] = json!(format!("uid-{id}"));
        }
        self.calendar_of.insert(id.clone(), calendar.into());
        self.events.insert(id.clone(), e);
        id
    }

    fn rekey(&mut self, id: &str) {
        let k = self.key();
        let e = self.events.get_mut(id).unwrap();
        e["changeKey"] = json!(k);
        e["@odata.etag"] = json!(format!("W/\"{k}\""));
    }

    /// The series' slots in `[from, to)`, on the series' own clock.
    fn instances(&self, id: &str, from: i64, to: i64) -> Vec<Value> {
        let e = &self.events[id];
        let tz = Tz::from_str(e["originalStartTimeZone"].as_str().unwrap()).unwrap();
        let start = utc(&e["start"]);
        let local = DateTime::from_timestamp(start, 0).unwrap().with_timezone(&tz).naive_local();
        let step = match e["recurrence"]["pattern"]["type"].as_str() {
            Some("daily") => 1,
            _ => 7,
        } * e["recurrence"]["pattern"]["interval"].as_i64().unwrap_or(1);
        let end_date = e["recurrence"]["range"]["endDate"].as_str().and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok());
        let cancelled: Vec<String> = e["cancelledOccurrences"].as_array().into_iter().flatten().filter_map(|c| c.as_str().map(|c| c[c.len() - 10..].to_owned())).collect();
        let mut out = Vec::new();
        for n in 0..400 {
            let at = local + chrono::Duration::days(n * step);
            if end_date.is_some_and(|d| at.date() > d) {
                break;
            }
            let ts = tz.from_local_datetime(&at).earliest().unwrap().timestamp();
            if ts >= to {
                break;
            }
            let day = at.date().format("%Y-%m-%d").to_string();
            if ts < from || cancelled.contains(&day) {
                continue;
            }
            out.push(json!({ "id": format!("inst.{id}.{}", at.date().format("%Y%m%d")), "originalStart": DateTime::from_timestamp(ts, 0).unwrap().to_rfc3339_opts(chrono::SecondsFormat::Secs, true) }));
        }
        out
    }
}

/// Graph's `{ dateTime, timeZone }` → Unix seconds.
fn utc(v: &Value) -> i64 {
    let n = NaiveDateTime::parse_from_str(&v["dateTime"].as_str().unwrap()[..19], "%Y-%m-%dT%H:%M:%S").unwrap();
    let tz = Tz::from_str(v["timeZone"].as_str().unwrap_or("UTC")).unwrap();
    tz.from_local_datetime(&n).earliest().unwrap().timestamp()
}

/// What Graph returns with `Prefer: outlook.timezone="UTC"`.
fn as_utc(v: &Value) -> Value {
    let ts = utc(v);
    json!({ "dateTime": DateTime::from_timestamp(ts, 0).unwrap().format("%Y-%m-%dT%H:%M:%S.0000000").to_string(), "timeZone": "UTC" })
}

fn query(target: &str) -> (String, Vec<(String, String)>) {
    let (path, q) = target.split_once('?').unwrap_or((target, ""));
    let decode = |s: &str| {
        let s = s.replace('+', " ");
        let mut out = Vec::new();
        let b = s.as_bytes();
        let mut i = 0;
        while i < b.len() {
            if b[i] == b'%' && i + 2 < b.len() {
                out.push(u8::from_str_radix(&s[i + 1..i + 3], 16).unwrap());
                i += 3;
            } else {
                out.push(b[i]);
                i += 1;
            }
        }
        String::from_utf8(out).unwrap()
    };
    let pairs = q.split('&').filter(|p| !p.is_empty()).map(|p| p.split_once('=').unwrap_or((p, ""))).map(|(k, v)| (decode(k), decode(v))).collect();
    (path.to_owned(), pairs)
}

type Reply = (u16, &'static str, Vec<u8>);

fn j(status: u16, v: Value) -> Reply {
    (status, "application/json", if v.is_null() { Vec::new() } else { v.to_string().into_bytes() })
}

fn handle(fake: &mut Fake, method: &str, target: &str, headers: &HashMap<String, String>, body: &[u8]) -> Reply {
    let (path, q) = query(target);
    let param = |k: &str| q.iter().find(|(x, _)| x == k).map(|(_, v)| v.clone());
    if path == "/token" {
        let (_, f) = query(&format!("/?{}", String::from_utf8_lossy(body)));
        let get = |k: &str| f.iter().find(|(x, _)| x == k).map(|(_, v)| v.clone()).unwrap_or_default();
        assert!(f.iter().all(|(k, _)| k != "client_secret"), "Microsoft public clients send no secret");
        return match get("grant_type").as_str() {
            "authorization_code" if get("code") == "good-code" && get("code_verifier").len() == 43 => {
                fake.access = "access-1".into();
                fake.refresh = 1;
                // Personal accounts: a sign-in name, no email or name claim.
                let id = format!("e30.{}.sig", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(br#"{"preferred_username":"me@outlook.com"}"#));
                j(200, json!({ "access_token": "access-1", "refresh_token": "refresh-1", "expires_in": 3599, "id_token": id, "token_type": "Bearer" }))
            }
            "refresh_token" if get("refresh_token") == format!("refresh-{}", fake.refresh) => {
                // Microsoft rotates refresh tokens.
                fake.refresh += 1;
                fake.access = format!("access-{}", fake.refresh);
                j(200, json!({ "access_token": fake.access, "refresh_token": format!("refresh-{}", fake.refresh), "expires_in": 3599 }))
            }
            _ => j(400, json!({ "error": "invalid_grant" })),
        };
    }
    if headers.get("authorization") != Some(&format!("Bearer {}", fake.access)) {
        return j(401, json!({ "error": { "code": "InvalidAuthenticationToken", "message": "Access token has expired." } }));
    }
    if !headers.get("prefer").is_some_and(|p| p.contains("IdType=\"ImmutableId\"")) {
        fake.mutable_ids += 1;
    }
    let path = path.strip_prefix("/v1/me").unwrap_or(&path).to_owned();
    let segs: Vec<&str> = path.trim_matches('/').split('/').collect();
    let json_body: Value = serde_json::from_slice(body).unwrap_or_default();
    let base = format!("{}/v1/me", fake.base);
    let if_match = headers.get("if-match").cloned();
    match (method, segs.as_slice()) {
        ("GET", [""]) => j(200, json!({ "mail": null, "userPrincipalName": "me@outlook.com", "displayName": "Me Myself" })),
        ("GET", ["mailFolders", f]) => {
            let msgs = fake.in_folder(f);
            j(200, json!({ "id": f, "totalItemCount": msgs.len(), "unreadItemCount": msgs.iter().filter(|(_, m)| !m.read).count() }))
        }
        ("GET", ["mailFolders", f, "messages", "delta"]) => {
            if let Some(t) = param("$deltatoken") {
                let t: u64 = t.parse().unwrap();
                if t < fake.oldest_delta {
                    return j(410, json!({ "error": { "code": "SyncStateNotFound", "message": "The sync state is no longer available." } }));
                }
                let mut value: Vec<Value> = fake.in_folder(f).into_iter().filter(|(_, m)| m.seq > t).map(|(id, m)| Fake::entry(id, m)).collect();
                for (s, folder, id) in &fake.removals {
                    if *s > t && folder == f && fake.msgs.get(id).is_none_or(|m| m.folder != *f) {
                        value.push(json!({ "id": id, "@removed": { "reason": "changed" } }));
                    }
                }
                return j(200, json!({ "value": value, "@odata.deltaLink": format!("{base}/mailFolders/{f}/messages/delta?$deltatoken={}", fake.seq) }));
            }
            // First round: three per page, newest first.
            let snap: u64 = param("snap").map(|s| s.parse().unwrap()).unwrap_or(fake.seq);
            let from: usize = param("$skiptoken").map(|s| s.parse().unwrap()).unwrap_or(0);
            assert!(from > 0 || param("$orderby").as_deref() == Some("receivedDateTime desc"), "the first round asks for newest first");
            let all = fake.in_folder(f);
            let page: Vec<Value> = all.iter().skip(from).take(3).map(|(id, m)| Fake::entry(id, m)).collect();
            let mut v = json!({ "value": page });
            if from + 3 < all.len() {
                v["@odata.nextLink"] = json!(format!("{base}/mailFolders/{f}/messages/delta?$skiptoken={}&snap={snap}", from + 3));
            } else {
                v["@odata.deltaLink"] = json!(format!("{base}/mailFolders/{f}/messages/delta?$deltatoken={snap}"));
            }
            j(200, v)
        }
        ("GET", ["mailFolders", f, "messages"]) => {
            let top: usize = param("$top").unwrap().parse().unwrap();
            j(200, json!({ "value": fake.in_folder(f).into_iter().take(top).map(|(id, m)| Fake::entry(id, m)).collect::<Vec<_>>() }))
        }
        ("GET", ["messages", id, "$value"]) => match fake.msgs.get(*id) {
            Some(m) => (200, "message/rfc822", m.raw.clone()),
            None => j(404, json!({ "error": { "code": "ErrorItemNotFound", "message": "Not found" } })),
        },
        ("PATCH", ["messages", id]) => {
            if !fake.msgs.contains_key(*id) {
                return j(404, json!({ "error": { "message": "Not found" } }));
            }
            let id = id.to_string();
            fake.touch(&id, |m| {
                if let Some(r) = json_body["isRead"].as_bool() {
                    m.read = r;
                }
                if let Some(f) = json_body["flag"]["flagStatus"].as_str() {
                    m.flagged = f == "flagged";
                }
            });
            j(200, json!({ "id": id }))
        }
        ("POST", ["messages", id, "move"]) => {
            if !fake.msgs.contains_key(*id) {
                return j(404, json!({ "error": { "message": "Not found" } }));
            }
            let id = id.to_string();
            fake.move_to(&id, json_body["destinationId"].as_str().unwrap());
            j(201, json!({ "id": id }))
        }
        ("POST", ["sendMail"]) => {
            assert_eq!(headers.get("content-type").map(String::as_str), Some("text/plain"), "MIME sends as base64 text");
            let raw = base64::engine::general_purpose::STANDARD.decode(body).unwrap();
            fake.sent.push(raw.clone());
            fake.next += 1;
            let id = format!("AAMk-{:03}", fake.next);
            let seq = fake.bump();
            fake.msgs.insert(id, Msg { raw, folder: "sentitems".into(), read: true, flagged: false, seq });
            j(202, Value::Null)
        }

        // ── Calendars ──
        ("GET", ["calendars"]) => j(200, json!({ "value": [
            { "id": "cal1", "name": "Calendar", "hexColor": "#2563eb", "canEdit": true },
            { "id": "bday", "name": "Birthdays", "hexColor": "", "canEdit": false }
        ] })),
        ("GET", ["calendars", cid, "events"]) => {
            let expand = param("$expand").is_some();
            let value: Vec<Value> = fake
                .events
                .values()
                .filter(|e| fake.calendar_of[e["id"].as_str().unwrap()] == *cid)
                .map(|e| {
                    let mut v = json!({ "id": e["id"], "changeKey": e["changeKey"], "@odata.etag": e["@odata.etag"] });
                    if expand {
                        v["exceptionOccurrences"] = e["exceptionOccurrences"].as_array().cloned().unwrap_or_default().iter().map(|x| json!({ "id": x["id"], "@odata.etag": x["@odata.etag"] })).collect();
                    }
                    v
                })
                .collect();
            j(200, json!({ "value": value }))
        }
        ("POST", ["calendars", cid, "events"]) => {
            let mut e = json_body.clone();
            e["originalStartTimeZone"] = e["start"]["timeZone"].clone();
            e["start"] = as_utc(&e["start"]);
            e["end"] = as_utc(&e["end"]);
            e["isOrganizer"] = json!(true);
            e["organizer"] = json!({ "emailAddress": { "name": "Me Myself", "address": "me@outlook.com" } });
            let id = fake.put_event(cid, e);
            j(201, fake.events[&id].clone())
        }
        ("GET", ["events", id]) => match fake.events.get(*id) {
            Some(e) => {
                let mut e = e.clone();
                if param("$expand").is_none() {
                    e.as_object_mut().unwrap().remove("exceptionOccurrences");
                }
                j(200, e)
            }
            None => j(404, json!({ "error": { "code": "ErrorItemNotFound", "message": "Not found" } })),
        },
        ("GET", ["events", id, "instances"]) => {
            let at = |k: &str| DateTime::parse_from_rfc3339(&param(k).unwrap()).unwrap().timestamp();
            j(200, json!({ "value": fake.instances(id, at("startDateTime"), at("endDateTime")) }))
        }
        ("PATCH", ["events", id]) if id.starts_with("inst.") => {
            let (master, day) = id.trim_start_matches("inst.").rsplit_once('.').unwrap();
            let (master, day) = (master.to_owned(), day.to_owned());
            let slot = fake.instances(&master, 0, i64::MAX / 2).into_iter().find(|i| i["id"].as_str().unwrap().ends_with(&day)).unwrap();
            let k = fake.key();
            let e = fake.events.get_mut(&master).unwrap();
            let mut xs = e["exceptionOccurrences"].as_array().cloned().unwrap_or_default();
            xs.retain(|x| x["originalStart"] != slot["originalStart"]);
            xs.push(json!({ "id": id, "@odata.etag": format!("W/\"{k}\""), "originalStart": slot["originalStart"], "subject": json_body["subject"],
                "location": json_body["location"], "start": as_utc(&json_body["start"]), "end": as_utc(&json_body["end"]) }));
            e["exceptionOccurrences"] = json!(xs);
            j(200, json!({ "id": id }))
        }
        ("PATCH", ["events", id]) => {
            let Some(e) = fake.events.get(*id) else { return j(404, json!({ "error": { "message": "Not found" } })) };
            if if_match.as_ref().is_some_and(|m| *m != e["@odata.etag"].as_str().unwrap()) {
                return j(412, json!({ "error": { "code": "ErrorIrresolvableConflict", "message": "The change key passed in the request does not match the current change key for the item." } }));
            }
            if e.get("recurrence").is_some() && json_body.get("recurrence").is_some() {
                fake.recurrence_sent += 1;
            }
            let id = id.to_string();
            let e = fake.events.get_mut(&id).unwrap();
            for (k, v) in json_body.as_object().unwrap() {
                e[k] = match k.as_str() {
                    "start" | "end" => as_utc(v),
                    _ => v.clone(),
                };
            }
            if let Some(tz) = json_body["start"]["timeZone"].as_str() {
                e["originalStartTimeZone"] = json!(tz);
            }
            fake.rekey(&id);
            j(200, fake.events[&id].clone())
        }
        ("DELETE", ["events", id]) if id.starts_with("inst.") => {
            let (master, day) = id.trim_start_matches("inst.").rsplit_once('.').unwrap();
            let date = format!("{}-{}-{}", &day[..4], &day[4..6], &day[6..8]);
            let master = master.to_owned();
            let e = fake.events.get_mut(&master).unwrap();
            let mut c = e["cancelledOccurrences"].as_array().cloned().unwrap_or_default();
            c.push(json!(format!("OID.{master}.{date}")));
            e["cancelledOccurrences"] = json!(c);
            fake.rekey(&master);
            j(204, Value::Null)
        }
        ("DELETE", ["events", id]) => {
            let Some(e) = fake.events.get(*id) else { return j(404, json!({ "error": { "message": "Not found" } })) };
            if if_match.as_ref().is_some_and(|m| *m != e["@odata.etag"].as_str().unwrap()) {
                return j(412, json!({ "error": { "message": "conflict" } }));
            }
            fake.events.remove(*id);
            j(204, Value::Null)
        }
        ("POST", ["events", id, action]) => {
            fake.responses.push((id.to_string(), action.to_string()));
            let response = match *action {
                "accept" => "accepted",
                "decline" => "declined",
                _ => "tentativelyAccepted",
            };
            let id = id.to_string();
            fake.events.get_mut(&id).unwrap()["responseStatus"] = json!({ "response": response });
            fake.rekey(&id);
            j(202, Value::Null)
        }

        // ── Contacts ──
        ("GET", ["contacts"]) => j(200, json!({ "value": fake.contacts.values().map(|c| json!({ "id": c["id"], "changeKey": c["changeKey"], "@odata.etag": c["@odata.etag"] })).collect::<Vec<_>>() })),
        ("GET", ["contacts", id]) => match fake.contacts.get(*id) {
            Some(c) => j(200, c.clone()),
            None => j(404, json!({ "error": { "message": "Not found" } })),
        },
        ("POST", ["contacts"]) => {
            let id = format!("ct-{}", fake.contacts.len() + 10);
            let k = fake.key();
            let mut c = json_body.clone();
            c["id"] = json!(id);
            c["changeKey"] = json!(k);
            c["@odata.etag"] = json!(format!("W/\"{k}\""));
            fake.contacts.insert(id.clone(), c.clone());
            j(201, c)
        }
        ("PATCH", ["contacts", id]) => {
            let Some(c) = fake.contacts.get(*id) else { return j(404, json!({ "error": { "message": "Not found" } })) };
            if if_match.as_ref().is_some_and(|m| *m != c["@odata.etag"].as_str().unwrap()) {
                return j(412, json!({ "error": { "message": "conflict" } }));
            }
            let k = fake.key();
            let c = fake.contacts.get_mut(*id).unwrap();
            for (key, v) in json_body.as_object().unwrap() {
                c[key] = v.clone();
            }
            c["changeKey"] = json!(k);
            c["@odata.etag"] = json!(format!("W/\"{k}\""));
            j(200, c.clone())
        }
        ("DELETE", ["contacts", id]) => {
            fake.contacts.remove(*id);
            j(204, Value::Null)
        }
        _ => j(404, json!({ "error": { "message": format!("no route {method} {path}") } })),
    }
}

/// Serves `fake` over HTTP/1.1 on a free port; returns its base URL.
async fn serve(fake: Arc<Mutex<Fake>>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    fake.lock().unwrap().base = base.clone();
    tokio::spawn(async move {
        loop {
            let (mut sock, _) = listener.accept().await.unwrap();
            let fake = fake.clone();
            tokio::spawn(async move {
                let mut buf = Vec::new();
                loop {
                    let head_end = loop {
                        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            break i;
                        }
                        let mut chunk = [0u8; 8192];
                        let n = sock.read(&mut chunk).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        buf.extend_from_slice(&chunk[..n]);
                    };
                    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
                    let mut lines = head.lines();
                    let mut first = lines.next().unwrap().split_whitespace();
                    let (method, target) = (first.next().unwrap().to_owned(), first.next().unwrap().to_owned());
                    let headers: HashMap<String, String> = lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_owned())).collect();
                    let len: usize = headers.get("content-length").map(|l| l.parse().unwrap()).unwrap_or(0);
                    while buf.len() < head_end + 4 + len {
                        let mut chunk = [0u8; 8192];
                        let n = sock.read(&mut chunk).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        buf.extend_from_slice(&chunk[..n]);
                    }
                    let body = buf[head_end + 4..head_end + 4 + len].to_vec();
                    buf.drain(..head_end + 4 + len);
                    let (status, ctype, out) = handle(&mut fake.lock().unwrap(), &method, &target, &headers, &body);
                    let mut reply = format!("HTTP/1.1 {status} X\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\n\r\n", out.len()).into_bytes();
                    reply.extend_from_slice(&out);
                    if sock.write_all(&reply).await.is_err() {
                        return;
                    }
                }
            });
        }
    });
    base
}

fn config(base: &str) -> AccountConfig {
    let imap = ServerConfig { host: "outlook.office365.com".into(), port: 993, security: Security::Tls };
    AccountConfig {
        display_name: "Me".into(),
        address: "me@outlook.com".into(),
        username: "me@outlook.com".into(),
        provider: Provider::Microsoft,
        smtp: ServerConfig { host: "smtp.office365.com".into(), port: 587, security: Security::StartTls },
        imap,
        jmap: None,
        dav: Some(DavConfig { calendar_url: Some(graph::API.into()), contacts_url: Some(graph::API.into()), separate_secret: false }),
        oauth: Some(OAuthAccount { issuer: OAuthIssuer::Microsoft, client_id: "test-client".into(), api_base: Some(format!("{base}/v1/me")), token_url: Some(format!("{base}/token")) }),
    }
}

async fn sync(store: &Store, account: &str, cfg: &AccountConfig, token: &str) -> pim_core::RemoteBatch {
    let cursor = store.remote_cursor(account).unwrap();
    let ops = store.pending_remote_ops(account).unwrap();
    let batch = graph::sync_account(cfg, token, cursor, &ops).await.unwrap();
    store.apply_remote(account, &batch).unwrap();
    batch
}

fn subjects(store: &Store, lane: Lane) -> Vec<String> {
    let mut s: Vec<String> = store.messages(&MessageQuery { lane, account_id: None, search: None, limit: None, offset: None, category: None, split: None, bundle: false }).unwrap().into_iter().map(|m| m.subject).collect();
    s.sort();
    s
}

#[tokio::test]
async fn outlook_mail_end_to_end() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let fake = Arc::new(Mutex::new(Fake::default()));
    let base = serve(fake.clone()).await;
    let cfg = config(&base);

    // Sign-in: no client secret; the ID token has only a sign-in name; refresh tokens rotate.
    let ep = oauth::Endpoints { authorize: format!("{base}/auth"), token: format!("{base}/token") };
    let client = oauth::Client { client_id: "test-client".into(), client_secret: None };
    let (verifier, _) = oauth::pkce();
    let (tokens, who) = oauth::exchange(&ep, &client, "good-code", &verifier, "http://localhost:1").await.unwrap();
    assert_eq!((who.email.as_deref(), who.name.as_deref()), (Some("me@outlook.com"), None));
    assert_eq!(graph::verify(&cfg, &tokens.access_token).await.unwrap(), "me@outlook.com", "personal accounts: the sign-in name is the address");
    assert_eq!(graph::me(&cfg, &tokens.access_token).await.unwrap().1.as_deref(), Some("Me Myself"), "the name comes from /me");
    let refreshed = oauth::refresh(&ep.token, &client, &tokens).await.unwrap();
    assert_eq!(refreshed.refresh_token, "refresh-2", "Microsoft rotates the refresh token, and we keep the new one");
    assert!(matches!(oauth::refresh(&ep.token, &client, &tokens).await, Err(Error::Auth(_))), "the old refresh token is spent");
    assert!(matches!(graph::verify(&cfg, &tokens.access_token).await, Err(Error::Auth(m)) if m.contains("sign in again")));
    let token = refreshed.access_token;

    let (welcome, receipt, report) = {
        let mut f = fake.lock().unwrap();
        let w = f.add("Welcome", "inbox", false);
        let r = f.add("Receipt", "archive", true);
        let p = f.add("Quarterly report", "inbox", true);
        f.touch(&p, |m| m.flagged = true);
        f.add("Unsent draft", "drafts", true);
        f.add("Old newsletter", "deleteditems", true);
        f.add("My reply", "sentitems", true);
        (w, r, p)
    };

    let store = Store::open_in_memory().unwrap();
    let account = store.add_account(&cfg).unwrap().id;
    let b = sync(&store, &account, &cfg, &token).await;
    assert_eq!(b.new_messages.len(), 4, "inbox, archive, and sent; drafts and deleted items stay out");
    assert_eq!(subjects(&store, Lane::Inbox), ["Quarterly report", "Welcome"]);
    assert_eq!(subjects(&store, Lane::Archive), ["Receipt"]);
    assert_eq!(subjects(&store, Lane::Unread), ["Welcome"]);
    assert_eq!(subjects(&store, Lane::Starred), ["Quarterly report"]);
    assert!(!b.more_older);

    let b = sync(&store, &account, &cfg, &token).await;
    assert!(b.new_messages.is_empty() && b.moved.is_empty() && b.removed.is_empty(), "quiet");

    // Changes made elsewhere: new mail, read, archived (a move), deleted, moved to an untracked folder.
    {
        let mut f = fake.lock().unwrap();
        f.add("Fresh news", "inbox", false);
        f.touch(&welcome, |m| m.read = true);
        f.move_to(&report, "archive");
        f.delete(&receipt);
        let t = f.add("Short-lived", "inbox", true);
        f.move_to(&t, "deleteditems");
    }
    let b = sync(&store, &account, &cfg, &token).await;
    assert_eq!(subjects(&store, Lane::Inbox), ["Fresh news", "Welcome"]);
    assert_eq!(subjects(&store, Lane::Archive), ["Quarterly report"], "moved, not re-downloaded; the deleted receipt is gone");
    assert_eq!(subjects(&store, Lane::Unread), ["Fresh news"]);
    assert_eq!(b.moved.len(), 1);
    assert!(b.new_messages.iter().all(|m| m.mailbox == INBOX) && b.new_messages.len() <= 2, "the short-lived message, if seen at all, is removed again");

    // Local changes: read, star, archive.
    let row = |s: &str| store.messages(&MessageQuery { lane: Lane::Inbox, account_id: None, search: None, limit: None, offset: None, category: None, split: None, bundle: false }).unwrap().into_iter().find(|m| m.subject == s).unwrap();
    store.set_thread_seen(&row("Fresh news").thread_id, true).unwrap();
    store.set_thread_flagged(&row("Welcome").thread_id, true).unwrap();
    store.set_thread_archived(&row("Welcome").thread_id, true).unwrap();
    let b = sync(&store, &account, &cfg, &token).await;
    assert_eq!(b.applied_ops.len(), 3);
    {
        let f = fake.lock().unwrap();
        let w = &f.msgs[&welcome];
        assert!(w.flagged && w.folder == "archive", "starred and moved to Archive, same id");
        assert!(f.msgs.iter().any(|(id, m)| f.subject_of(id) == "Fresh news" && m.read));
    }
    assert_eq!(subjects(&store, Lane::Inbox), ["Fresh news"]);
    assert_eq!(subjects(&store, Lane::Starred), ["Quarterly report", "Welcome"]);
    sync(&store, &account, &cfg, &token).await;
    assert_eq!(subjects(&store, Lane::Starred), ["Quarterly report", "Welcome"], "our own changes come back consistently");

    // Send a reply: Outlook files the Sent copy; it joins the thread once.
    let draft = Draft {
        account_id: account.clone(),
        to: vec![pim_core::Address { name: Some("Ada".into()), email: "ada@example.com".into() }],
        cc: vec![],
        subject: "Re: Welcome".into(),
        body: "Thanks!".into(),
        body_html: None,
        in_reply_to: Some(format!("<{welcome}@example.com>")),
        references: vec![format!("<{welcome}@example.com>")],
        attachments: vec![],
        calendar: None,
        follow_up_after: None,
    };
    let raw = graph::send(&cfg, &token, &draft).await.unwrap();
    assert_eq!(fake.lock().unwrap().sent.len(), 1);
    store.insert_local(&account, SENT, &raw, true).unwrap();
    sync(&store, &account, &cfg, &token).await;
    let welcome_row = store.messages(&MessageQuery { lane: Lane::Starred, account_id: None, search: None, limit: None, offset: None, category: None, split: None, bundle: false }).unwrap().into_iter().find(|m| m.subject == "Welcome").unwrap();
    let sent: Vec<_> = store.thread(&welcome_row.thread_id).unwrap().into_iter().filter(|m| m.summary.mailbox == SENT).collect();
    assert_eq!(sent.len(), 1, "one Sent copy in the conversation, not two");

    // Backfill: a big archive pages through its first round across passes.
    {
        let mut f = fake.lock().unwrap();
        f.oldest_delta = 0;
        for i in 0..(pim_core::net::BACKFILL_CHUNK + 20) {
            f.add(&format!("Bulk {i:03}"), "archive", true);
        }
    }
    let b = sync(&store, &account, &cfg, &token).await;
    assert!(b.new_messages.len() > pim_core::net::BACKFILL_CHUNK, "a delta link brings all changes at once");

    // The delta link expires: each folder starts over without duplicates.
    let before = store.remote_cursor(&account).unwrap().known.len();
    {
        let mut f = fake.lock().unwrap();
        f.oldest_delta = f.seq + 1;
        f.add("After reset", "inbox", false);
    }
    let mut passes = 0;
    loop {
        let b = sync(&store, &account, &cfg, &token).await;
        passes += 1;
        if !b.more_older || passes > 200 {
            break;
        }
    }
    assert_eq!(store.remote_cursor(&account).unwrap().known.len(), before + 1, "everything is back exactly once");
    assert!(subjects(&store, Lane::Inbox).contains(&"After reset".to_string()));

    // While a first round pages, the newest inbox mail still shows up.
    let fresh = Store::open_in_memory().unwrap();
    let acct2 = fresh.add_account(&cfg).unwrap().id;
    {
        let mut f = fake.lock().unwrap();
        for i in 0..(pim_core::net::INITIAL_SYNC_LIMIT + 10) {
            f.add(&format!("Inbox bulk {i:03}"), "inbox", true);
        }
    }
    let b = sync(&fresh, &acct2, &cfg, &token).await;
    assert!(b.more_older);
    fake.lock().unwrap().add("Arrived mid-backfill", "inbox", false);
    sync(&fresh, &acct2, &cfg, &token).await;
    assert_eq!(subjects(&fresh, Lane::Unread).iter().filter(|s| *s == "Arrived mid-backfill").count(), 1);

    // Polling notices new mail.
    let state = store.remote_cursor(&account).unwrap().state;
    let quiet = graph::wait_for_change(&cfg, &token, state.as_deref(), std::time::Duration::from_millis(10)).await.unwrap();
    assert!(matches!(quiet, pim_core::net::Change::Quiet));
    assert_eq!(fake.lock().unwrap().mutable_ids, 0, "every request asks for immutable ids");
    assert!(store.remote_cursor(&account).unwrap().known.values().all(|m| [INBOX, SENT, ARCHIVE].contains(&m.as_str())));
}

/// One calendars-and-contacts pass, as the shell runs it.
async fn pim_pass(store: &Store, account: &str, pim: &graph_pim::Pim) -> Vec<(DavOutcome, usize)> {
    let mut out = Vec::new();
    for kind in [CollectionKind::Calendar, CollectionKind::Contacts] {
        let remote = pim.discover(kind).await.unwrap();
        store.sync_collections(account, kind, &remote).unwrap();
        let plans: Vec<DavPlan> = store
            .dav_cursors(account)
            .unwrap()
            .into_iter()
            .filter(|(c, _)| c.kind == kind)
            .map(|(c, cursor)| DavPlan { changes: store.pending_dav(&c.id).unwrap(), collection_id: c.id, kind, cursor })
            .collect();
        for r in graph_pim::sync(pim, plans).await.unwrap() {
            for (item, outcome) in &r.outcomes {
                store.dav_result(&r.collection_id, item, outcome).unwrap();
                out.push((outcome.clone(), 0));
            }
            out.push((DavOutcome::Deleted, r.batch.upserts.len() + r.batch.removed.len()));
            store.apply_dav(&r.collection_id, &r.batch).unwrap();
        }
    }
    out
}

fn changed(pass: &[(DavOutcome, usize)]) -> usize {
    pass.iter().map(|(_, n)| n).sum()
}

fn ts(s: &str, zone: &str) -> i64 {
    Tz::from_str(zone).unwrap().from_local_datetime(&NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M").unwrap()).earliest().unwrap().timestamp()
}

#[tokio::test]
async fn outlook_calendars_and_contacts() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let fake = Arc::new(Mutex::new(Fake { access: "tok".into(), ..Default::default() }));
    let base = serve(fake.clone()).await;
    let cfg = config(&base);
    {
        let mut f = fake.lock().unwrap();
        f.put_event("cal1", json!({
            "id": "series", "subject": "Design review", "body": { "content": "Agenda" }, "location": { "displayName": "Room 4" },
            "isAllDay": false, "originalStartTimeZone": "Pacific Standard Time", "isOrganizer": true,
            "start": { "dateTime": "2026-10-14T16:00:00.0000000", "timeZone": "UTC" }, "end": { "dateTime": "2026-10-14T17:00:00.0000000", "timeZone": "UTC" },
            "recurrence": { "pattern": { "type": "weekly", "interval": 1, "daysOfWeek": ["wednesday"], "firstDayOfWeek": "sunday" },
                "range": { "type": "endDate", "startDate": "2026-10-14", "endDate": "2026-12-16" } },
            "isReminderOn": true, "reminderMinutesBeforeStart": 10,
            "organizer": { "emailAddress": { "name": "Me Myself", "address": "me@outlook.com" } },
            "attendees": [{ "emailAddress": { "name": "Ana", "address": "ana@contoso.com" }, "status": { "response": "accepted" } }],
            "cancelledOccurrences": ["OID.series.2026-10-28"],
            "exceptionOccurrences": [{ "id": "inst.series.20261104", "@odata.etag": "W/\"x1\"", "subject": "Design review (moved)", "originalStart": "2026-11-04T17:00:00Z",
                "start": { "dateTime": "2026-11-05T17:00:00.0000000", "timeZone": "UTC" }, "end": { "dateTime": "2026-11-05T18:00:00.0000000", "timeZone": "UTC" } }]
        }));
        f.put_event("cal1", json!({
            "id": "lunch", "subject": "Lunch", "isAllDay": false, "originalStartTimeZone": "UTC", "isOrganizer": true,
            "start": { "dateTime": "2026-10-15T12:00:00.0000000", "timeZone": "UTC" }, "end": { "dateTime": "2026-10-15T13:00:00.0000000", "timeZone": "UTC" },
            "isReminderOn": false, "attendees": []
        }));
        f.put_event("cal1", json!({
            "id": "invite", "subject": "Budget sync", "isAllDay": false, "originalStartTimeZone": "UTC", "isOrganizer": false,
            "start": { "dateTime": "2026-10-16T15:00:00.0000000", "timeZone": "UTC" }, "end": { "dateTime": "2026-10-16T15:30:00.0000000", "timeZone": "UTC" },
            "organizer": { "emailAddress": { "name": "Boss", "address": "boss@contoso.com" } },
            "attendees": [{ "emailAddress": { "name": "Me Myself", "address": "me@outlook.com" }, "status": { "response": "none" } }],
            "responseStatus": { "response": "notResponded" }, "isReminderOn": true, "reminderMinutesBeforeStart": 15
        }));
        f.contacts.insert("ct-1".into(), json!({ "id": "ct-1", "changeKey": "c1", "@odata.etag": "W/\"c1\"", "displayName": "Ana Duarte", "givenName": "Ana", "surname": "Duarte",
            "emailAddresses": [{ "name": "Ana", "address": "ana@contoso.com" }], "businessPhones": ["+1 555 0100"], "homePhones": [], "mobilePhone": null }));
    }

    let store = Store::open_in_memory().unwrap();
    store.ensure_local_collections().unwrap();
    store.set_time_zone("Europe/Lisbon").unwrap();
    let account = store.add_account(&cfg).unwrap().id;
    let pim = graph_pim::Pim::new(&cfg, "tok", "Europe/Lisbon").unwrap();
    let window = (ts("2026-10-01T00:00", "UTC"), ts("2027-01-01T00:00", "UTC"));
    let titles = |s: &Store| s.occurrences(window.0, window.1).unwrap().into_iter().map(|o| o.title).collect::<Vec<_>>();

    let first = pim_pass(&store, &account, &pim).await;
    assert_eq!(changed(&first), 4, "three events and a contact");
    let t = titles(&store);
    assert_eq!(t.iter().filter(|x| x.starts_with("Design review")).count(), 9, "ten Wednesdays, one cancelled, one moved");
    assert!(t.contains(&"Design review (moved)".to_string()) && t.contains(&"Lunch".to_string()) && t.contains(&"Budget sync".to_string()));
    let cals = store.collections(CollectionKind::Calendar).unwrap();
    let outlook = cals.iter().find(|c| c.name == "Calendar" && c.account_id.is_some()).unwrap().id.clone();
    assert!(cals.iter().any(|c| c.name == "Birthdays" && !c.writable), "read-only calendars stay read-only");
    assert_eq!(store.contacts(None).unwrap().iter().filter(|c| c.full_name == "Ana Duarte").count(), 1);

    assert_eq!(changed(&pim_pass(&store, &account, &pim).await), 0, "quiet");

    // Changed in Outlook: a title, and one exception (only its own etag moves).
    {
        let mut f = fake.lock().unwrap();
        f.events.get_mut("lunch").unwrap()["subject"] = json!("Team lunch");
        f.rekey("lunch");
        let x = &mut f.events.get_mut("series").unwrap()["exceptionOccurrences"][0];
        x["subject"] = json!("Design review (room change)");
        x["@odata.etag"] = json!("W/\"x2\"");
    }
    assert_eq!(changed(&pim_pass(&store, &account, &pim).await), 2);
    let t = titles(&store);
    assert!(t.contains(&"Team lunch".to_string()) && t.contains(&"Design review (room change)".to_string()));

    // Created here: Graph picks the id; the store follows it; no duplicate.
    let retro = EventInput {
        calendar_id: outlook.clone(),
        title: "Retro".into(),
        location: None,
        notes: Some("What went well".into()),
        start: "2026-10-20T15:00".into(),
        end: "2026-10-20T16:00".into(),
        all_day: false,
        time_zone: "Europe/Lisbon".into(),
        repeat: Repeat::Weekly,
        reminders: Some(vec![5, 30]),
        attendees: None,
    };
    store.create_event(&retro).unwrap();
    let pass = pim_pass(&store, &account, &pim).await;
    assert!(pass.iter().any(|(o, _)| matches!(o, DavOutcome::Created(h, None) if h.starts_with("/events/"))));
    {
        let f = fake.lock().unwrap();
        let e = f.events.values().find(|e| e["subject"] == "Retro").unwrap();
        assert_eq!(e["start"]["dateTime"], "2026-10-20T14:00:00.0000000", "15:00 in Lisbon, summer time");
        assert_eq!(e["originalStartTimeZone"], "Europe/Lisbon");
        assert_eq!(e["recurrence"]["pattern"]["daysOfWeek"], json!(["tuesday"]));
        assert_eq!(e["recurrence"]["range"]["type"], "noEnd");
        assert_eq!(e["reminderMinutesBeforeStart"], 5, "Outlook keeps the reminder closest to the start");
    }
    pim_pass(&store, &account, &pim).await;
    let on = |day: &str| store.occurrences(ts(&format!("{day}T00:00"), "UTC"), ts(&format!("{day}T23:59"), "UTC")).unwrap().into_iter().filter(|o| o.title == "Retro").count();
    assert_eq!((on("2026-10-20"), on("2026-11-03")), (1, 1), "once each week, after the server's copy came back; 15:00 Lisbon stays 15:00 after the clocks change");
    assert_eq!(changed(&pim_pass(&store, &account, &pim).await), 0);

    // One occurrence edited here, another removed: Graph instances.
    let series = store.occurrences(window.0, window.1).unwrap().into_iter().find(|o| o.title == "Design review").unwrap();
    let detail = store.event(&series.event_id, Some(series.start)).unwrap();
    let slot = ts("2026-10-21T09:00", "America/Los_Angeles");
    let moved = EventInput {
        calendar_id: outlook.clone(),
        title: "Design review (remote)".into(),
        location: Some("Video call".into()),
        notes: detail.notes.clone(),
        start: "2026-10-21T10:00".into(),
        end: "2026-10-21T11:00".into(),
        all_day: false,
        time_zone: "America/Los_Angeles".into(),
        repeat: Repeat::None,
        reminders: None,
        attendees: None,
    };
    store.update_event(&series.event_id, &moved, EditScope::This, Some(slot)).unwrap();
    store.delete_event(&series.event_id, Some(ts("2026-12-02T09:00", "America/Los_Angeles")), EditScope::This).unwrap();
    pim_pass(&store, &account, &pim).await;
    {
        let f = fake.lock().unwrap();
        let e = &f.events["series"];
        let x = e["exceptionOccurrences"].as_array().unwrap().iter().find(|x| x["originalStart"] == "2026-10-21T16:00:00Z").expect("an exception for Oct 21");
        assert_eq!((x["subject"].as_str(), x["start"]["dateTime"].as_str()), (Some("Design review (remote)"), Some("2026-10-21T17:00:00.0000000")));
        assert!(e["cancelledOccurrences"].as_array().unwrap().contains(&json!("OID.series.2026-12-02")));
        assert_eq!(f.recurrence_sent, 0, "an unchanged rule isn't resent (Outlook would drop the exceptions)");
    }
    pim_pass(&store, &account, &pim).await;
    let t = titles(&store);
    assert_eq!(t.iter().filter(|x| x.starts_with("Design review")).count(), 8, "Dec 2 is gone; the moved ones stay");
    assert!(t.contains(&"Design review (remote)".to_string()));

    // A local edit to something changed in Outlook meanwhile: the server wins.
    let lunch = store.occurrences(window.0, window.1).unwrap().into_iter().find(|o| o.title == "Team lunch").unwrap();
    {
        let mut f = fake.lock().unwrap();
        f.events.get_mut("lunch").unwrap()["subject"] = json!("Team lunch (moved upstairs)");
        f.rekey("lunch");
    }
    let mine = EventInput { calendar_id: outlook.clone(), title: "Lunch (mine)".into(), location: None, notes: None, start: "2026-10-15T13:00".into(), end: "2026-10-15T14:00".into(), all_day: false, time_zone: "Europe/Lisbon".into(), repeat: Repeat::None, reminders: None, attendees: None };
    store.update_event(&lunch.event_id, &mine, EditScope::All, None).unwrap();
    let pass = pim_pass(&store, &account, &pim).await;
    assert!(pass.iter().any(|(o, _)| *o == DavOutcome::Conflict));
    pim_pass(&store, &account, &pim).await;
    assert!(titles(&store).contains(&"Team lunch (moved upstairs)".to_string()));

    // Answering an invitation goes through Graph's accept, which emails the organizer.
    let invite_ics = {
        let f = fake.lock().unwrap();
        graph_pim::event_to_ics(&f.events["invite"], "Europe/Lisbon").unwrap()
    };
    let accepted = invite_ics.replace("PARTSTAT=NEEDS-ACTION:mailto:me@outlook.com", "PARTSTAT=ACCEPTED:mailto:me@outlook.com");
    assert_ne!(accepted, invite_ics);
    let etag = fake.lock().unwrap().events["invite"]["@odata.etag"].as_str().unwrap().to_owned();
    let outcome = pim.push(CollectionKind::Calendar, &DavChange { item_id: "x".into(), href: "/events/invite".into(), etag: Some(etag), body: Some(accepted) }).await.unwrap();
    assert_eq!(outcome, DavOutcome::Saved(None));
    assert_eq!(fake.lock().unwrap().responses, [("invite".to_string(), "accept".to_string())]);
    assert_eq!(fake.lock().unwrap().events["invite"]["subject"], "Budget sync", "someone else's event isn't edited");

    // Contacts: create, edit, and a delete made in Outlook.
    let book = store.collections(CollectionKind::Contacts).unwrap().into_iter().find(|c| c.account_id.is_some()).unwrap().id;
    let sam = ContactInput {
        book_id: book.clone(),
        full_name: "Sam Lee".into(),
        emails: vec![ContactField { label: Some("work".into()), value: "sam@contoso.com".into() }],
        phones: vec![ContactField { label: Some("cell".into()), value: "+1 555 0142".into() }, ContactField { label: Some("work".into()), value: "+1 555 0143".into() }],
        org: Some("Contoso".into()),
        title: None,
        note: None,
        birthday: Some("1988-02-29".into()),
        labels: None,
    };
    let created = store.create_contact(&sam).unwrap();
    pim_pass(&store, &account, &pim).await;
    {
        let f = fake.lock().unwrap();
        let c = f.contacts.values().find(|c| c["displayName"] == "Sam Lee").unwrap();
        assert_eq!((c["mobilePhone"].as_str(), c["businessPhones"][0].as_str(), c["birthday"].as_str()), (Some("+1 555 0142"), Some("+1 555 0143"), Some("1988-02-29T12:00:00Z")));
    }
    pim_pass(&store, &account, &pim).await;
    let sam_now = store.contacts(Some("Sam")).unwrap();
    assert_eq!(sam_now.len(), 1, "the server's copy replaced ours, no duplicate");
    store.update_contact(&sam_now[0].id, &ContactInput { title: Some("Engineer".into()), ..sam.clone() }).unwrap();
    pim_pass(&store, &account, &pim).await;
    assert!(fake.lock().unwrap().contacts.values().any(|c| c["jobTitle"] == "Engineer"));
    let _ = created;
    fake.lock().unwrap().contacts.remove("ct-1");
    pim_pass(&store, &account, &pim).await;
    assert!(store.contacts(Some("Ana")).unwrap().is_empty(), "deleted in Outlook, gone here");
    assert_eq!(fake.lock().unwrap().mutable_ids, 0, "every request asks for immutable ids");
}
