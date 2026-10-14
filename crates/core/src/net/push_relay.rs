//! The app's side of the self-hosted push relay (ADR-0015): register this
//! device, tell the relay which mailboxes to watch, read their status.
//! The relay itself lives in `tools/push-relay`.

use std::collections::BTreeMap;

use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{AccountConfig, Error, Result};

use super::{TIMEOUT, tls_config};

/// Where this device receives pushes (the same JSON the relay stores).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "platform", rename_all = "lowercase")]
pub enum PushTarget {
    Apns {
        token: String,
        #[serde(default)]
        sandbox: bool,
    },
    Fcm {
        token: String,
    },
    /// A UnifiedPush endpoint (an ntfy topic, for example).
    UnifiedPush {
        endpoint: String,
    },
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayTargets {
    pub apns: bool,
    pub fcm: bool,
    pub unifiedpush: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayInfo {
    pub version: String,
    pub targets: RelayTargets,
    /// The relay has a public https address, so Outlook can reach it.
    pub outlook: bool,
}

/// What the relay reports for one watched mailbox.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchStatus {
    /// "imap", "jmap", or "graph" (sent beside the status, not in it).
    #[serde(default)]
    pub kind: String,
    pub last_change: Option<i64>,
    pub last_push: Option<i64>,
    pub error: Option<String>,
}

pub struct RelayClient {
    http: reqwest::Client,
    base: String,
    token: String,
}

fn http_err(e: reqwest::Error) -> Error {
    if e.is_timeout() { Error::Network("the push relay took too long to answer".into()) } else { Error::Network(format!("couldn't reach the push relay: {e}")) }
}

/// The relay's error text, or a plain fallback.
async fn failure(res: reqwest::Response) -> Error {
    let status = res.status();
    let msg = res.json::<Value>().await.ok().and_then(|v| v["error"].as_str().map(str::to_owned)).unwrap_or_else(|| format!("the push relay answered {status}"));
    if status == StatusCode::UNAUTHORIZED { Error::Auth("the push relay didn't accept this token".into()) } else { Error::Network(msg) }
}

impl RelayClient {
    /// `url` must be https (or http to this machine, for testing).
    pub fn new(url: &str, token: &str) -> Result<Self> {
        let u = reqwest::Url::parse(url.trim()).map_err(|_| Error::Invalid(format!("“{url}” isn't a web address")))?;
        let local = u.host_str().is_some_and(|h| matches!(h, "localhost" | "127.0.0.1" | "[::1]"));
        if u.scheme() != "https" && !(u.scheme() == "http" && local) {
            return Err(Error::Invalid("the push relay needs an https:// address".into()));
        }
        if token.trim().len() < 16 {
            return Err(Error::Invalid("the relay token is at least 16 characters".into()));
        }
        let http = reqwest::Client::builder().tls_backend_preconfigured(tls_config()).timeout(TIMEOUT).build().map_err(http_err)?;
        Ok(Self { http, base: url.trim().trim_end_matches('/').to_owned(), token: token.trim().to_owned() })
    }

    fn req(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        self.http.request(method, format!("{}{path}", self.base)).bearer_auth(&self.token)
    }

    async fn ok(&self, req: reqwest::RequestBuilder) -> Result<reqwest::Response> {
        let res = req.send().await.map_err(http_err)?;
        if res.status().is_success() { Ok(res) } else { Err(failure(res).await) }
    }

    /// Checks the address and token, and what the relay can push to.
    pub async fn info(&self) -> Result<RelayInfo> {
        self.ok(self.req(reqwest::Method::GET, "/v1/info")).await?.json().await.map_err(|_| Error::Network("that address doesn't look like a Mailbird push relay".into()))
    }

    /// Registers (or updates) this device's push target.
    pub async fn register(&self, device: &str, target: &PushTarget) -> Result<()> {
        self.ok(self.req(reqwest::Method::PUT, &format!("/v1/devices/{device}")).json(target)).await.map(|_| ())
    }

    /// Forgets this device and stops watching its mailboxes.
    pub async fn forget(&self, device: &str) -> Result<()> {
        self.ok(self.req(reqwest::Method::DELETE, &format!("/v1/devices/{device}"))).await.map(|_| ())
    }

    /// Watches an IMAP (IDLE) or JMAP (EventSource) mailbox. The relay keeps
    /// `secret` sealed and never sends it back.
    pub async fn watch(&self, device: &str, key: &str, config: &AccountConfig, secret: &str) -> Result<()> {
        let kind = if config.jmap.is_some() { "jmap" } else { "imap" };
        self.ok(self.req(reqwest::Method::PUT, &format!("/v1/devices/{device}/watches/{key}")).json(&json!({ "kind": kind, "config": config, "secret": secret })))
            .await
            .map(|_| ())
    }

    /// An Outlook watch: returns the (notification URL, client state) to
    /// subscribe Graph to. The same pair comes back on every call.
    pub async fn watch_outlook(&self, device: &str, key: &str) -> Result<(String, String)> {
        let v: Value = self.ok(self.req(reqwest::Method::PUT, &format!("/v1/devices/{device}/watches/{key}")).json(&json!({ "kind": "graph" }))).await?.json().await.map_err(http_err)?;
        match (v["notificationUrl"].as_str(), v["clientState"].as_str()) {
            (Some(u), Some(c)) => Ok((u.to_owned(), c.to_owned())),
            _ => Err(Error::Network("the push relay didn't return an Outlook address".into())),
        }
    }

    pub async fn unwatch(&self, device: &str, key: &str) -> Result<()> {
        self.ok(self.req(reqwest::Method::DELETE, &format!("/v1/devices/{device}/watches/{key}"))).await.map(|_| ())
    }

    /// Each watched mailbox's status, by key. `Ok(None)` if the relay doesn't know this device.
    pub async fn status(&self, device: &str) -> Result<Option<BTreeMap<String, WatchStatus>>> {
        let res = self.req(reqwest::Method::GET, &format!("/v1/devices/{device}")).send().await.map_err(http_err)?;
        if res.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !res.status().is_success() {
            return Err(failure(res).await);
        }
        let v: Value = res.json().await.map_err(http_err)?;
        let mut out = BTreeMap::new();
        for (k, w) in v["watches"].as_object().into_iter().flatten() {
            let mut s: WatchStatus = serde_json::from_value(w["status"].clone()).unwrap_or_default();
            s.kind = w["kind"].as_str().unwrap_or_default().to_owned();
            out.insert(k.clone(), s);
        }
        Ok(Some(out))
    }

    /// Asks the relay to push this device now.
    pub async fn test(&self, device: &str) -> Result<()> {
        self.ok(self.req(reqwest::Method::POST, &format!("/v1/devices/{device}/test"))).await.map(|_| ())
    }
}

/// The relay's name for an account: opaque, so it never learns the address.
pub fn account_key(account_id: &str) -> String {
    let clean: String = account_id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(56).collect();
    format!("acct-{clean}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_and_keys() {
        assert!(RelayClient::new("http://relay.example.com", "0123456789abcdef").is_err(), "https only");
        assert!(RelayClient::new("https://relay.example.com/", "short").is_err());
        assert!(RelayClient::new("http://127.0.0.1:8787", "0123456789abcdef").is_ok());
        assert_eq!(account_key("3f2a-11ee-9c1b"), "acct-3f2a-11ee-9c1b");
        assert_eq!(serde_json::to_value(PushTarget::UnifiedPush { endpoint: "https://ntfy.sh/t".into() }).unwrap(), json!({ "platform": "unifiedpush", "endpoint": "https://ntfy.sh/t" }));
    }
}
