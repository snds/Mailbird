//! The Gmail API (v1): sync, label changes, and send, signed in with OAuth.
//!
//! Gmail has labels, not folders. Each message is classified into one store
//! mailbox by its labels:
//!
//! | Labels | Store mailbox |
//! |---|---|
//! | `TRASH`, `SPAM`, `DRAFT`, or `CHAT` | not tracked |
//! | `INBOX` | Inbox |
//! | `SENT` (not in the inbox) | Sent |
//! | anything else ("All Mail") | Archive |
//!
//! Sync mirrors the JMAP adapter and returns the same [`RemoteBatch`]:
//! `history.list` from the last `historyId` says which messages changed,
//! then `messages.get` reads their labels (and, for new ones, the raw
//! RFC 5322 bytes). A history id too old to diff (404) starts over.
//! Archiving is removing `INBOX`; read is removing `UNREAD`; star is `STARRED`.
//!
//! Gmail push needs a Cloud Pub/Sub topic and a server to receive it, which
//! a local-first app doesn't have. [`wait_for_change`] polls the profile's
//! `historyId` instead: one tiny request every half minute.

use std::collections::{BTreeSet, HashMap};
use std::time::Duration;

use base64::Engine;
use futures::{StreamExt, TryStreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    AccountConfig, Draft, Error, OpKind, RemoteBatch, RemoteCursor, RemoteMessage, RemoteOp, Result,
    store::{ARCHIVE, INBOX, SENT},
};

use super::{BACKFILL_CHUNK, Change, INITIAL_SYNC_LIMIT, TIMEOUT, build_message, tls_config};

pub const API: &str = "https://gmail.googleapis.com/gmail/v1/users/me";

/// Google Calendar over CalDAV (discovery finds each calendar from here).
pub const CALDAV: &str = "https://apidata.googleusercontent.com/caldav/v2/";

/// Google Contacts over CardDAV, for the signed-in address.
pub fn carddav(address: &str) -> String {
    format!("https://www.googleapis.com/carddav/v1/principals/{address}/")
}
/// How often [`wait_for_change`] asks whether anything changed.
pub const POLL: Duration = Duration::from_secs(30);
/// Messages fetched at once.
const PARALLEL: usize = 8;

/// Which store mailbox a message with these labels belongs in.
pub fn classify<S: AsRef<str>>(labels: &[S]) -> Option<&'static str> {
    let has = |l: &str| labels.iter().any(|x| x.as_ref() == l);
    if ["TRASH", "SPAM", "DRAFT", "CHAT"].iter().any(|l| has(l)) {
        None
    } else if has("INBOX") {
        Some(INBOX)
    } else if has("SENT") {
        Some(SENT)
    } else {
        Some(ARCHIVE)
    }
}

/// Labels to add and remove for a local change.
pub fn label_change(kind: OpKind) -> (&'static str, bool) {
    match kind {
        OpKind::Seen(on) => ("UNREAD", !on),
        OpKind::Flagged(on) => ("STARRED", on),
        OpKind::Archive => ("INBOX", false),
        OpKind::Unarchive => ("INBOX", true),
    }
}

/// What [`RemoteCursor::state`] holds for Gmail: the history id to diff from,
/// and where each mailbox's backfill left off (`""` = reached the end).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct State {
    pub history: String,
    #[serde(default)]
    pub pages: HashMap<String, String>,
}

impl State {
    pub fn parse(s: Option<&str>) -> Option<Self> {
        s.and_then(|s| serde_json::from_str(s).ok())
    }
}

/// The list query that feeds each store mailbox.
fn listing(store: &str) -> (Option<&'static str>, Option<&'static str>) {
    match store {
        INBOX => (Some("INBOX"), None),
        SENT => (Some("SENT"), None),
        _ => (None, Some("-in:inbox -in:sent -in:drafts -in:chats")),
    }
}

struct Api {
    http: reqwest::Client,
    base: String,
    token: String,
}

fn http_err(e: reqwest::Error) -> Error {
    if e.is_timeout() { Error::Network("Gmail took too long to answer".into()) } else { Error::Network(e.to_string()) }
}

impl Api {
    fn new(config: &AccountConfig, token: &str) -> Result<Self> {
        let base = config.oauth.as_ref().and_then(|o| o.api_base.clone()).unwrap_or_else(|| API.to_owned());
        let http = reqwest::Client::builder().tls_backend_preconfigured(tls_config()).timeout(TIMEOUT).build().map_err(http_err)?;
        Ok(Self { http, base: base.trim_end_matches('/').to_owned(), token: token.to_owned() })
    }

    /// `Ok(None)` for 404, so callers can treat "gone" as data.
    async fn send(&self, req: reqwest::RequestBuilder) -> Result<Option<Value>> {
        let res = req.bearer_auth(&self.token).send().await.map_err(http_err)?;
        let status = res.status();
        if status == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let text = res.text().await.map_err(http_err)?;
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(Error::Auth("Google needs you to sign in again".into()));
        }
        if !status.is_success() {
            let v: Value = serde_json::from_str(&text).unwrap_or_default();
            let msg = v["error"]["message"].as_str().unwrap_or("request failed").to_owned();
            return Err(if status == reqwest::StatusCode::FORBIDDEN && v["error"]["errors"][0]["reason"] == "insufficientPermissions" {
                Error::Auth("this sign-in didn't grant mail access — sign in again and allow Gmail".into())
            } else {
                Error::Network(format!("Gmail: {msg} ({status})"))
            });
        }
        Ok(Some(if text.is_empty() { Value::Null } else { serde_json::from_str(&text).map_err(|_| Error::Network("Gmail sent an unreadable reply".into()))? }))
    }

    async fn get(&self, path: &str, query: &[(&str, &str)]) -> Result<Option<Value>> {
        self.send(self.http.get(format!("{}{path}", self.base)).query(query)).await
    }

    async fn post(&self, path: &str, body: Value) -> Result<Option<Value>> {
        self.send(self.http.post(format!("{}{path}", self.base)).json(&body)).await
    }

    async fn profile(&self) -> Result<Value> {
        self.get("/profile", &[]).await?.ok_or_else(|| Error::Network("Gmail has no mailbox for this account".into()))
    }

    /// A message's labels, or `None` once it's gone.
    async fn labels(&self, id: &str) -> Result<Option<Vec<String>>> {
        Ok(self.get(&format!("/messages/{id}"), &[("format", "minimal")]).await?.map(|m| strings(&m["labelIds"])))
    }

    /// The raw message and its labels.
    async fn raw(&self, id: &str) -> Result<Option<(Vec<u8>, Vec<String>)>> {
        let Some(m) = self.get(&format!("/messages/{id}"), &[("format", "raw")]).await? else { return Ok(None) };
        let raw = m["raw"].as_str().unwrap_or_default();
        let bytes = base64::engine::general_purpose::URL_SAFE.decode(pad(raw)).map_err(|_| Error::Parse(format!("Gmail message {id} isn't valid base64")))?;
        Ok(Some((bytes, strings(&m["labelIds"]))))
    }

    /// One page of a mailbox, newest first: (ids, next page token).
    async fn list(&self, store: &str, page: Option<&str>, limit: usize) -> Result<(Vec<String>, Option<String>)> {
        let (label, q) = listing(store);
        let limit = limit.to_string();
        let mut query = vec![("maxResults", limit.as_str())];
        if let Some(l) = label {
            query.push(("labelIds", l));
        }
        if let Some(q) = q {
            query.push(("q", q));
        }
        if let Some(p) = page {
            query.push(("pageToken", p));
        }
        let v = self.get("/messages", &query).await?.unwrap_or_default();
        let ids = v["messages"].as_array().into_iter().flatten().filter_map(|m| m["id"].as_str().map(str::to_owned)).collect();
        Ok((ids, v["nextPageToken"].as_str().map(str::to_owned)))
    }
}

/// A downloaded message (raw bytes and labels), or `None` if it was gone.
type Fetched = (String, Option<(Vec<u8>, Vec<String>)>);

fn strings(v: &Value) -> Vec<String> {
    v.as_array().into_iter().flatten().filter_map(|s| s.as_str().map(str::to_owned)).collect()
}

/// Gmail's base64url may arrive without padding.
fn pad(s: &str) -> String {
    let mut s = s.to_owned();
    while !s.len().is_multiple_of(4) {
        s.push('=');
    }
    s
}

/// Checks the token works and returns the mailbox's address.
pub async fn verify(config: &AccountConfig, token: &str) -> Result<String> {
    let p = Api::new(config, token)?.profile().await?;
    p["emailAddress"].as_str().map(str::to_owned).ok_or_else(|| Error::Network("Gmail didn't say which address this is".into()))
}

/// Pushes local changes. Ops are grouped into one `batchModify` per label
/// change; if a batch fails (an id was deleted meanwhile), each message is
/// retried alone and the gone ones are skipped.
async fn push(api: &Api, ops: &[RemoteOp]) -> Result<Vec<i64>> {
    let mut groups: HashMap<(&str, bool), Vec<&RemoteOp>> = HashMap::new();
    for op in ops {
        groups.entry(label_change(op.kind)).or_default().push(op);
    }
    for ((label, add), group) in groups {
        let ids: BTreeSet<&str> = group.iter().map(|o| o.remote_id.as_str()).collect();
        let body = |ids: Vec<&str>| {
            if add { json!({ "ids": ids, "addLabelIds": [label] }) } else { json!({ "ids": ids, "removeLabelIds": [label] }) }
        };
        if api.post("/messages/batchModify", body(ids.iter().copied().collect())).await.is_err() {
            for id in ids {
                let single = if add { json!({ "addLabelIds": [label] }) } else { json!({ "removeLabelIds": [label] }) };
                api.post(&format!("/messages/{id}/modify"), single).await?;
            }
        }
    }
    Ok(ops.iter().map(|o| o.id).collect())
}

/// One sync pass: push local changes, apply everything since the last
/// history id, then take one page of older mail per mailbox.
pub async fn sync_account(config: &AccountConfig, token: &str, cursor: RemoteCursor, ops: &[RemoteOp]) -> Result<RemoteBatch> {
    let api = Api::new(config, token)?;
    let applied_ops = if ops.is_empty() { Vec::new() } else { push(&api, ops).await? };
    let mut batch = RemoteBatch { applied_ops, ..Default::default() };
    let mut known = cursor.known.clone();
    let mut state = State::parse(cursor.state.as_deref());

    // 1. History since the last pass.
    if let Some(st) = state.as_mut() {
        let mut touched: BTreeSet<String> = BTreeSet::new();
        let mut deleted: BTreeSet<String> = BTreeSet::new();
        let mut page: Option<String> = None;
        let mut latest = st.history.clone();
        let mut expired = false;
        loop {
            let mut q = vec![("startHistoryId", st.history.as_str()), ("maxResults", "500")];
            if let Some(p) = page.as_deref() {
                q.push(("pageToken", p));
            }
            let Some(v) = api.get("/history", &q).await? else {
                expired = true; // 404: too old to diff
                break;
            };
            for h in v["history"].as_array().into_iter().flatten() {
                for key in ["messagesAdded", "labelsAdded", "labelsRemoved"] {
                    for e in h[key].as_array().into_iter().flatten() {
                        if let Some(id) = e["message"]["id"].as_str() {
                            touched.insert(id.to_owned());
                        }
                    }
                }
                for e in h["messagesDeleted"].as_array().into_iter().flatten() {
                    if let Some(id) = e["message"]["id"].as_str() {
                        deleted.insert(id.to_owned());
                    }
                }
            }
            if let Some(id) = v["historyId"].as_str() {
                latest = id.to_owned();
            }
            match v["nextPageToken"].as_str() {
                Some(p) => page = Some(p.to_owned()),
                None => break,
            }
        }
        if expired {
            batch = RemoteBatch { reset: true, applied_ops: batch.applied_ops, ..Default::default() };
            known.clear();
            state = None;
        } else {
            for id in &deleted {
                touched.remove(id);
                if known.remove(id).is_some() {
                    batch.removed.push(id.clone());
                }
            }
            let labels: Vec<(String, Option<Vec<String>>)> = futures::stream::iter(touched.into_iter().map(|id| {
                let api = &api;
                async move { api.labels(&id).await.map(|l| (id, l)) }
            }))
            .buffered(PARALLEL)
            .try_collect()
            .await?;
            let mut new_ids = Vec::new();
            for (id, labels) in labels {
                let target = labels.as_deref().and_then(classify);
                match (target, known.get(&id).cloned()) {
                    (Some(to), Some(at)) => {
                        let l = labels.unwrap_or_default();
                        if at != to {
                            batch.moved.push((id.clone(), to.to_owned()));
                            known.insert(id.clone(), to.to_owned());
                        }
                        batch.flags.push((id, !l.iter().any(|x| x == "UNREAD"), l.iter().any(|x| x == "STARRED")));
                    }
                    (Some(_), None) => new_ids.push(id),
                    (None, Some(_)) => {
                        known.remove(&id);
                        batch.removed.push(id);
                    }
                    (None, None) => {}
                }
            }
            fetch_new(&api, new_ids, &mut known, &mut batch).await?;
            st.history = latest;
        }
    }

    // 2. A page per mailbox: the newest on the first pass, then older pages.
    let first = state.is_none();
    let mut st = match state {
        Some(s) => s,
        // Read the history id before listing, so nothing that changes meanwhile is missed.
        None => State { history: api.profile().await?["historyId"].as_str().unwrap_or_default().to_owned(), pages: HashMap::new() },
    };
    for store in [INBOX, SENT, ARCHIVE] {
        let page = st.pages.get(store).cloned();
        if page.as_deref() == Some("") {
            continue; // reached the oldest mail already
        }
        let limit = if first && store == INBOX { INITIAL_SYNC_LIMIT } else { BACKFILL_CHUNK };
        let (ids, next) = api.list(store, page.as_deref(), limit).await?;
        let fresh: Vec<String> = ids.into_iter().filter(|id| !known.contains_key(id)).collect();
        fetch_new(&api, fresh, &mut known, &mut batch).await?;
        st.pages.insert(store.to_owned(), next.unwrap_or_default());
    }
    batch.more_older = st.pages.values().any(|p| !p.is_empty());
    batch.state = serde_json::to_string(&st).expect("state serializes");
    Ok(batch)
}

/// Downloads new messages (several at once) and files each by its labels.
async fn fetch_new(api: &Api, ids: Vec<String>, known: &mut HashMap<String, String>, batch: &mut RemoteBatch) -> Result<()> {
    let got: Vec<Fetched> = futures::stream::iter(ids.into_iter().map(|id| async move { api.raw(&id).await.map(|r| (id, r)) }))
        .buffered(PARALLEL)
        .try_collect()
        .await?;
    for (id, r) in got {
        let Some((raw, labels)) = r else { continue };
        let Some(to) = classify(&labels) else { continue };
        if known.contains_key(&id) {
            continue;
        }
        known.insert(id.clone(), to.to_owned());
        batch.new_messages.push(RemoteMessage {
            remote_id: id,
            mailbox: to.to_owned(),
            seen: !labels.iter().any(|l| l == "UNREAD"),
            flagged: labels.iter().any(|l| l == "STARRED"),
            raw,
        });
    }
    Ok(())
}

/// Polls until the mailbox's history id moves past `current_state`'s, or `timeout`.
pub async fn wait_for_change(config: &AccountConfig, token: &str, current_state: Option<&str>, timeout: Duration) -> Result<Change> {
    let api = Api::new(config, token)?;
    let Some(since) = State::parse(current_state).map(|s| s.history) else { return Ok(Change::Changed) };
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let now = api.profile().await?["historyId"].as_str().unwrap_or_default().to_owned();
        if now != since {
            return Ok(Change::Changed);
        }
        if tokio::time::Instant::now() + POLL > deadline {
            return Ok(Change::Quiet);
        }
        tokio::time::sleep(POLL).await;
    }
}

/// Sends through Gmail, which files the Sent copy itself. Returns the raw
/// message for the local copy, like the other adapters.
pub async fn send(config: &AccountConfig, token: &str, draft: &Draft) -> Result<Vec<u8>> {
    let raw = build_message(config, draft)?.formatted();
    let api = Api::new(config, token)?;
    api.post("/messages/send", json!({ "raw": base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&raw) }))
        .await?
        .ok_or_else(|| Error::Network("Gmail couldn't send this message".into()))?;
    Ok(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_classify_into_one_mailbox() {
        assert_eq!(classify(&["INBOX", "UNREAD", "IMPORTANT"]), Some(INBOX));
        assert_eq!(classify(&["INBOX", "SENT"]), Some(INBOX), "a note to self stays in the inbox");
        assert_eq!(classify(&["SENT"]), Some(SENT));
        assert_eq!(classify(&["Label_7", "CATEGORY_UPDATES"]), Some(ARCHIVE));
        assert_eq!(classify::<&str>(&[]), Some(ARCHIVE), "All Mail");
        assert_eq!(classify(&["INBOX", "TRASH"]), None);
        assert_eq!(classify(&["SPAM"]), None);
        assert_eq!(classify(&["DRAFT"]), None);
    }

    #[test]
    fn ops_map_to_labels() {
        assert_eq!(label_change(OpKind::Seen(true)), ("UNREAD", false));
        assert_eq!(label_change(OpKind::Seen(false)), ("UNREAD", true));
        assert_eq!(label_change(OpKind::Flagged(true)), ("STARRED", true));
        assert_eq!(label_change(OpKind::Archive), ("INBOX", false));
        assert_eq!(label_change(OpKind::Unarchive), ("INBOX", true));
    }

    #[test]
    fn state_round_trips_and_tolerates_garbage() {
        let st = State { history: "42".into(), pages: HashMap::from([("INBOX".into(), "tok".into())]) };
        let s = serde_json::to_string(&st).unwrap();
        assert_eq!(State::parse(Some(&s)), Some(st));
        assert_eq!(State::parse(Some("jmap-state-123")), None, "another adapter's state starts over");
        assert_eq!(pad("YQ"), "YQ==");
    }
}
