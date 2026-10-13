//! JMAP (RFC 8620 core, RFC 8621 mail): sync INBOX and send.
//!
//! JMAP is HTTP + JSON, so one connection does what IMAP + SMTP do. Sync is
//! incremental by design: `Email/changes` returns exactly what changed since
//! the last state string, so nothing needs a full flag scan.
//!
//! Like the IMAP adapter, these functions return plain data and never touch
//! the store.

use std::collections::HashMap;

use base64::Engine;
use serde_json::{Value, json};

use crate::{
    AccountConfig, Draft, Error, JmapConfig, OpKind, RemoteBatch, RemoteCursor, RemoteMessage,
    RemoteOp, Result,
    store::{ARCHIVE, INBOX, SENT},
};

use super::{BACKFILL_CHUNK, Change, INITIAL_SYNC_LIMIT, TIMEOUT, build_message, tls_config};

const CORE: &str = "urn:ietf:params:jmap:core";
const MAIL: &str = "urn:ietf:params:jmap:mail";
const SUBMISSION: &str = "urn:ietf:params:jmap:submission";

/// An authenticated JMAP session.
struct Session {
    http: reqwest::Client,
    auth: String,
    api_url: String,
    download_url: String,
    upload_url: String,
    event_source_url: Option<String>,
    account_id: String,
}

fn http_err(e: reqwest::Error) -> Error {
    if e.is_timeout() {
        Error::Network("the server took too long to answer".into())
    } else {
        Error::Network(e.to_string())
    }
}

/// Resolve a URL from the session object against the session URL (servers
/// may return relative paths such as `/jmap/`).
fn resolve(base: &str, url: &str) -> Result<String> {
    let base = reqwest::Url::parse(base).map_err(|_| Error::Invalid(format!("“{base}” isn't a valid URL")))?;
    base.join(url)
        .map(|u| u.to_string())
        // `join` percent-encodes the template braces; put them back.
        .map(|u| u.replace("%7B", "{").replace("%7D", "}"))
        .map_err(|_| Error::Network(format!("the server sent an invalid URL: {url}")))
}

fn fill(template: &str, vars: &[(&str, &str)]) -> String {
    let mut out = template.to_owned();
    for (k, v) in vars {
        let encoded: String = url_escape(v);
        out = out.replace(&format!("{{{k}}}"), &encoded);
    }
    out
}

fn url_escape(v: &str) -> String {
    v.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn is_local(url: &str) -> bool {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| matches!(h, "localhost" | "127.0.0.1" | "[::1]")))
        .unwrap_or(false)
}

async fn connect(config: &AccountConfig, secret: &str) -> Result<Session> {
    let jmap: &JmapConfig = config
        .jmap
        .as_ref()
        .ok_or_else(|| Error::Invalid("this account isn't set up for JMAP".into()))?;
    if jmap.session_url.starts_with("http://") && !is_local(&jmap.session_url) {
        return Err(Error::Invalid("JMAP needs https:// (plain http is only allowed for localhost)".into()));
    }
    let http = reqwest::Client::builder()
        .tls_backend_preconfigured(tls_config())
        .timeout(TIMEOUT)
        .build()
        .map_err(http_err)?;
    let auth = if jmap.bearer {
        format!("Bearer {secret}")
    } else {
        let pair = format!("{}:{secret}", config.username);
        format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(pair))
    };
    let res = http
        .get(&jmap.session_url)
        .header("Authorization", &auth)
        .send()
        .await
        .map_err(http_err)?;
    if res.status() == reqwest::StatusCode::UNAUTHORIZED || res.status() == reqwest::StatusCode::FORBIDDEN {
        return Err(Error::Auth("the server didn't accept these credentials".into()));
    }
    if !res.status().is_success() {
        return Err(Error::Network(format!("the session request failed ({})", res.status())));
    }
    let s: Value = res.json().await.map_err(http_err)?;
    let str_at = |k: &str| {
        s[k].as_str()
            .map(str::to_owned)
            .ok_or_else(|| Error::Network(format!("the JMAP session is missing “{k}”")))
    };
    let account_id = s["primaryAccounts"][MAIL]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| Error::Network("this JMAP server has no mail account for you".into()))?;
    Ok(Session {
        api_url: resolve(&jmap.session_url, &str_at("apiUrl")?)?,
        download_url: resolve(&jmap.session_url, &str_at("downloadUrl")?)?,
        upload_url: resolve(&jmap.session_url, &str_at("uploadUrl")?)?,
        event_source_url: s["eventSourceUrl"].as_str().map(|u| resolve(&jmap.session_url, u)).transpose()?,
        http,
        auth,
        account_id,
    })
}

impl Session {
    /// Run method calls in one request. Returns each response's arguments by
    /// call id; a JMAP `error` response becomes an `Err`.
    async fn call(&self, using: &[&str], calls: Vec<Value>) -> Result<HashMap<String, Value>> {
        let res = self
            .http
            .post(&self.api_url)
            .header("Authorization", &self.auth)
            .json(&json!({ "using": using, "methodCalls": calls }))
            .send()
            .await
            .map_err(http_err)?;
        if !res.status().is_success() {
            return Err(Error::Network(format!("the JMAP request failed ({})", res.status())));
        }
        let body: Value = res.json().await.map_err(http_err)?;
        let mut out = HashMap::new();
        for r in body["methodResponses"].as_array().cloned().unwrap_or_default() {
            let (name, args, id) = (r[0].as_str().unwrap_or(""), r[1].clone(), r[2].as_str().unwrap_or("").to_owned());
            if name == "error" {
                // Callers that can recover (cannotCalculateChanges) look for this.
                out.insert(id, json!({ "__error": args["type"] }));
            } else {
                out.insert(id, args);
            }
        }
        Ok(out)
    }

    async fn one(&self, using: &[&str], method: &str, args: Value) -> Result<Value> {
        let mut r = self.call(using, vec![json!([method, args, "0"])]).await?;
        let v = r.remove("0").ok_or_else(|| Error::Network(format!("no answer to {method}")))?;
        if let Some(t) = v.get("__error") {
            return Err(Error::Network(format!("{method} failed: {}", t.as_str().unwrap_or("error"))));
        }
        Ok(v)
    }

    /// Mailbox ids by role ("inbox", "archive", "sent").
    async fn roles(&self) -> Result<HashMap<String, String>> {
        let v = self
            .one(&[CORE, MAIL], "Mailbox/get", json!({ "accountId": self.account_id, "properties": ["id", "role"] }))
            .await?;
        Ok(v["list"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|m| Some((m["role"].as_str()?.to_owned(), m["id"].as_str()?.to_owned())))
            .collect())
    }

    async fn download(&self, blob_id: &str) -> Result<Vec<u8>> {
        let url = fill(
            &self.download_url,
            &[("accountId", &self.account_id), ("blobId", blob_id), ("name", "message.eml"), ("type", "message/rfc822")],
        );
        let res = self.http.get(url).header("Authorization", &self.auth).send().await.map_err(http_err)?;
        if !res.status().is_success() {
            return Err(Error::Network(format!("downloading a message failed ({})", res.status())));
        }
        Ok(res.bytes().await.map_err(http_err)?.to_vec())
    }

    async fn upload(&self, bytes: Vec<u8>) -> Result<String> {
        let url = fill(&self.upload_url, &[("accountId", &self.account_id)]);
        let res = self
            .http
            .post(url)
            .header("Authorization", &self.auth)
            .header("Content-Type", "message/rfc822")
            .body(bytes)
            .send()
            .await
            .map_err(http_err)?;
        if !res.status().is_success() {
            return Err(Error::Network(format!("uploading the message failed ({})", res.status())));
        }
        let v: Value = res.json().await.map_err(http_err)?;
        v["blobId"].as_str().map(str::to_owned).ok_or_else(|| Error::Network("the upload returned no blob id".into()))
    }
}

/// Check that the session loads and the account has an Inbox.
pub async fn verify(config: &AccountConfig, secret: &str) -> Result<()> {
    let s = connect(config, secret).await?;
    if !s.roles().await?.contains_key("inbox") {
        return Err(Error::Network("this account has no Inbox".into()));
    }
    Ok(())
}

struct Meta {
    id: String,
    blob: String,
    seen: bool,
    flagged: bool,
    mailbox_ids: Value,
}

fn metas(v: &Value) -> Vec<Meta> {
    v["list"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|e| {
            Some(Meta {
                id: e["id"].as_str()?.to_owned(),
                blob: e["blobId"].as_str()?.to_owned(),
                seen: e["keywords"]["$seen"].as_bool().unwrap_or(false),
                flagged: e["keywords"]["$flagged"].as_bool().unwrap_or(false),
                mailbox_ids: e["mailboxIds"].clone(),
            })
        })
        .collect()
}

const PROPS: [&str; 4] = ["id", "blobId", "keywords", "mailboxIds"];

/// Server mailbox ids for the roles we track, and which store mailbox each feeds.
struct Tracked(Vec<(String, &'static str)>);

impl Tracked {
    fn from_roles(roles: &HashMap<String, String>) -> Result<Self> {
        let inbox = roles.get("inbox").ok_or_else(|| Error::Network("this account has no Inbox".into()))?;
        let mut list = vec![(inbox.clone(), INBOX)];
        if let Some(a) = roles.get("archive") {
            list.push((a.clone(), ARCHIVE));
        }
        if let Some(s) = roles.get("sent") {
            list.push((s.clone(), SENT));
        }
        Ok(Self(list))
    }

    /// Where an email belongs. JMAP mail can sit in several mailboxes at
    /// once; the inbox wins, then archive, then sent. `None` = untracked
    /// (trash, junk, custom folders).
    fn classify(&self, mailbox_ids: &Value) -> Option<&'static str> {
        self.0.iter().find(|(id, _)| mailbox_ids[id].as_bool() == Some(true)).map(|(_, store)| *store)
    }

    fn server_id(&self, store: &str) -> Option<&str> {
        self.0.iter().find(|(_, s)| *s == store).map(|(id, _)| id.as_str())
    }
}

/// One sync pass of the whole account: push local changes, apply every
/// change since the last state (across Inbox, Archive, and Sent), and
/// backfill one chunk of older mail per mailbox.
pub async fn sync_account(config: &AccountConfig, secret: &str, cursor: RemoteCursor, ops: &[RemoteOp]) -> Result<RemoteBatch> {
    let s = connect(config, secret).await?;
    let roles = s.roles().await?;
    let tracked = Tracked::from_roles(&roles)?;
    let inbox = tracked.server_id(INBOX).unwrap().to_owned();

    // 1. Push local changes in one Email/set.
    let mut applied_ops = Vec::new();
    if !ops.is_empty() {
        let mut update = serde_json::Map::new();
        for op in ops {
            let patch = update.entry(op.remote_id.clone()).or_insert_with(|| json!({}));
            match op.kind {
                OpKind::Seen(on) => patch["keywords/$seen"] = if on { json!(true) } else { Value::Null },
                OpKind::Flagged(on) => patch["keywords/$flagged"] = if on { json!(true) } else { Value::Null },
                // No Archive mailbox: archiving stays local-only, as with IMAP.
                OpKind::Archive | OpKind::Unarchive => {
                    if let Some(archive) = tracked.server_id(ARCHIVE) {
                        let (from, to) = if op.kind == OpKind::Archive { (&inbox[..], archive) } else { (archive, &inbox[..]) };
                        patch[format!("mailboxIds/{from}")] = Value::Null;
                        patch[format!("mailboxIds/{to}")] = json!(true);
                    }
                }
            }
        }
        update.retain(|_, v| v.as_object().is_some_and(|o| !o.is_empty()));
        if !update.is_empty() {
            let v = s.one(&[CORE, MAIL], "Email/set", json!({ "accountId": s.account_id, "update": update })).await?;
            // notFound means the message is already gone: nothing left to push.
            let failed = v["notUpdated"].as_object().into_iter().flatten().find(|(_, e)| e["type"] != "notFound");
            if let Some((id, e)) = failed {
                return Err(Error::Network(format!("the server refused a change to message {id}: {}", e["type"])));
            }
        }
        applied_ops = ops.iter().map(|o| o.id).collect();
    }

    // 2. Changes since the last pass, for every tracked mailbox at once.
    let mut batch = RemoteBatch { applied_ops, ..Default::default() };
    let mut known = cursor.known.clone();
    let mut state = cursor.state.clone();
    if let Some(mut since) = state.clone() {
        loop {
            let r = s
                .call(&[CORE, MAIL], vec![
                    json!(["Email/changes", { "accountId": s.account_id, "sinceState": since, "maxChanges": 500 }, "c"]),
                    json!(["Email/get", { "accountId": s.account_id, "#ids": { "resultOf": "c", "name": "Email/changes", "path": "/created" }, "properties": PROPS }, "gc"]),
                    json!(["Email/get", { "accountId": s.account_id, "#ids": { "resultOf": "c", "name": "Email/changes", "path": "/updated" }, "properties": PROPS }, "gu"]),
                ])
                .await?;
            let changes = &r["c"];
            if changes.get("__error").is_some() {
                // State too old to diff (cannotCalculateChanges): start over.
                batch = RemoteBatch { reset: true, applied_ops: batch.applied_ops, ..Default::default() };
                known.clear();
                state = None;
                break;
            }
            for m in metas(&r["gc"]).into_iter().chain(metas(&r["gu"])) {
                let target = tracked.classify(&m.mailbox_ids);
                match (target, known.get(&m.id).cloned()) {
                    (Some(to), Some(at)) => {
                        if at != to {
                            batch.moved.push((m.id.clone(), to.to_owned()));
                            known.insert(m.id.clone(), to.to_owned());
                        }
                        batch.flags.push((m.id, m.seen, m.flagged));
                    }
                    (Some(to), None) => {
                        let raw = s.download(&m.blob).await?;
                        known.insert(m.id.clone(), to.to_owned());
                        batch.new_messages.push(RemoteMessage { remote_id: m.id, mailbox: to.to_owned(), seen: m.seen, flagged: m.flagged, raw });
                    }
                    (None, Some(_)) => {
                        known.remove(&m.id);
                        batch.removed.push(m.id);
                    }
                    (None, None) => {}
                }
            }
            for id in changes["destroyed"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                if known.remove(id).is_some() {
                    batch.removed.push(id.to_owned());
                }
            }
            since = changes["newState"].as_str().unwrap_or(&since).to_owned();
            state = Some(since.clone());
            if !changes["hasMoreChanges"].as_bool().unwrap_or(false) {
                break;
            }
        }
    }

    // 3. One page per mailbox: newest first on the first pass, then older chunks.
    let first = state.is_none();
    let mut calls = Vec::new();
    for (i, (server_id, store)) in tracked.0.iter().enumerate() {
        let have = known.values().filter(|m| m == store).count();
        let limit = match (first, *store) {
            (true, INBOX) => INITIAL_SYNC_LIMIT,
            _ => BACKFILL_CHUNK,
        };
        calls.push(json!(["Email/query", {
            "accountId": s.account_id,
            "filter": { "inMailbox": server_id },
            "sort": [{ "property": "receivedAt", "isAscending": false }],
            "position": if first { 0 } else { have }, "limit": limit, "calculateTotal": true,
        }, format!("q{i}")]));
        calls.push(json!(["Email/get", { "accountId": s.account_id, "#ids": { "resultOf": format!("q{i}"), "name": "Email/query", "path": "/ids" }, "properties": PROPS }, format!("g{i}")]));
    }
    let r = s.call(&[CORE, MAIL], calls).await?;
    let mut email_state = None;
    for (i, (_, store)) in tracked.0.iter().enumerate() {
        let (q, g) = (&r[&format!("q{i}")], &r[&format!("g{i}")]);
        if let Some(e) = q.get("__error") {
            return Err(Error::Network(format!("Email/query failed: {e}")));
        }
        email_state = email_state.or_else(|| g["state"].as_str().map(str::to_owned));
        for m in metas(g) {
            // Mail in two tracked mailboxes appears in both queries; classify picks one.
            let Some(to) = tracked.classify(&m.mailbox_ids) else { continue };
            if !known.contains_key(&m.id) {
                let raw = s.download(&m.blob).await?;
                known.insert(m.id.clone(), to.to_owned());
                batch.new_messages.push(RemoteMessage { remote_id: m.id, mailbox: to.to_owned(), seen: m.seen, flagged: m.flagged, raw });
            }
        }
        let total = q["total"].as_u64().unwrap_or(0) as usize;
        let have = known.values().filter(|m| m == store).count();
        batch.more_older |= have < total;
    }
    // The Email/get state is the point we resume from (RFC 8620 §5.2).
    batch.state = match state {
        Some(s) if !first => s,
        _ => email_state.unwrap_or_default(),
    };
    Ok(batch)
}

/// Wait for the server to push an Email change over EventSource (RFC 8620
/// §7.3), or for `timeout`. `current_state` is the state we already have, so
/// a server that announces the present state on connect doesn't cause a sync.
pub async fn wait_for_change(config: &AccountConfig, secret: &str, current_state: Option<&str>, timeout: std::time::Duration) -> Result<Change> {
    let s = connect(config, secret).await?;
    let Some(template) = &s.event_source_url else { return Ok(Change::Unsupported) };
    let url = fill(template, &[("types", "Email"), ("closeafter", "no"), ("ping", "60")]);
    // A long-lived stream: no whole-request timeout, only on connect.
    let http = reqwest::Client::builder()
        .tls_backend_preconfigured(tls_config())
        .connect_timeout(TIMEOUT)
        .build()
        .map_err(http_err)?;
    let wait = async {
        let mut res = http
            .get(url)
            .header("Authorization", &s.auth)
            .header("Accept", "text/event-stream")
            .send()
            .await
            .map_err(http_err)?;
        if !res.status().is_success() {
            return Ok(Change::Unsupported);
        }
        let mut buf = String::new();
        while let Some(chunk) = res.chunk().await.map_err(http_err)? {
            buf.push_str(&String::from_utf8_lossy(&chunk));
            // Events end with a blank line.
            while let Some(end) = buf.find("\n\n").or_else(|| buf.find("\r\n\r\n")) {
                let event: String = buf.drain(..end).collect();
                buf = buf.trim_start_matches(['\r', '\n']).to_owned();
                if let Some(Change::Changed) = parse_event(&event, &s.account_id, current_state) {
                    return Ok(Change::Changed);
                }
            }
        }
        Ok(Change::Quiet) // the server closed the stream
    };
    match tokio::time::timeout(timeout, wait).await {
        Ok(result) => result,
        Err(_) => Ok(Change::Quiet),
    }
}

/// One server-sent event: `event: state` with a StateChange `data:` payload.
fn parse_event(event: &str, account_id: &str, current_state: Option<&str>) -> Option<Change> {
    let mut kind = "message";
    let mut data = String::new();
    for line in event.lines() {
        if let Some(v) = line.strip_prefix("event:") {
            kind = v.trim();
        } else if let Some(v) = line.strip_prefix("data:") {
            data.push_str(v.trim_start());
        }
    }
    if kind != "state" {
        return None; // pings and comments
    }
    let v: Value = serde_json::from_str(&data).ok()?;
    let new = v["changed"][account_id]["Email"].as_str()?;
    (Some(new) != current_state).then_some(Change::Changed)
}

/// Send a draft: upload the message, file it in Sent, and submit it.
/// Returns the raw message, like the SMTP path.
pub async fn send(config: &AccountConfig, secret: &str, draft: &Draft) -> Result<Vec<u8>> {
    let raw = build_message(config, draft)?.formatted();
    let s = connect(config, secret).await?;
    let roles = s.roles().await?;
    let identities = s.one(&[CORE, MAIL, SUBMISSION], "Identity/get", json!({ "accountId": s.account_id })).await?;
    let identity = identities["list"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|i| i["email"].as_str().is_some_and(|e| e.eq_ignore_ascii_case(&config.address)))
        .or_else(|| identities["list"].get(0))
        .and_then(|i| i["id"].as_str())
        .map(str::to_owned)
        .ok_or_else(|| Error::Invalid(format!("the server has no sending identity for {}", config.address)))?;

    let blob = s.upload(raw.clone()).await?;
    let mut mailboxes = serde_json::Map::new();
    if let Some(sent) = roles.get("sent") {
        mailboxes.insert(sent.clone(), json!(true));
    } else if let Some(drafts) = roles.get("drafts") {
        mailboxes.insert(drafts.clone(), json!(true));
    }
    let imported = s
        .one(&[CORE, MAIL], "Email/import", json!({
            "accountId": s.account_id,
            "emails": { "m": { "blobId": blob, "mailboxIds": mailboxes, "keywords": { "$seen": true } } },
        }))
        .await?;
    let email_id = imported["created"]["m"]["id"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| Error::Network(format!("the server couldn't store the message: {}", imported["notCreated"]["m"])))?;
    let submitted = s
        .one(&[CORE, MAIL, SUBMISSION], "EmailSubmission/set", json!({
            "accountId": s.account_id,
            "create": { "s": { "emailId": email_id, "identityId": identity } },
        }))
        .await?;
    if submitted["created"]["s"].is_null() {
        return Err(Error::Network(format!("the server refused to send: {}", submitted["notCreated"]["s"])));
    }
    Ok(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_relative_session_urls_and_keeps_templates() {
        assert_eq!(resolve("http://127.0.0.1:8080/jmap/session", "/jmap/").unwrap(), "http://127.0.0.1:8080/jmap/");
        assert_eq!(
            resolve("https://api.example.com/jmap/session", "/download/{accountId}/{blobId}/{name}?accept={type}").unwrap(),
            "https://api.example.com/download/{accountId}/{blobId}/{name}?accept={type}"
        );
        assert_eq!(resolve("https://a.example/s", "https://b.example/api").unwrap(), "https://b.example/api");
    }

    #[test]
    fn fills_url_templates_with_escaping() {
        let t = "https://x/download/{accountId}/{blobId}/{name}?accept={type}";
        assert_eq!(
            fill(t, &[("accountId", "u1"), ("blobId", "B/2"), ("name", "a b.eml"), ("type", "message/rfc822")]),
            "https://x/download/u1/B%2F2/a%20b.eml?accept=message%2Frfc822"
        );
    }

    #[test]
    fn parses_state_change_events() {
        let ev = "event: state\ndata: {\"@type\":\"StateChange\",\"changed\":{\"u1\":{\"Email\":\"s9\",\"Mailbox\":\"m2\"}}}";
        assert_eq!(parse_event(ev, "u1", Some("s8")), Some(Change::Changed));
        assert_eq!(parse_event(ev, "u1", Some("s9")), None, "the state we already have isn't a change");
        assert_eq!(parse_event(ev, "other", None), None, "another account's change");
        assert_eq!(parse_event(": ping", "u1", None), None);
        assert_eq!(parse_event("event: ping\ndata: {\"interval\":60}", "u1", None), None);
    }

    #[tokio::test]
    async fn refuses_plain_http_to_remote_hosts() {
        let mut config = crate::AccountConfig {
            display_name: "A".into(),
            address: "a@example.com".into(),
            username: "a".into(),
            provider: crate::Provider::Jmap,
            imap: crate::ServerConfig { host: String::new(), port: 0, security: crate::Security::Tls },
            smtp: crate::ServerConfig { host: String::new(), port: 0, security: crate::Security::Tls },
            jmap: Some(JmapConfig { session_url: "http://mail.example.com/jmap/session".into(), bearer: false }),
        };
        assert!(matches!(connect(&config, "p").await, Err(Error::Invalid(_))));
        config.jmap = None;
        assert!(matches!(connect(&config, "p").await, Err(Error::Invalid(_))));
    }
}
