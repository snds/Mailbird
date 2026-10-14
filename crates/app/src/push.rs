//! New mail on phones (ADR-0015). Two ways, the person picks:
//!
//! - **Periodic** (default, no server): the phone checks when iOS or Android
//!   lets it run in the background ([`crate::workers::background_pass`]).
//! - **Relay**: a push relay you run yourself (`tools/push-relay`) watches
//!   the mailboxes and wakes this device with a content-free push. This
//!   module registers the device, tells the relay what to watch, and keeps
//!   Outlook's Graph subscriptions alive.
//!
//! Where pushes arrive is the platform's business: the iOS and Android
//! layers report their APNs or FCM token with `set_push_target`; anywhere,
//! a UnifiedPush endpoint (an ntfy topic, say) can be entered instead.

use pim_core::net::{
    self,
    push_relay::{PushTarget, RelayClient, WatchStatus, account_key},
};
use serde::{Deserialize, Serialize};

use crate::commands::{Res, with_store};
use crate::{Shared, secrets, workers};

const MODE: &str = "push_mode";
const RELAY: &str = "push_relay";
/// The platform's own push target (APNs or FCM token), set by the mobile layer.
const PLATFORM_TARGET: &str = "push_platform_target";
/// Keychain entry for the relay token.
const TOKEN_KEY: &str = "push-relay-token";
/// Renew an Outlook subscription when less than this is left.
const RENEW_BEFORE: i64 = 36 * 3600;

fn sub_key(account_id: &str) -> String {
    format!("graph_sub:{account_id}")
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RelaySetting {
    url: String,
    device_id: String,
    target: PushTarget,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PushMode {
    Periodic,
    Relay,
}

/// How one account's new mail reaches this device.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushAccount {
    account_id: String,
    address: String,
    /// "relay" or "periodic".
    via: &'static str,
    /// Why an account stays periodic, in plain words.
    note: Option<String>,
    status: Option<WatchStatus>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushSettings {
    mode: PushMode,
    relay_url: Option<String>,
    /// "apns", "fcm", or "unifiedpush", once registered.
    target: Option<&'static str>,
    unified_push_endpoint: Option<String>,
    /// The platform reported its own push token (a phone build).
    platform_push: bool,
    accounts: Vec<PushAccount>,
    /// Why the relay couldn't be reached just now.
    error: Option<String>,
}

fn setting<T: for<'de> Deserialize<'de>>(state: &Shared, key: &str) -> Option<T> {
    with_store(state, |s| s.setting(key)).ok().flatten().and_then(|j| serde_json::from_str(&j).ok())
}

fn set<T: Serialize>(state: &Shared, key: &str, value: Option<&T>) -> Res<()> {
    let json = value.map(|v| serde_json::to_string(v).expect("setting serializes"));
    with_store(state, |s| s.set_setting(key, json.as_deref()))
}

pub fn mode(state: &Shared) -> PushMode {
    setting(state, MODE).unwrap_or(PushMode::Periodic)
}

fn client(state: &Shared) -> Option<(RelayClient, RelaySetting)> {
    let r: RelaySetting = setting(state, RELAY)?;
    let token = secrets::get(TOKEN_KEY).ok()?;
    RelayClient::new(&r.url, &token).ok().map(|c| (c, r))
}

/// Why an account can't be watched by the relay, if it can't.
fn periodic_only(account: &pim_core::Account) -> Option<String> {
    match account.config.oauth.as_ref().map(|o| o.issuer) {
        Some(pim_core::OAuthIssuer::Google) => Some("Gmail's push needs a Google Cloud Pub/Sub topic, so Gmail checks on the phone's schedule.".into()),
        _ => None,
    }
}

pub async fn get_push_settings(state: &Shared) -> Res<PushSettings> {
    settings(state).await
}

async fn settings(state: &Shared) -> Res<PushSettings> {
    let mode = mode(state);
    let relay: Option<RelaySetting> = setting(state, RELAY);
    let accounts = with_store(state, |s| s.accounts())?;
    let (statuses, error) = match (mode, client(state)) {
        (PushMode::Relay, Some((c, r))) => match c.status(&r.device_id).await {
            Ok(Some(s)) => (s, None),
            Ok(None) => (Default::default(), Some("the relay doesn't know this device any more — save the relay settings again".to_string())),
            Err(e) => (Default::default(), Some(e.to_string())),
        },
        _ => (Default::default(), None),
    };
    Ok(PushSettings {
        mode,
        relay_url: relay.as_ref().map(|r| r.url.clone()),
        target: relay.as_ref().map(|r| match r.target {
            PushTarget::Apns { .. } => "apns",
            PushTarget::Fcm { .. } => "fcm",
            PushTarget::UnifiedPush { .. } => "unifiedpush",
        }),
        unified_push_endpoint: relay.as_ref().and_then(|r| match &r.target {
            PushTarget::UnifiedPush { endpoint } => Some(endpoint.clone()),
            _ => None,
        }),
        platform_push: setting::<PushTarget>(state, PLATFORM_TARGET).is_some(),
        accounts: accounts
            .into_iter()
            .map(|a| {
                let note = periodic_only(&a);
                let relayed = mode == PushMode::Relay && note.is_none();
                PushAccount {
                    status: statuses.get(&account_key(&a.id)).cloned(),
                    via: if relayed { "relay" } else { "periodic" },
                    note,
                    account_id: a.id,
                    address: a.config.address,
                }
            })
            .collect(),
        error,
    })
}

/// The iOS or Android layer reports where this device receives pushes.
pub async fn set_push_target(state: &Shared, target: PushTarget) -> Res<()> {
    set(state, PLATFORM_TARGET, Some(&target))?;
    // A new token (they rotate) has to reach the relay.
    if mode(state) == PushMode::Relay
        && let Some((c, mut r)) = client(state)
        && !matches!(r.target, PushTarget::UnifiedPush { .. })
    {
        c.register(&r.device_id, &target).await.map_err(|e| e.to_string())?;
        r.target = target;
        set(state, RELAY, Some(&r))?;
    }
    Ok(())
}

/// Switches between periodic checks and the relay. For the relay: its
/// address and token (the token can be left out to keep the saved one),
/// and a UnifiedPush endpoint when the platform has no push service of its own.
pub async fn set_push_settings(state: &Shared, mode: PushMode, relay_url: Option<String>, relay_token: Option<String>, unified_push_endpoint: Option<String>) -> Res<PushSettings> {
    match mode {
        PushMode::Periodic => {
            stop_relay(state).await;
            set(state, MODE, Some(&PushMode::Periodic))?;
        }
        PushMode::Relay => {
            let url = relay_url.map(|u| u.trim().to_owned()).filter(|u| !u.is_empty()).ok_or("enter the relay's address")?;
            let token = match relay_token.map(|t| t.trim().to_owned()).filter(|t| !t.is_empty()) {
                Some(t) => t,
                None => secrets::get(TOKEN_KEY).map_err(|_| "enter the relay token".to_string())?,
            };
            let c = RelayClient::new(&url, &token).map_err(|e| e.to_string())?;
            let info = c.info().await.map_err(|e| e.to_string())?;
            let target = match unified_push_endpoint.map(|e| e.trim().to_owned()).filter(|e| !e.is_empty()) {
                Some(endpoint) => PushTarget::UnifiedPush { endpoint },
                None => setting(state, PLATFORM_TARGET).ok_or("this device has no push service yet: enter a UnifiedPush address (an ntfy topic, for example)")?,
            };
            let supported = match target {
                PushTarget::Apns { .. } => info.targets.apns,
                PushTarget::Fcm { .. } => info.targets.fcm,
                PushTarget::UnifiedPush { .. } => info.targets.unifiedpush,
            };
            if !supported {
                return Err("this relay isn't set up for this phone's push service (see the relay's README)".into());
            }
            let old: Option<RelaySetting> = setting(state, RELAY);
            let device_id = old.as_ref().filter(|o| o.url == url).map(|o| o.device_id.clone()).unwrap_or_else(|| format!("dev-{}", uuid::Uuid::new_v4()));
            c.register(&device_id, &target).await.map_err(|e| e.to_string())?;
            secrets::set(TOKEN_KEY, &token)?;
            set(state, RELAY, Some(&RelaySetting { url, device_id, target }))?;
            set(state, MODE, Some(&PushMode::Relay))?;
            sync_watches(state).await?;
        }
    }
    settings(state).await
}

pub async fn send_test_push(state: &Shared) -> Res<()> {
    let (c, r) = client(state).ok_or("set up the relay first")?;
    c.test(&r.device_id).await.map_err(|e| e.to_string())
}

/// Tells the relay to forget this device, and Outlook to stop calling it.
async fn stop_relay(state: &Shared) {
    if let Some((c, r)) = client(state) {
        let _ = c.forget(&r.device_id).await;
    }
    let accounts = with_store(state, |s| s.accounts()).unwrap_or_default();
    for a in accounts {
        if let Some(sub) = setting::<net::graph::Subscription>(state, &sub_key(&a.id)) {
            if let Ok(token) = workers::secret(state, &a).await {
                let _ = net::graph::unsubscribe(&a.config, &token, &sub.id).await;
            }
            let _ = set::<()>(state, &sub_key(&a.id), None);
        }
    }
}

/// Makes the relay watch exactly this device's accounts: IMAP and JMAP with
/// their app passwords, Outlook through a Graph subscription to the relay.
pub async fn sync_watches(state: &Shared) -> Res<()> {
    if mode(state) != PushMode::Relay {
        return Ok(());
    }
    let (c, r) = client(state).ok_or("the relay settings are incomplete")?;
    let accounts = with_store(state, |s| s.accounts())?;
    let mut problems = Vec::new();
    for a in &accounts {
        let key = account_key(&a.id);
        let result = match a.config.oauth.as_ref().map(|o| o.issuer) {
            Some(pim_core::OAuthIssuer::Google) => Ok(()),
            Some(pim_core::OAuthIssuer::Microsoft) => subscribe_outlook(state, &c, &r, a, &key).await,
            None => match secrets::get(&a.id) {
                Ok(secret) => c.watch(&r.device_id, &key, &a.config, &secret).await.map_err(|e| e.to_string()),
                Err(e) => Err(e),
            },
        };
        if let Err(e) = result {
            problems.push(format!("{}: {e}", a.config.address));
        }
    }
    // Stop watching accounts this device no longer has.
    if let Ok(Some(watched)) = c.status(&r.device_id).await {
        let keep: Vec<String> = accounts.iter().map(|a| account_key(&a.id)).collect();
        for key in watched.keys().filter(|k| !keep.contains(k)) {
            let _ = c.unwatch(&r.device_id, key).await;
        }
    }
    if problems.is_empty() { Ok(()) } else { Err(problems.join("; ")) }
}

async fn subscribe_outlook(state: &Shared, c: &RelayClient, r: &RelaySetting, account: &pim_core::Account, key: &str) -> Res<()> {
    let (url, client_state) = c.watch_outlook(&r.device_id, key).await.map_err(|e| e.to_string())?;
    let token = workers::secret(state, account).await?;
    let existing: Option<net::graph::Subscription> = setting(state, &sub_key(&account.id));
    let sub = match existing {
        Some(s) if s.expires_at - pim_core::now() > RENEW_BEFORE => s,
        Some(s) => match net::graph::renew(&account.config, &token, &s.id).await.map_err(|e| e.to_string())? {
            Some(renewed) => renewed,
            None => net::graph::subscribe(&account.config, &token, &url, &client_state).await.map_err(|e| e.to_string())?,
        },
        None => net::graph::subscribe(&account.config, &token, &url, &client_state).await.map_err(|e| e.to_string())?,
    };
    set(state, &sub_key(&account.id), Some(&sub))
}

/// Keeps Outlook subscriptions alive (the relay can't: it holds no Microsoft
/// sign-in). Runs every few hours on desktop and in each background pass on phones.
pub async fn renew_outlook(state: &Shared) {
    if mode(state) != PushMode::Relay {
        return;
    }
    let Some((c, r)) = client(state) else { return };
    let accounts = with_store(state, |s| s.accounts()).unwrap_or_default();
    for a in accounts.iter().filter(|a| a.config.oauth.as_ref().is_some_and(|o| o.issuer == pim_core::OAuthIssuer::Microsoft)) {
        if let Err(e) = subscribe_outlook(state, &c, &r, a, &account_key(&a.id)).await {
            log::info!("couldn't renew the Outlook subscription for {}: {e}", a.config.address);
        }
    }
}

/// Before an account is removed: stop its Outlook subscription while its
/// sign-in still works. The relay forgets the watch on the next sync.
pub async fn account_removing(state: &Shared, account: &pim_core::Account) {
    if let Some(sub) = setting::<net::graph::Subscription>(state, &sub_key(&account.id)) {
        if let Ok(token) = workers::secret(state, account).await {
            let _ = net::graph::unsubscribe(&account.config, &token, &sub.id).await;
        }
        let _ = set::<()>(state, &sub_key(&account.id), None);
    }
}

/// After an account is added or removed: update the relay off the caller's path.
pub fn accounts_changed(state: &Shared) {
    if mode(state) != PushMode::Relay {
        return;
    }
    let state = state.clone();
    tokio::spawn(async move {
        if let Err(e) = sync_watches(&state).await {
            log::info!("couldn't update the push relay: {e}");
        }
    });
}
