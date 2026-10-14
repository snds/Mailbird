//! The relay's HTTP API. Devices manage themselves under `/v1` with the
//! relay token; Graph calls `/graph/{hook}` (no token, but every
//! notification must carry the watch's client state).

use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use pim_core::AccountConfig;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::crypto;
use crate::notify::Notifier;
use crate::store::{Device, Target, Watch, WatchKind, WatchStatus};
use crate::watch::Relay;

pub struct Api {
    pub relay: Arc<Relay>,
    /// The bearer token every device signs in with.
    pub token: String,
    /// Where Graph can reach this relay (https), for Outlook watches.
    pub public_url: Option<String>,
}

type Shared = Arc<Api>;

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(json!({ "error": msg.into() }))).into_response()
}

fn authorized(api: &Api, headers: &HeaderMap) -> bool {
    let given = headers.get("authorization").and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")).unwrap_or_default();
    crypto::same(given, &api.token)
}

fn unauthorized() -> Response {
    err(StatusCode::UNAUTHORIZED, "wrong relay token")
}

/// Device ids are the device's own random name: 8–64 URL-safe characters.
fn valid_id(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn router(api: Shared) -> Router {
    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/v1/info", get(info))
        .route("/v1/devices/{id}", put(put_device).get(get_device).delete(delete_device))
        .route("/v1/devices/{id}/watches/{account}", put(put_watch).delete(delete_watch))
        .route("/v1/devices/{id}/test", post(test_push))
        .route("/graph/{hook}", post(graph))
        .with_state(api)
}

async fn info(State(api): State<Shared>, headers: HeaderMap) -> Response {
    if !authorized(&api, &headers) {
        return unauthorized();
    }
    let n = &api.relay.notifier;
    Json(json!({
        "version": env!("CARGO_PKG_VERSION"),
        "targets": { "apns": n.apns.is_some(), "fcm": n.fcm.is_some(), "unifiedpush": true },
        "outlook": api.public_url.is_some(),
    }))
    .into_response()
}

async fn put_device(State(api): State<Shared>, headers: HeaderMap, Path(id): Path<String>, Json(target): Json<Target>) -> Response {
    if !authorized(&api, &headers) {
        return unauthorized();
    }
    if !valid_id(&id) {
        return err(StatusCode::BAD_REQUEST, "device ids are 8–64 letters, digits, - or _");
    }
    let n = &api.relay.notifier;
    let problem = match &target {
        Target::UnifiedPush { endpoint } => Notifier::check_endpoint(endpoint).err(),
        Target::Apns { token, .. } if token.is_empty() => Some("an APNs device token is needed".into()),
        Target::Apns { .. } if n.apns.is_none() => Some("this relay has no APNs key set up".into()),
        Target::Fcm { token } if token.is_empty() => Some("an FCM registration token is needed".into()),
        Target::Fcm { .. } if n.fcm.is_none() => Some("this relay has no FCM service account set up".into()),
        _ => None,
    };
    if let Some(p) = problem {
        return err(StatusCode::BAD_REQUEST, p);
    }
    api.relay.store.write(|d| {
        d.entry(id).and_modify(|dev| dev.target = target.clone()).or_insert(Device { target, watches: Default::default(), created_at: pim_core::now() });
    });
    StatusCode::NO_CONTENT.into_response()
}

async fn get_device(State(api): State<Shared>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    if !authorized(&api, &headers) {
        return unauthorized();
    }
    let Some(d) = api.relay.store.device(&id) else { return err(StatusCode::NOT_FOUND, "this relay doesn't know this device") };
    // Never echo secrets or configs back: kinds and statuses only.
    let watches: serde_json::Map<String, Value> = d.watches.iter().map(|(k, w)| (k.clone(), json!({ "kind": w.kind.name(), "status": w.status }))).collect();
    Json(json!({ "platform": d.target.platform(), "watches": watches })).into_response()
}

async fn delete_device(State(api): State<Shared>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    if !authorized(&api, &headers) {
        return unauthorized();
    }
    api.relay.store.write(|d| d.remove(&id));
    api.relay.reconcile();
    StatusCode::NO_CONTENT.into_response()
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum WatchRequest {
    Imap { config: Box<AccountConfig>, secret: String },
    Jmap { config: Box<AccountConfig>, secret: String },
    Graph,
}

async fn put_watch(State(api): State<Shared>, headers: HeaderMap, Path((id, account)): Path<(String, String)>, Json(req): Json<WatchRequest>) -> Response {
    if !authorized(&api, &headers) {
        return unauthorized();
    }
    if !valid_id(&account) {
        return err(StatusCode::BAD_REQUEST, "account keys are 8–64 letters, digits, - or _");
    }
    if api.relay.store.device(&id).is_none() {
        return err(StatusCode::NOT_FOUND, "register the device first");
    }
    let sealer = &api.relay.sealer;
    let existing = api.relay.store.device(&id).and_then(|d| d.watches.get(&account).cloned());
    let kind = match req {
        WatchRequest::Imap { config, secret } => {
            if config.jmap.is_some() || config.oauth.is_some() {
                return err(StatusCode::BAD_REQUEST, "this account isn't an IMAP account");
            }
            WatchKind::Imap { config: *config, secret: sealer.seal(&secret) }
        }
        WatchRequest::Jmap { config, secret } => {
            if config.jmap.is_none() {
                return err(StatusCode::BAD_REQUEST, "this account has no JMAP settings");
            }
            WatchKind::Jmap { config: *config, secret: sealer.seal(&secret) }
        }
        WatchRequest::Graph => {
            if api.public_url.is_none() {
                return err(StatusCode::BAD_REQUEST, "Outlook needs the relay's public https address (set RELAY_PUBLIC_URL)");
            }
            // Re-registering keeps the hook, so an existing subscription stays valid.
            match existing.map(|w| w.kind) {
                Some(k @ WatchKind::Graph { .. }) => k,
                _ => WatchKind::Graph { hook: crypto::random_token(24), client_state: crypto::random_token(24) },
            }
        }
    };
    let reply = match &kind {
        WatchKind::Graph { hook, client_state } => json!({
            "notificationUrl": format!("{}/graph/{hook}", api.public_url.as_deref().unwrap_or_default().trim_end_matches('/')),
            "clientState": client_state,
        }),
        _ => json!({}),
    };
    api.relay.store.write(|d| {
        if let Some(dev) = d.get_mut(&id) {
            dev.watches.insert(account.clone(), Watch { kind, status: WatchStatus::default() });
        }
    });
    api.relay.restart(&id, &account);
    Json(reply).into_response()
}

async fn delete_watch(State(api): State<Shared>, headers: HeaderMap, Path((id, account)): Path<(String, String)>) -> Response {
    if !authorized(&api, &headers) {
        return unauthorized();
    }
    api.relay.store.write(|d| d.get_mut(&id).map(|dev| dev.watches.remove(&account)));
    api.relay.reconcile();
    StatusCode::NO_CONTENT.into_response()
}

async fn test_push(State(api): State<Shared>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    if !authorized(&api, &headers) {
        return unauthorized();
    }
    match api.relay.push(&id, "test", "test").await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => err(StatusCode::BAD_GATEWAY, e),
    }
}

/// Graph's webhook. Subscribing sends `?validationToken=…`, which must be
/// echoed as plain text within 10 seconds; notifications must be answered
/// within 3 seconds, so pushes go out after the reply.
async fn graph(State(api): State<Shared>, Path(hook): Path<String>, Query(q): Query<std::collections::HashMap<String, String>>, body: String) -> Response {
    if let Some(token) = q.get("validationToken") {
        return (StatusCode::OK, [("content-type", "text/plain")], token.clone()).into_response();
    }
    let Some((device, account, client_state)) = api.relay.store.graph_hook(&hook) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let v: Value = serde_json::from_str(&body).unwrap_or_default();
    let genuine = v["value"].as_array().is_some_and(|n| !n.is_empty() && n.iter().all(|x| x["clientState"].as_str().is_some_and(|c| crypto::same(c, &client_state))));
    if !genuine {
        return StatusCode::ACCEPTED.into_response(); // ignored, and nothing told to a forger
    }
    api.relay.store.status(&device, &account, |s| s.last_change = Some(pim_core::now()));
    let relay = api.relay.clone();
    tokio::spawn(async move { relay.changed(&device, &account).await });
    StatusCode::ACCEPTED.into_response()
}
