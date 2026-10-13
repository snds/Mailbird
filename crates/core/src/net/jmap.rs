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
};

use super::{BACKFILL_CHUNK, INBOX, INITIAL_SYNC_LIMIT, TIMEOUT, build_message, tls_config};

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
    in_inbox: bool,
}

fn metas(v: &Value, inbox: &str) -> Vec<Meta> {
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
                in_inbox: e["mailboxIds"][inbox].as_bool().unwrap_or(false),
            })
        })
        .collect()
}

const PROPS: [&str; 4] = ["id", "blobId", "keywords", "mailboxIds"];

/// One sync pass of the Inbox: push local changes, apply server changes
/// since the last state, and backfill one chunk of older mail.
pub async fn sync_inbox(config: &AccountConfig, secret: &str, cursor: RemoteCursor, ops: &[RemoteOp]) -> Result<RemoteBatch> {
    let s = connect(config, secret).await?;
    let roles = s.roles().await?;
    let inbox = roles.get("inbox").cloned().ok_or_else(|| Error::Network("this account has no Inbox".into()))?;

    // 1. Push local changes in one Email/set.
    let mut applied_ops = Vec::new();
    if !ops.is_empty() {
        let mut update = serde_json::Map::new();
        for op in ops {
            let patch = update.entry(op.remote_id.clone()).or_insert_with(|| json!({}));
            match op.kind {
                OpKind::Seen(on) => patch["keywords/$seen"] = if on { json!(true) } else { Value::Null },
                OpKind::Flagged(on) => patch["keywords/$flagged"] = if on { json!(true) } else { Value::Null },
                OpKind::Archive => {
                    // No Archive mailbox: archiving stays local-only, as with IMAP.
                    if let Some(archive) = roles.get("archive") {
                        patch[format!("mailboxIds/{inbox}")] = Value::Null;
                        patch[format!("mailboxIds/{archive}")] = json!(true);
                    }
                }
            }
        }
        update.retain(|_, v| v.as_object().is_some_and(|o| !o.is_empty()));
        if !update.is_empty() {
            let v = s.one(&[CORE, MAIL], "Email/set", json!({ "accountId": s.account_id, "update": update })).await?;
            // notFound means the message is already gone: nothing left to push.
            let failed: Vec<&str> = v["notUpdated"]
                .as_object()
                .into_iter()
                .flatten()
                .filter(|(_, e)| e["type"] != "notFound")
                .map(|(k, _)| k.as_str())
                .collect();
            if let Some(id) = failed.first() {
                return Err(Error::Network(format!("the server refused a change to message {id}")));
            }
        }
        applied_ops = ops.iter().map(|o| o.id).collect();
    }

    // 2. Changes since the last pass.
    let mut batch = RemoteBatch { mailbox: INBOX.into(), applied_ops, ..Default::default() };
    let mut known = cursor.known.clone();
    let mut state = cursor.state.clone();
    if let Some(since) = state.clone() {
        let mut since = since;
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
                batch.reset = true;
                known.clear();
                state = None;
                break;
            }
            for m in metas(&r["gc"], &inbox).into_iter().chain(metas(&r["gu"], &inbox)) {
                match (m.in_inbox, known.contains(&m.id)) {
                    (true, true) => batch.flags.push((m.id, m.seen, m.flagged)),
                    (true, false) => {
                        let raw = s.download(&m.blob).await?;
                        known.insert(m.id.clone());
                        batch.new_messages.push(RemoteMessage { remote_id: m.id, seen: m.seen, flagged: m.flagged, raw });
                    }
                    (false, true) => batch.removed.push(m.id),
                    (false, false) => {}
                }
            }
            for id in changes["destroyed"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                if known.contains(id) {
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

    // 3. First pass: newest first. Later passes: one chunk of older mail.
    let first = state.is_none();
    let limit = if first { INITIAL_SYNC_LIMIT } else { BACKFILL_CHUNK };
    let position = if first { 0 } else { known.len() };
    let r = s
        .call(&[CORE, MAIL], vec![
            json!(["Email/query", {
                "accountId": s.account_id,
                "filter": { "inMailbox": inbox },
                "sort": [{ "property": "receivedAt", "isAscending": false }],
                "position": position, "limit": limit, "calculateTotal": true,
            }, "q"]),
            json!(["Email/get", { "accountId": s.account_id, "#ids": { "resultOf": "q", "name": "Email/query", "path": "/ids" }, "properties": PROPS }, "g"]),
        ])
        .await?;
    if let Some(e) = r["q"].get("__error") {
        return Err(Error::Network(format!("Email/query failed: {e}")));
    }
    for m in metas(&r["g"], &inbox) {
        if !known.contains(&m.id) {
            let raw = s.download(&m.blob).await?;
            known.insert(m.id.clone());
            batch.new_messages.push(RemoteMessage { remote_id: m.id, seen: m.seen, flagged: m.flagged, raw });
        }
    }
    let total = r["q"]["total"].as_u64().unwrap_or(0) as usize;
    batch.more_older = known.len() < total;
    // The Email/get state is the point we resume from (RFC 8620 §5.2).
    batch.state = match state {
        Some(s) if !first => s,
        _ => r["g"]["state"].as_str().unwrap_or_default().to_owned(),
    };
    Ok(batch)
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
