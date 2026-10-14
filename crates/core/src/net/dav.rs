//! CalDAV (RFC 4791) and CardDAV (RFC 6352) over WebDAV (RFC 4918).
//!
//! Hand-rolled on the same `reqwest` client and rustls/ring TLS as JMAP,
//! with `quick-xml` for multistatus responses. Discovery follows RFC 6764
//! (well-known URL → current-user-principal → home set → collections).
//! Sync uses `sync-collection` (RFC 6578) and falls back to comparing etags
//! on servers without it. Writes are conditional (`If-Match` /
//! `If-None-Match: *`), so a stale edit never overwrites someone else's.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use base64::Engine;
use quick_xml::events::Event;
use reqwest::{Method, StatusCode, header};

use super::{TIMEOUT, tls_config};
use crate::{CollectionKind, DavBatch, DavChange, DavCursor, DavOutcome, Error, RemoteCollection, Result};

/// Resources fetched per multiget request.
const MULTIGET_CHUNK: usize = 50;
const MAX_REDIRECTS: usize = 5;

/// An authenticated client for one DAV server.
pub struct Dav {
    http: reqwest::Client,
    auth: String,
    /// The URL discovery started from; hrefs resolve against it.
    base: reqwest::Url,
}

fn http_err(e: reqwest::Error) -> Error {
    if e.is_timeout() { Error::Network("the server took too long to answer".into()) } else { Error::Network(e.to_string()) }
}

fn is_local(u: &reqwest::Url) -> bool {
    u.host_str().is_some_and(|h| matches!(h, "localhost" | "127.0.0.1" | "[::1]"))
}

impl Dav {
    /// Signs in with a username and password (HTTP Basic).
    pub fn new(url: &str, username: &str, secret: &str) -> Result<Self> {
        let pair = format!("{username}:{secret}");
        Self::with_auth(url, format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(pair)))
    }

    /// Signs in with an OAuth access token (Google's CalDAV and CardDAV).
    pub fn with_bearer(url: &str, token: &str) -> Result<Self> {
        Self::with_auth(url, format!("Bearer {token}"))
    }

    fn with_auth(url: &str, auth: String) -> Result<Self> {
        let base = reqwest::Url::parse(url.trim()).map_err(|_| Error::Invalid(format!("“{url}” isn't a valid URL")))?;
        if base.scheme() != "https" && !(base.scheme() == "http" && is_local(&base)) {
            return Err(Error::Invalid("CalDAV and CardDAV need https:// (plain http is only allowed for localhost)".into()));
        }
        let http = reqwest::Client::builder()
            .tls_backend_preconfigured(tls_config())
            .timeout(TIMEOUT)
            // Redirects are followed by hand so PROPFIND stays PROPFIND.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(http_err)?;
        Ok(Self { http, auth, base })
    }

    fn resolve(&self, href: &str) -> Result<reqwest::Url> {
        self.base.join(href).map_err(|_| Error::Network(format!("the server sent an invalid URL: {href}")))
    }

    /// Sends one request, following redirects with the same method and body.
    /// Returns the final status, headers, body, and the URL that answered.
    async fn send(&self, method: &str, url: reqwest::Url, depth: Option<&str>, extra: &[(&str, &str)], body: Option<(&str, String)>) -> Result<(StatusCode, header::HeaderMap, String, reqwest::Url)> {
        let method = Method::from_bytes(method.as_bytes()).map_err(|_| Error::Invalid("bad method".into()))?;
        let mut url = url;
        for _ in 0..=MAX_REDIRECTS {
            let mut req = self.http.request(method.clone(), url.clone()).header(header::AUTHORIZATION, &self.auth);
            if let Some(d) = depth {
                req = req.header("Depth", d);
            }
            for (k, v) in extra {
                req = req.header(*k, *v);
            }
            if let Some((ct, b)) = &body {
                req = req.header(header::CONTENT_TYPE, *ct).body(b.clone());
            }
            let res = req.send().await.map_err(http_err)?;
            let status = res.status();
            if status.is_redirection() {
                let loc = res.headers().get(header::LOCATION).and_then(|v| v.to_str().ok()).ok_or_else(|| Error::Network("redirect without a location".into()))?;
                let next = url.join(loc).map_err(|_| Error::Network(format!("bad redirect: {loc}")))?;
                // Never follow a redirect that downgrades to plain http off-device.
                if next.scheme() != "https" && !is_local(&next) {
                    return Err(Error::Network("the server redirected to an insecure address".into()));
                }
                url = next;
                continue;
            }
            if status == StatusCode::UNAUTHORIZED || (status == StatusCode::FORBIDDEN && method.as_str() == "PROPFIND") {
                return Err(Error::Auth("the server didn't accept these credentials".into()));
            }
            let headers = res.headers().clone();
            let text = res.text().await.map_err(http_err)?;
            return Ok((status, headers, text, url));
        }
        Err(Error::Network("too many redirects".into()))
    }

    async fn propfind(&self, url: reqwest::Url, depth: &str, props: &str) -> Result<(Vec<Response>, reqwest::Url)> {
        let body = format!(r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cr="urn:ietf:params:xml:ns:carddav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ic="http://apple.com/ns/ical/"><d:prop>{props}</d:prop></d:propfind>"#);
        let (status, _, text, at) = self.send("PROPFIND", url, Some(depth), &[], Some(("application/xml; charset=utf-8", body))).await?;
        if status != StatusCode::MULTI_STATUS {
            return Err(Error::Network(format!("the server answered {status} to a calendar lookup")));
        }
        Ok((parse_multistatus(&text)?.responses, at))
    }

    /// Finds the user's calendars or address books.
    pub async fn discover(&self, kind: CollectionKind) -> Result<Vec<RemoteCollection>> {
        let (well_known, home_prop) = match kind {
            CollectionKind::Calendar => ("/.well-known/caldav", "c:calendar-home-set"),
            CollectionKind::Contacts => ("/.well-known/carddav", "cr:addressbook-home-set"),
        };
        // A bare host means "use the well-known entry point".
        let start = if self.base.path() == "/" || self.base.path().is_empty() { self.resolve(well_known)? } else { self.base.clone() };
        let (rs, at) = self.propfind(start, "0", "<d:current-user-principal/><d:resourcetype/>").await?;
        let principal = rs.iter().find_map(|r| r.prop("current-user-principal").and_then(|p| p.hrefs.first().cloned()));
        let principal_url = match principal {
            Some(h) => at.join(&h).map_err(|_| Error::Network("bad principal URL".into()))?,
            None => at.clone(),
        };
        let (rs, at) = self.propfind(principal_url, "0", &format!("<{home_prop}/>")).await?;
        let home_local = home_prop.split(':').nth(1).unwrap_or_default();
        let homes: Vec<String> = rs.iter().filter_map(|r| r.prop(home_local)).flat_map(|p| p.hrefs.clone()).collect();
        // Some servers point straight at a collection; treat the answering URL as home then.
        let homes = if homes.is_empty() { vec![at.path().to_string()] } else { homes };

        let mut out = Vec::new();
        let mut seen = HashSet::new();
        for home in homes {
            let url = at.join(&home).map_err(|_| Error::Network("bad home URL".into()))?;
            // RFC 6638 servers announce scheduling in the DAV header.
            let scheduling = kind == CollectionKind::Calendar
                && self
                    .send("OPTIONS", url.clone(), None, &[], None)
                    .await
                    .is_ok_and(|(_, headers, _, _)| headers.get_all("dav").iter().any(|v| v.to_str().is_ok_and(|v| v.contains("calendar-auto-schedule"))));
            let (rs, _) = self
                .propfind(url, "1", "<d:resourcetype/><d:displayname/><ic:calendar-color/><c:supported-calendar-component-set/><d:current-user-privilege-set/>")
                .await?;
            for r in rs {
                let Some(types) = r.prop("resourcetype") else { continue };
                let is_kind = match kind {
                    CollectionKind::Calendar => types.children.iter().any(|c| c == "calendar"),
                    CollectionKind::Contacts => types.children.iter().any(|c| c == "addressbook"),
                };
                // Task-only lists (VTODO) aren't calendars here.
                let has_events = r.prop("supported-calendar-component-set").is_none_or(|p| p.comps.is_empty() || p.comps.iter().any(|c| c.eq_ignore_ascii_case("VEVENT")));
                if !is_kind || (kind == CollectionKind::Calendar && !has_events) || !seen.insert(r.href.clone()) {
                    continue;
                }
                let writable = r.prop("current-user-privilege-set").is_none_or(|p| p.children.iter().any(|c| matches!(c.as_str(), "write" | "write-content" | "all")));
                let name = r.prop("displayname").map(|p| p.text.trim().to_string()).filter(|n| !n.is_empty()).unwrap_or_else(|| {
                    r.href.trim_end_matches('/').rsplit('/').next().unwrap_or("Calendar").to_string()
                });
                // Apple sends #RRGGBBAA; CSS takes that as-is.
                let color = r.prop("calendar-color").map(|p| p.text.trim().to_string()).filter(|c| c.starts_with('#'));
                out.push(RemoteCollection { href: r.href, kind, name, color, writable, scheduling });
            }
        }
        Ok(out)
    }

    /// Changes since `cursor`, with bodies for everything new or changed.
    pub async fn pull(&self, kind: CollectionKind, cursor: &DavCursor) -> Result<DavBatch> {
        let url = self.resolve(&cursor.href)?;
        let mut batch = match self.sync_collection(url.clone(), cursor.sync_token.as_deref()).await {
            Ok(Some(b)) => b,
            // No sync-collection, or the token expired: compare etags instead.
            Ok(None) | Err(Error::Network(_)) => self.etag_diff(url.clone(), cursor).await?,
            Err(e) => return Err(e),
        };
        // sync-collection lists everything on the first pass; skip what we already hold.
        let wanted: Vec<String> = batch
            .upserts
            .iter()
            .filter(|(href, etag, _)| cursor.etags.get(href) != Some(etag))
            .map(|(href, _, _)| href.clone())
            .collect();
        let bodies = self.multiget(kind, url, &wanted).await?;
        batch.upserts = bodies;
        Ok(batch)
    }

    /// RFC 6578. `Ok(None)` when the server can't do it (or forgot the token).
    async fn sync_collection(&self, url: reqwest::Url, token: Option<&str>) -> Result<Option<DavBatch>> {
        let token = token.map(xml_escape).unwrap_or_default();
        let body = format!(r#"<?xml version="1.0" encoding="utf-8"?><d:sync-collection xmlns:d="DAV:"><d:sync-token>{token}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>"#);
        let (status, _, text, _) = self.send("REPORT", url, None, &[], Some(("application/xml; charset=utf-8", body))).await?;
        if status != StatusCode::MULTI_STATUS {
            return Ok(None);
        }
        let ms = parse_multistatus(&text)?;
        let mut batch = DavBatch { sync_token: ms.sync_token, ..Default::default() };
        for r in ms.responses {
            if r.status == Some(404) {
                batch.removed.push(r.href);
            } else if let Some(etag) = r.prop("getetag").map(|p| p.text.trim().to_string()).filter(|e| !e.is_empty()) {
                batch.upserts.push((r.href, etag, String::new()));
            }
        }
        Ok(Some(batch))
    }

    async fn etag_diff(&self, url: reqwest::Url, cursor: &DavCursor) -> Result<DavBatch> {
        let (rs, _) = self.propfind(url.clone(), "1", "<d:getetag/><d:resourcetype/>").await?;
        let mut on_server = HashMap::new();
        for r in rs {
            // Skip the collection itself and any sub-collections.
            if r.prop("resourcetype").is_some_and(|p| p.children.iter().any(|c| c == "collection")) {
                continue;
            }
            if let Some(etag) = r.prop("getetag").map(|p| p.text.trim().to_string()).filter(|e| !e.is_empty()) {
                on_server.insert(r.href, etag);
            }
        }
        let removed = cursor.etags.keys().filter(|h| !on_server.contains_key(*h)).cloned().collect();
        Ok(DavBatch { sync_token: None, upserts: on_server.into_iter().map(|(h, e)| (h, e, String::new())).collect(), removed })
    }

    async fn multiget(&self, kind: CollectionKind, url: reqwest::Url, hrefs: &[String]) -> Result<Vec<(String, String, String)>> {
        let (report, data) = match kind {
            CollectionKind::Calendar => ("c:calendar-multiget", "<c:calendar-data/>"),
            CollectionKind::Contacts => ("cr:addressbook-multiget", "<cr:address-data/>"),
        };
        let data_local = match kind {
            CollectionKind::Calendar => "calendar-data",
            CollectionKind::Contacts => "address-data",
        };
        let mut out = Vec::new();
        for chunk in hrefs.chunks(MULTIGET_CHUNK) {
            let list: String = chunk.iter().map(|h| format!("<d:href>{}</d:href>", xml_escape(h))).collect();
            let body = format!(r#"<?xml version="1.0" encoding="utf-8"?><{report} xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cr="urn:ietf:params:xml:ns:carddav"><d:prop><d:getetag/>{data}</d:prop>{list}</{report}>"#);
            let (status, _, text, _) = self.send("REPORT", url.clone(), Some("1"), &[], Some(("application/xml; charset=utf-8", body))).await?;
            if status != StatusCode::MULTI_STATUS {
                return Err(Error::Network(format!("the server answered {status} when fetching items")));
            }
            for r in parse_multistatus(&text)?.responses {
                let etag = r.prop("getetag").map(|p| p.text.trim().to_string()).unwrap_or_default();
                if let Some(body) = r.prop(data_local).map(|p| p.text.clone()).filter(|b| !b.trim().is_empty()) {
                    out.push((r.href, etag, body));
                }
            }
        }
        Ok(out)
    }

    /// Pushes one local change. The server wins any race: 412 (changed
    /// since we read it) and 404 on an edit both come back as `Conflict`.
    pub async fn push(&self, kind: CollectionKind, change: &DavChange) -> Result<DavOutcome> {
        let url = self.resolve(&change.href)?;
        let cond: (&str, String) = match &change.etag {
            Some(e) => ("If-Match", e.clone()),
            None => ("If-None-Match", "*".into()),
        };
        match &change.body {
            Some(body) => {
                let ct = match kind {
                    CollectionKind::Calendar => "text/calendar; charset=utf-8",
                    CollectionKind::Contacts => "text/vcard; charset=utf-8",
                };
                let (status, headers, text, _) = self.send("PUT", url, None, &[(cond.0, &cond.1)], Some((ct, body.clone()))).await?;
                match status {
                    s if s.is_success() => Ok(DavOutcome::Saved(headers.get(header::ETAG).and_then(|v| v.to_str().ok()).map(str::to_owned))),
                    StatusCode::PRECONDITION_FAILED | StatusCode::NOT_FOUND => Ok(DavOutcome::Conflict),
                    s => Err(Error::Network(format!("the server refused the change ({s}){}", short(&text)))),
                }
            }
            None => {
                let (status, _, text, _) = self.send("DELETE", url, None, &[(cond.0, &cond.1)], None).await?;
                match status {
                    s if s.is_success() => Ok(DavOutcome::Deleted),
                    StatusCode::NOT_FOUND | StatusCode::GONE => Ok(DavOutcome::Deleted),
                    StatusCode::PRECONDITION_FAILED => Ok(DavOutcome::Conflict),
                    s => Err(Error::Network(format!("the server refused the delete ({s}){}", short(&text)))),
                }
            }
        }
    }
}

fn short(text: &str) -> String {
    let t = text.trim();
    if t.is_empty() || t.starts_with('<') { String::new() } else { format!(": {}", t.chars().take(160).collect::<String>()) }
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

// ── Multistatus parsing ─────────────────────────────────────────────────────

#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct Prop {
    /// Concatenated text content (with entities resolved).
    text: String,
    /// `<href>` values inside the property.
    hrefs: Vec<String>,
    /// Local names of direct child elements (resourcetype, privileges).
    children: Vec<String>,
    /// `name` attributes of `<comp>` children (supported component sets).
    comps: Vec<String>,
}

#[derive(Debug, Default)]
struct Response {
    href: String,
    /// The response-level status (sync-collection uses 404 for removals).
    status: Option<u16>,
    /// Properties from 2xx propstats only.
    props: HashMap<String, Prop>,
}

impl Response {
    fn prop(&self, name: &str) -> Option<&Prop> {
        self.props.get(name)
    }
}

#[derive(Debug, Default)]
struct Multistatus {
    responses: Vec<Response>,
    sync_token: Option<String>,
}

fn status_code(line: &str) -> Option<u16> {
    line.split_whitespace().nth(1).and_then(|c| c.parse().ok())
}

/// A namespace-agnostic multistatus reader: DAV servers disagree on
/// prefixes, never on local names.
fn parse_multistatus(xml: &str) -> Result<Multistatus> {
    let bad = |e: &dyn std::fmt::Display| Error::Network(format!("the server sent invalid XML: {e}"));
    let mut reader = quick_xml::Reader::from_str(xml);
    let mut ms = Multistatus::default();
    let mut stack: Vec<String> = Vec::new();
    let mut resp: Option<Response> = None;
    let mut propstat: Vec<(String, Prop)> = Vec::new();
    let mut propstat_ok = true;
    let mut text = String::new();
    // Index into `stack` where the current property element sits.
    let mut prop_depth: Option<usize> = None;

    loop {
        let ev = reader.read_event().map_err(|e| bad(&e))?;
        match ev {
            Event::Start(ref e) | Event::Empty(ref e) => {
                let name = e.local_name().as_ref().to_string();
                let empty = matches!(ev, Event::Empty(_));
                let parent = stack.last().map(String::as_str);
                match (parent, name.as_str()) {
                    (_, "response") => resp = Some(Response::default()),
                    (_, "propstat") => {
                        propstat.clear();
                        propstat_ok = true;
                    }
                    (Some("prop"), _) => {
                        propstat.push((name.clone(), Prop::default()));
                        prop_depth = Some(stack.len());
                    }
                    _ => {
                        if let (Some(d), Some((_, p))) = (prop_depth, propstat.last_mut()) {
                            // Every descendant name: resourcetype lists types directly,
                            // privilege sets nest them one level down.
                            if stack.len() > d && name != "href" {
                                p.children.push(name.clone());
                            }
                            if name == "comp"
                                && let Some(Ok(a)) = e.attributes().find(|a| a.as_ref().is_ok_and(|a| a.key.local_name().as_ref() == "name")) {
                                    p.comps.push(a.normalized_value(quick_xml::XmlVersion::Implicit1_0).map_err(|e| bad(&e))?.into_owned());
                                }
                        }
                    }
                }
                text.clear();
                if empty {
                    // An empty property (`<getctag/>`) is complete as soon as it opens.
                    if parent == Some("prop") {
                        prop_depth = None;
                    }
                } else {
                    stack.push(name);
                }
            }
            Event::Text(t) => text.push_str(&t.into_inner()),
            Event::CData(t) => text.push_str(&t.into_inner()),
            Event::GeneralRef(r) => {
                if let Ok(Some(c)) = r.resolve_char_ref() {
                    text.push(c);
                } else if let Some(s) = quick_xml::escape::resolve_predefined_entity(&r.into_inner()) {
                    text.push_str(s);
                }
            }
            Event::End(_) => {
                let Some(name) = stack.pop() else { continue };
                let parent = stack.last().map(String::as_str);
                match (parent, name.as_str()) {
                    (Some("response"), "href") => {
                        if let Some(r) = resp.as_mut() {
                            r.href = percent_decode(text.trim());
                        }
                    }
                    (Some("response"), "status") => {
                        if let Some(r) = resp.as_mut() {
                            r.status = status_code(&text);
                        }
                    }
                    (Some("propstat"), "status") => propstat_ok = status_code(&text).is_some_and(|c| (200..300).contains(&c)),
                    (_, "propstat") => {
                        if let Some(r) = resp.as_mut()
                            && propstat_ok {
                                r.props.extend(propstat.drain(..));
                            }
                    }
                    (_, "response") => {
                        if let Some(r) = resp.take() {
                            ms.responses.push(r);
                        }
                    }
                    (Some("multistatus"), "sync-token") => ms.sync_token = Some(text.trim().to_string()).filter(|t| !t.is_empty()),
                    (Some("prop"), _) => {
                        if let Some((_, p)) = propstat.last_mut() {
                            p.text.push_str(&text);
                        }
                        prop_depth = None;
                    }
                    (_, "href") => {
                        if let Some((_, p)) = propstat.last_mut()
                            && prop_depth.is_some() {
                                p.hrefs.push(percent_decode(text.trim()));
                            }
                    }
                    _ => {}
                }
                text.clear();
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(ms)
}

/// Hrefs come percent-encoded; the store keeps them decoded and `Url::join`
/// re-encodes on the way out. Non-UTF-8 sequences are left as they were.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() && bytes[i + 1].is_ascii_hexdigit() && bytes[i + 2].is_ascii_hexdigit() {
            let hex = |b: u8| (b as char).to_digit(16).unwrap_or(0) as u8;
            out.push(hex(bytes[i + 1]) * 16 + hex(bytes[i + 2]));
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

/// How long the shell should wait between DAV polls.
pub const POLL: Duration = Duration::from_secs(5 * 60);

/// One collection's work for a sync pass, read from the store.
#[derive(Debug, Clone)]
pub struct DavPlan {
    pub collection_id: String,
    pub kind: CollectionKind,
    pub cursor: DavCursor,
    pub changes: Vec<DavChange>,
}

/// What came back for one collection, to apply to the store.
#[derive(Debug, Clone)]
pub struct DavResult {
    pub collection_id: String,
    /// (item id, outcome) for each pushed change.
    pub outcomes: Vec<(String, DavOutcome)>,
    pub batch: DavBatch,
}

/// Pushes each collection's local changes, then pulls its server changes.
/// Pushing first means our own writes come back as already-known etags.
pub async fn sync(dav: &Dav, plans: Vec<DavPlan>) -> Result<Vec<DavResult>> {
    let mut out = Vec::new();
    for plan in plans {
        let mut outcomes = Vec::new();
        let mut cursor = plan.cursor;
        for change in &plan.changes {
            let outcome = dav.push(plan.kind, change).await?;
            // Keep the cursor in step so the pull doesn't refetch what we just wrote.
            match &outcome {
                DavOutcome::Saved(Some(etag)) => {
                    cursor.etags.insert(change.href.clone(), etag.clone());
                }
                DavOutcome::Saved(None) | DavOutcome::Conflict => {
                    cursor.etags.remove(&change.href);
                }
                DavOutcome::Deleted => {
                    cursor.etags.remove(&change.href);
                }
            }
            outcomes.push((change.item_id.clone(), outcome));
        }
        let batch = dav.pull(plan.kind, &cursor).await?;
        out.push(DavResult { collection_id: plan.collection_id, outcomes, batch });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_collections_with_any_prefixes() {
        let xml = r##"<?xml version="1.0"?>
<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:A="http://apple.com/ns/ical/">
 <response><href>/dav/cal/</href><propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>
 <response><href>/dav/cal/work%20stuff/</href>
  <propstat><prop>
    <resourcetype><collection/><C:calendar/></resourcetype>
    <displayname>Work &amp; Life</displayname>
    <A:calendar-color>#2563EBFF</A:calendar-color>
    <C:supported-calendar-component-set><C:comp name="VEVENT"/><C:comp name="VTODO"/></C:supported-calendar-component-set>
    <current-user-privilege-set><privilege><read/></privilege><privilege><write/></privilege></current-user-privilege-set>
  </prop><status>HTTP/1.1 200 OK</status></propstat>
  <propstat><prop><getctag/></prop><status>HTTP/1.1 404 Not Found</status></propstat>
 </response>
</multistatus>"##;
        let ms = parse_multistatus(xml).unwrap();
        assert_eq!(ms.responses.len(), 2);
        let r = &ms.responses[1];
        assert_eq!(r.href, "/dav/cal/work stuff/");
        assert_eq!(r.prop("displayname").unwrap().text, "Work & Life");
        assert!(r.prop("resourcetype").unwrap().children.contains(&"calendar".to_string()));
        assert_eq!(r.prop("supported-calendar-component-set").unwrap().comps, ["VEVENT", "VTODO"]);
        let privs = &r.prop("current-user-privilege-set").unwrap().children;
        assert!(privs.contains(&"write".to_string()), "nested privilege names count");
        assert!(r.prop("getctag").is_none(), "404 propstats are dropped");
    }

    #[test]
    fn parses_principal_hrefs_and_sync_reports() {
        let xml = r#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/principals/ana/</d:href></d:current-user-principal></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"#;
        let ms = parse_multistatus(xml).unwrap();
        assert_eq!(ms.responses[0].prop("current-user-principal").unwrap().hrefs, ["/principals/ana/"]);

        let sync = r#"<multistatus xmlns="DAV:">
<response><href>/c/a.ics</href><propstat><prop><getetag>"1"</getetag></prop><status>HTTP/1.1 200 OK</status></propstat></response>
<response><href>/c/gone.ics</href><status>HTTP/1.1 404 Not Found</status></response>
<sync-token>http://x/sync/42</sync-token></multistatus>"#;
        let ms = parse_multistatus(sync).unwrap();
        assert_eq!(ms.sync_token.as_deref(), Some("http://x/sync/42"));
        assert_eq!(ms.responses[0].prop("getetag").unwrap().text, "\"1\"");
        assert_eq!(ms.responses[1].status, Some(404));
    }

    #[test]
    fn calendar_data_keeps_its_line_breaks_and_entities() {
        let xml = "<multistatus xmlns=\"DAV:\" xmlns:C=\"urn:ietf:params:xml:ns:caldav\"><response><href>/c/a.ics</href><propstat><prop><getetag>\"9\"</getetag><C:calendar-data>BEGIN:VCALENDAR&#13;\nSUMMARY:Tom &amp; Jerry&#13;\nEND:VCALENDAR&#13;\n</C:calendar-data></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>";
        let ms = parse_multistatus(xml).unwrap();
        let data = &ms.responses[0].prop("calendar-data").unwrap().text;
        assert!(data.contains("SUMMARY:Tom & Jerry\r\n"), "{data:?}");
    }

    #[test]
    fn refuses_plain_http_off_device() {
        assert!(Dav::new("http://dav.example.com/", "u", "p").is_err());
        assert!(Dav::new("http://127.0.0.1:8080/", "u", "p").is_ok());
    }

    #[test]
    fn decodes_percent_escapes() {
        assert_eq!(percent_decode("/a%20b/%C3%A9.ics"), "/a b/é.ics");
        assert_eq!(percent_decode("/100%"), "/100%");
    }
}
