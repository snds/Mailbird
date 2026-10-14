//! Microsoft Graph (v1.0) mail: Outlook.com and Microsoft 365, signed in with OAuth.
//!
//! Each store mailbox is one well-known Outlook folder:
//!
//! | Store mailbox | Outlook folder |
//! |---|---|
//! | Inbox | `inbox` |
//! | Sent | `sentitems` |
//! | Archive | `archive` (skipped if the account has none) |
//!
//! Sync returns the same [`RemoteBatch`] as JMAP and Gmail. Each folder has
//! its own delta query (`messages/delta`): the first round lists the folder
//! newest first, a page at a time (that's the backfill); after that, the
//! delta link returns only what changed. A message that leaves a folder comes
//! back as `@removed`; if it shows up in another tracked folder in the same
//! pass it's a move, otherwise it's gone.
//!
//! Every request asks for immutable ids (`Prefer: IdType="ImmutableId"`), so
//! a message keeps its id when it moves between folders.
//!
//! Graph push (change notifications) needs a public webhook, which a
//! local-first app doesn't have. [`wait_for_change`] polls the inbox's counts
//! instead, and the regular sync catches everything else.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::time::Duration;

use base64::Engine;
use futures::{StreamExt, TryStreamExt};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    AccountConfig, Draft, Error, OpKind, RemoteBatch, RemoteCursor, RemoteMessage, RemoteOp, Result,
    store::{ARCHIVE, INBOX, SENT},
};

use super::{BACKFILL_CHUNK, Change, INITIAL_SYNC_LIMIT, TIMEOUT, build_message, tls_config};

pub const API: &str = "https://graph.microsoft.com/v1.0/me";
/// How often [`wait_for_change`] looks at the inbox.
pub const POLL: Duration = Duration::from_secs(30);
/// Messages fetched at once.
const PARALLEL: usize = 8;
/// Newest inbox messages checked on each pass while the inbox's first round
/// is still paging, so new mail shows up before the backfill finishes.
const PEEK: usize = 25;
/// Every request: ids that survive moves, and 100 items per page.
const PREFER: &str = "IdType=\"ImmutableId\", odata.maxpagesize=100";

/// The Outlook folder behind each store mailbox.
pub fn folder(store: &str) -> &'static str {
    match store {
        INBOX => "inbox",
        SENT => "sentitems",
        _ => "archive",
    }
}

/// The Graph change for a local op: a `PATCH` body, or a folder to move to.
pub fn op_change(kind: OpKind) -> std::result::Result<Value, &'static str> {
    match kind {
        OpKind::Seen(on) => Ok(json!({ "isRead": on })),
        OpKind::Flagged(on) => Ok(json!({ "flag": { "flagStatus": if on { "flagged" } else { "notFlagged" } } })),
        OpKind::Archive => Err("archive"),
        OpKind::Unarchive => Err("inbox"),
    }
}

/// Where one folder's delta query stands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "at", content = "link", rename_all = "lowercase")]
pub enum Link {
    /// Still on the first round: the next page of older mail.
    Next(String),
    /// Caught up: this link returns only what changed.
    Delta(String),
    /// The account has no such folder (some have no Archive).
    Missing,
}

/// What [`RemoteCursor::state`] holds for Graph: each store mailbox's link.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct State {
    pub folders: BTreeMap<String, Link>,
}

impl State {
    pub fn parse(s: Option<&str>) -> Option<Self> {
        s.and_then(|s| serde_json::from_str(s).ok())
    }
}

fn http_err(e: reqwest::Error) -> Error {
    if e.is_timeout() { Error::Network("Microsoft took too long to answer".into()) } else { Error::Network(e.to_string()) }
}

/// A Graph client for one signed-in account.
pub(crate) struct Api {
    http: reqwest::Client,
    base: String,
    token: String,
    prefer: String,
}

/// A failed request, kept apart from transport errors so callers can treat
/// "gone" (404) and "expired" (410) as data.
pub(crate) enum Reply {
    Ok(Value),
    Gone,
}

impl Api {
    pub(crate) fn new(config: &AccountConfig, token: &str) -> Result<Self> {
        let base = config.oauth.as_ref().and_then(|o| o.api_base.clone()).unwrap_or_else(|| API.to_owned());
        let http = reqwest::Client::builder().tls_backend_preconfigured(tls_config()).timeout(TIMEOUT).build().map_err(http_err)?;
        Ok(Self { http, base: base.trim_end_matches('/').to_owned(), token: token.to_owned(), prefer: PREFER.to_owned() })
    }

    /// Adds `Prefer` options (time zone, body format) to every request.
    pub(crate) fn with_prefer(mut self, extra: &str) -> Self {
        self.prefer = format!("{PREFER}, {extra}");
        self
    }

    /// Paths are relative to `/me`; next and delta links are absolute.
    pub(crate) fn url(&self, path: &str) -> String {
        if path.starts_with("http://") || path.starts_with("https://") { path.to_owned() } else { format!("{}{path}", self.base) }
    }

    async fn raw_send(&self, req: reqwest::RequestBuilder) -> Result<(StatusCode, reqwest::header::HeaderMap, Vec<u8>)> {
        let res = req.bearer_auth(&self.token).header("Prefer", &self.prefer).send().await.map_err(http_err)?;
        let status = res.status();
        let headers = res.headers().clone();
        let body = res.bytes().await.map_err(http_err)?.to_vec();
        Ok((status, headers, body))
    }

    /// Sends a request. 404 and 410 come back as [`Reply::Gone`]; 412 as
    /// [`Error::Invalid`] with "changed", which callers turn into conflicts.
    pub(crate) async fn send(&self, req: reqwest::RequestBuilder) -> Result<Reply> {
        let (status, _, body) = self.raw_send(req).await?;
        if status == StatusCode::NOT_FOUND || status == StatusCode::GONE {
            return Ok(Reply::Gone);
        }
        if !status.is_success() {
            return Err(failure(status, &body));
        }
        Ok(Reply::Ok(if body.is_empty() { Value::Null } else { serde_json::from_slice(&body).map_err(|_| Error::Network("Microsoft sent an unreadable reply".into()))? }))
    }

    pub(crate) async fn get(&self, path: &str) -> Result<Reply> {
        self.send(self.http.get(self.url(path))).await
    }

    pub(crate) async fn post(&self, path: &str, body: Value) -> Result<Reply> {
        self.send(self.http.post(self.url(path)).json(&body)).await
    }

    pub(crate) async fn patch(&self, path: &str, body: Value, if_match: Option<&str>) -> Result<Reply> {
        let mut req = self.http.patch(self.url(path)).json(&body);
        if let Some(e) = if_match {
            req = req.header("If-Match", e);
        }
        self.send(req).await
    }

    pub(crate) async fn delete(&self, path: &str, if_match: Option<&str>) -> Result<Reply> {
        let mut req = self.http.delete(self.url(path));
        if let Some(e) = if_match {
            req = req.header("If-Match", e);
        }
        self.send(req).await
    }

    /// Every page of a collection, following `@odata.nextLink`.
    pub(crate) async fn all(&self, path: &str) -> Result<Vec<Value>> {
        let mut out = Vec::new();
        let mut next = Some(path.to_owned());
        while let Some(url) = next.take() {
            let Reply::Ok(v) = self.get(&url).await? else {
                break;
            };
            out.extend(v["value"].as_array().cloned().unwrap_or_default());
            next = v["@odata.nextLink"].as_str().map(str::to_owned);
        }
        Ok(out)
    }

    /// A message's RFC 5322 bytes, or `None` once it's gone.
    async fn mime(&self, id: &str) -> Result<Option<Vec<u8>>> {
        let (status, _, body) = self.raw_send(self.http.get(self.url(&format!("/messages/{id}/$value")))).await?;
        match status {
            StatusCode::NOT_FOUND | StatusCode::GONE => Ok(None),
            s if s.is_success() => Ok(Some(body)),
            s => Err(failure(s, &body)),
        }
    }
}

/// What a 412 becomes: the item changed on the server since we read it.
pub(crate) const CHANGED: &str = "changed on the server";

/// A person-readable error for a failed Graph request.
fn failure(status: StatusCode, body: &[u8]) -> Error {
    let v: Value = serde_json::from_slice(body).unwrap_or_default();
    let msg = v["error"]["message"].as_str().unwrap_or("request failed");
    match status {
        StatusCode::UNAUTHORIZED => Error::Auth("Microsoft needs you to sign in again".into()),
        StatusCode::FORBIDDEN => Error::Auth("this sign-in didn't grant access — sign in again and allow mail, calendars, and contacts".into()),
        StatusCode::PRECONDITION_FAILED => Error::Invalid(CHANGED.into()),
        StatusCode::BAD_REQUEST => Error::Invalid(format!("Microsoft didn't accept this: {msg}")),
        StatusCode::TOO_MANY_REQUESTS | StatusCode::SERVICE_UNAVAILABLE => Error::Network("Microsoft asked us to slow down — trying again shortly".into()),
        s => Error::Network(format!("Microsoft: {msg} ({s})")),
    }
}

/// Who signed in: their address and name, from `/me`.
pub async fn me(config: &AccountConfig, token: &str) -> Result<(String, Option<String>)> {
    let Reply::Ok(v) = Api::new(config, token)?.get("/?$select=mail,userPrincipalName,displayName").await? else {
        return Err(Error::Network("Microsoft has no profile for this account".into()));
    };
    let s = |k: &str| v[k].as_str().filter(|s| !s.is_empty()).map(str::to_owned);
    // Personal accounts often have no `mail`; their sign-in name is the address.
    let address = s("mail").or_else(|| s("userPrincipalName")).ok_or_else(|| Error::Network("Microsoft didn't say which address this is".into()))?;
    Ok((address, s("displayName")))
}

/// Checks the token reaches the mailbox and returns its address.
pub async fn verify(config: &AccountConfig, token: &str) -> Result<String> {
    let api = Api::new(config, token)?;
    if let Reply::Gone = api.get("/mailFolders/inbox?$select=id").await? {
        return Err(Error::Network("this Microsoft account has no Outlook mailbox".into()));
    }
    Ok(me(config, token).await?.0)
}

/// Pushes local changes, a few at a time. A message deleted meanwhile is skipped.
async fn push(api: &Api, ops: &[RemoteOp]) -> Result<Vec<i64>> {
    let each: Vec<_> = ops.iter().map(|op| push_one(api, op)).collect();
    futures::stream::iter(each).buffer_unordered(4).try_collect().await
}

async fn push_one(api: &Api, op: &RemoteOp) -> Result<i64> {
    let path = format!("/messages/{}", op.remote_id);
    match op_change(op.kind) {
        Ok(body) => api.patch(&path, body, None).await?,
        Err(to) => api.post(&format!("{path}/move"), json!({ "destinationId": to })).await?,
    };
    Ok(op.id)
}

/// A message's flags from a delta or list entry: (seen, flagged).
fn flags(m: &Value) -> (bool, bool) {
    (m["isRead"].as_bool().unwrap_or(false), m["flag"]["flagStatus"] == "flagged")
}

fn first_round(store: &str) -> String {
    format!("/mailFolders/{}/messages/delta?$select=isRead,flag&$orderby=receivedDateTime+desc", folder(store))
}

/// One sync pass: push local changes, then each folder's delta.
pub async fn sync_account(config: &AccountConfig, token: &str, cursor: RemoteCursor, ops: &[RemoteOp]) -> Result<RemoteBatch> {
    let api = Api::new(config, token)?;
    let applied_ops = if ops.is_empty() { Vec::new() } else { push(&api, ops).await? };
    let mut batch = RemoteBatch { applied_ops, ..Default::default() };
    let mut known = cursor.known;
    let first = cursor.state.is_none();
    let mut st = State::parse(cursor.state.as_deref()).unwrap_or_default();

    // What each folder says now: id → (store, seen, flagged), and ids that left it.
    let inbox_paging = matches!(st.folders.get(INBOX), Some(Link::Next(_)));
    let mut present: HashMap<String, (&'static str, bool, bool)> = HashMap::new();
    let mut left: Vec<(String, &'static str)> = Vec::new();
    for store in [INBOX, SENT, ARCHIVE] {
        let (mut url, budget) = match st.folders.get(store) {
            Some(Link::Missing) => continue,
            Some(Link::Delta(l)) => (l.clone(), usize::MAX),
            Some(Link::Next(l)) => (l.clone(), BACKFILL_CHUNK),
            None => (first_round(store), if first && store == INBOX { INITIAL_SYNC_LIMIT } else { BACKFILL_CHUNK }),
        };
        let mut seen = 0;
        loop {
            let v = match api.get(&url).await? {
                Reply::Ok(v) => v,
                // No such folder, or (410) the delta link expired: start this folder over.
                Reply::Gone if !st.folders.contains_key(store) => {
                    st.folders.insert(store.to_owned(), Link::Missing);
                    break;
                }
                Reply::Gone => {
                    st.folders.remove(store);
                    url = first_round(store);
                    continue;
                }
            };
            for m in v["value"].as_array().into_iter().flatten() {
                let Some(id) = m["id"].as_str() else { continue };
                if m.get("@removed").is_some() {
                    left.push((id.to_owned(), store));
                } else {
                    let (s, f) = flags(m);
                    present.insert(id.to_owned(), (store, s, f));
                    seen += 1;
                }
            }
            if let Some(d) = v["@odata.deltaLink"].as_str() {
                st.folders.insert(store.to_owned(), Link::Delta(d.to_owned()));
                break;
            }
            let Some(n) = v["@odata.nextLink"].as_str() else {
                break;
            };
            if seen >= budget {
                st.folders.insert(store.to_owned(), Link::Next(n.to_owned()));
                break;
            }
            url = n.to_owned();
        }
    }

    // While the inbox's first round pages through older mail, its newest
    // messages would wait for the round to end. Check them directly.
    // (Also on the pass that finishes the round: mail that arrived during it
    // only comes with the next delta.)
    if (inbox_paging || matches!(st.folders.get(INBOX), Some(Link::Next(_))))
        && let Reply::Ok(v) = api.get(&format!("/mailFolders/inbox/messages?$top={PEEK}&$select=isRead,flag&$orderby=receivedDateTime+desc")).await?
    {
        for m in v["value"].as_array().into_iter().flatten() {
            if let Some(id) = m["id"].as_str() {
                let (s, f) = flags(m);
                present.entry(id.to_owned()).or_insert((INBOX, s, f));
            }
        }
    }

    let mut new_ids = Vec::new();
    for (id, (store, seen, flagged)) in &present {
        match known.get(id) {
            Some(at) if at == store => batch.flags.push((id.clone(), *seen, *flagged)),
            Some(_) => {
                batch.moved.push((id.clone(), (*store).to_owned()));
                batch.flags.push((id.clone(), *seen, *flagged));
                known.insert(id.clone(), (*store).to_owned());
            }
            None => new_ids.push(id.clone()),
        }
    }
    let mut gone = HashSet::new();
    for (id, from) in left {
        // It left this folder and didn't arrive in another tracked one.
        if !present.contains_key(&id) && known.get(&id).map(String::as_str) == Some(from) && gone.insert(id.clone()) {
            known.remove(&id);
            batch.removed.push(id);
        }
    }

    let got: Vec<(String, Option<Vec<u8>>)> = futures::stream::iter(new_ids.into_iter().map(|id| {
        let api = &api;
        async move { api.mime(&id).await.map(|r| (id, r)) }
    }))
    .buffered(PARALLEL)
    .try_collect()
    .await?;
    for (id, raw) in got {
        let Some(raw) = raw else { continue };
        let (store, seen, flagged) = present[&id];
        known.insert(id.clone(), store.to_owned());
        batch.new_messages.push(RemoteMessage { remote_id: id, mailbox: store.to_owned(), seen, flagged, raw });
    }

    batch.more_older = st.folders.values().any(|l| matches!(l, Link::Next(_)));
    batch.state = serde_json::to_string(&st).expect("state serializes");
    Ok(batch)
}

/// Polls the inbox's counts until they move, or `timeout`. Flag changes on
/// other folders wait for the regular sync.
pub async fn wait_for_change(config: &AccountConfig, token: &str, current_state: Option<&str>, timeout: Duration) -> Result<Change> {
    if current_state.and_then(|s| State::parse(Some(s))).is_none() {
        return Ok(Change::Changed);
    }
    let api = Api::new(config, token)?;
    let before = inbox_counts(&api).await?;
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if tokio::time::Instant::now() + POLL > deadline {
            return Ok(Change::Quiet);
        }
        tokio::time::sleep(POLL).await;
        if inbox_counts(&api).await? != before {
            return Ok(Change::Changed);
        }
    }
}

async fn inbox_counts(api: &Api) -> Result<(Option<i64>, Option<i64>)> {
    Ok(match api.get("/mailFolders/inbox?$select=totalItemCount,unreadItemCount").await? {
        Reply::Ok(v) => (v["totalItemCount"].as_i64(), v["unreadItemCount"].as_i64()),
        Reply::Gone => (None, None),
    })
}

/// Sends the MIME message through Outlook, which files the Sent copy itself.
pub async fn send(config: &AccountConfig, token: &str, draft: &Draft) -> Result<Vec<u8>> {
    let raw = build_message(config, draft)?.formatted();
    let api = Api::new(config, token)?;
    let body = base64::engine::general_purpose::STANDARD.encode(&raw);
    let req = api.http.post(api.url("/sendMail")).header("Content-Type", "text/plain").body(body);
    match api.send(req).await? {
        Reply::Ok(_) => Ok(raw),
        Reply::Gone => Err(Error::Network("Outlook couldn't send this message".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stores_map_to_well_known_folders() {
        assert_eq!(folder(INBOX), "inbox");
        assert_eq!(folder(SENT), "sentitems");
        assert_eq!(folder(ARCHIVE), "archive");
        assert!(first_round(SENT).starts_with("/mailFolders/sentitems/messages/delta?"));
    }

    #[test]
    fn ops_map_to_patches_and_moves() {
        assert_eq!(op_change(OpKind::Seen(true)), Ok(json!({ "isRead": true })));
        assert_eq!(op_change(OpKind::Flagged(false)), Ok(json!({ "flag": { "flagStatus": "notFlagged" } })));
        assert_eq!(op_change(OpKind::Archive), Err("archive"));
        assert_eq!(op_change(OpKind::Unarchive), Err("inbox"));
        assert_eq!(flags(&json!({ "isRead": true, "flag": { "flagStatus": "flagged" } })), (true, true));
        assert_eq!(flags(&json!({})), (false, false));
    }

    #[test]
    fn state_round_trips_and_tolerates_garbage() {
        let st = State {
            folders: BTreeMap::from([
                (INBOX.into(), Link::Delta("https://g/delta?$deltatoken=1".into())),
                (SENT.into(), Link::Next("https://g/delta?$skiptoken=2".into())),
                (ARCHIVE.into(), Link::Missing),
            ]),
        };
        let s = serde_json::to_string(&st).unwrap();
        assert_eq!(State::parse(Some(&s)), Some(st));
        assert_eq!(State::parse(Some("{\"history\":\"42\"}")), None, "another adapter's state starts over");
        assert_eq!(State::parse(Some("jmap-state-123")), None);
    }
}
