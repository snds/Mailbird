//! Browser sign-in (OAuth) for Google, and the OAuth clients it uses.
//!
//! Each provider needs the app to be registered with it. Builds can bake in
//! a client (`MAILBIRD_GOOGLE_CLIENT_ID` / `_SECRET` at compile time); anyone
//! building from source can paste their own instead (Accounts → Google →
//! "Use your own OAuth client"). See docs/google-verification.md.

use pim_core::{Account, AccountConfig, OAuthAccount, OAuthIssuer, Provider, Security, ServerConfig, net, net::oauth};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_opener::OpenerExt;

use crate::commands::{Res, with_store};
use crate::{Shared, events, secrets, workers};

fn setting_key(issuer: OAuthIssuer) -> &'static str {
    match issuer {
        OAuthIssuer::Google => "oauth_client_google",
        OAuthIssuer::Microsoft => "oauth_client_microsoft",
    }
}

fn built_in(issuer: OAuthIssuer) -> Option<oauth::Client> {
    let (id, secret) = match issuer {
        OAuthIssuer::Google => (option_env!("MAILBIRD_GOOGLE_CLIENT_ID"), option_env!("MAILBIRD_GOOGLE_CLIENT_SECRET")),
        OAuthIssuer::Microsoft => (option_env!("MAILBIRD_MICROSOFT_CLIENT_ID"), None),
    };
    id.filter(|i| !i.is_empty()).map(|id| oauth::Client { client_id: id.into(), client_secret: secret.map(str::to_owned) })
}

/// The client to sign in with: one set in the app, else the built-in one.
pub fn client(state: &Shared, issuer: OAuthIssuer) -> Option<oauth::Client> {
    with_store(state, |s| s.setting(setting_key(issuer)))
        .ok()
        .flatten()
        .and_then(|j| serde_json::from_str(&j).ok())
        .or_else(|| built_in(issuer))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientInfo {
    client_id: String,
    has_secret: bool,
    /// Baked into this build rather than set in the app.
    built_in: bool,
}

#[tauri::command]
pub fn get_oauth_client(state: State<'_, Shared>, issuer: OAuthIssuer) -> Option<ClientInfo> {
    let custom = with_store(&state, |s| s.setting(setting_key(issuer))).ok().flatten().is_some();
    client(&state, issuer).map(|c| ClientInfo { has_secret: c.client_secret.is_some(), client_id: c.client_id, built_in: !custom })
}

/// Sets (or, with `None`, clears) this app's own OAuth client for a provider.
#[tauri::command]
pub fn set_oauth_client(state: State<'_, Shared>, issuer: OAuthIssuer, client: Option<oauth::Client>) -> Res<()> {
    let value = client
        .map(|c| oauth::Client { client_id: c.client_id.trim().into(), client_secret: c.client_secret.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()) })
        .filter(|c| !c.client_id.is_empty())
        .map(|c| serde_json::to_string(&c).expect("client serializes"));
    with_store(&state, |s| s.set_setting(setting_key(issuer), value.as_deref()))
}

/// Runs one browser sign-in: opens the provider's page in the system
/// browser and waits for it to come back. A new sign-in, or
/// `cancel_oauth_sign_in`, ends any that's still waiting.
async fn sign_in(app: &AppHandle, state: &Shared, issuer: OAuthIssuer, login_hint: Option<&str>) -> Res<(oauth::Client, oauth::TokenSet, oauth::Identity)> {
    let client = client(state, issuer).ok_or("set up an OAuth client for this provider first")?;
    let flow = oauth::Flow::start(issuer, oauth::endpoints(issuer), client.clone(), login_hint).await.map_err(|e| e.to_string())?;
    app.opener().open_url(&flow.url, None::<&str>).map_err(|e| format!("couldn't open the browser: {e}"))?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    if let Some(old) = state.oauth_cancel.lock().ok().and_then(|mut slot| slot.replace(tx)) {
        let _ = old.send(());
    }
    let result = tokio::select! {
        r = flow.finish(oauth::SIGN_IN_TIMEOUT) => r.map_err(|e| e.to_string()),
        _ = rx => Err("sign-in was cancelled".to_string()),
    };
    let (tokens, identity) = result?;
    Ok((client, tokens, identity))
}

#[tauri::command]
pub fn cancel_oauth_sign_in(state: State<'_, Shared>) {
    if let Some(tx) = state.oauth_cancel.lock().ok().and_then(|mut s| s.take()) {
        let _ = tx.send(());
    }
}

fn google_config(address: &str, name: Option<&str>, client_id: &str) -> AccountConfig {
    let imap = ServerConfig { host: "imap.gmail.com".into(), port: 993, security: Security::Tls };
    AccountConfig {
        display_name: name.unwrap_or(address).to_owned(),
        address: address.to_owned(),
        username: address.to_owned(),
        provider: Provider::Google,
        // Mail goes through the Gmail API; these are only for reference.
        smtp: ServerConfig { host: "smtp.gmail.com".into(), port: 465, ..imap.clone() },
        imap,
        jmap: None,
        dav: Some(pim_core::DavConfig {
            calendar_url: Some(net::gmail::CALDAV.into()),
            contacts_url: Some(net::gmail::carddav(address)),
            separate_secret: false,
        }),
        oauth: Some(OAuthAccount { issuer: OAuthIssuer::Google, client_id: client_id.to_owned(), api_base: None, token_url: None }),
    }
}

/// Adds an account by signing in with the provider in the browser.
#[tauri::command]
pub async fn add_oauth_account(app: AppHandle, state: State<'_, Shared>, issuer: OAuthIssuer, login_hint: Option<String>) -> Res<Account> {
    if issuer == OAuthIssuer::Microsoft {
        return Err("Microsoft sign-in is coming in the next release".into());
    }
    let (client, tokens, who) = sign_in(&app, state.inner(), issuer, login_hint.as_deref()).await?;
    let probe = google_config(who.email.as_deref().unwrap_or_default(), None, &client.client_id);
    // The mailbox's own address beats the ID token's, and proves Gmail access was granted.
    let address = net::gmail::verify(&probe, &tokens.access_token).await.map_err(|e| e.to_string())?;
    if with_store(&state, |s| s.accounts())?.iter().any(|a| a.config.address.eq_ignore_ascii_case(&address)) {
        return Err(format!("{address} is already added"));
    }
    let config = google_config(&address, who.name.as_deref(), &client.client_id);
    let account = with_store(&state, |s| s.add_account(&config))?;
    if let Err(e) = secrets::set_tokens(&account.id, &tokens) {
        let _ = with_store(&state, |s| s.remove_account(&account.id));
        return Err(e);
    }
    let _ = app.emit(events::ACCOUNTS_CHANGED, ());
    let (app2, state2) = (app.clone(), state.inner().clone());
    tauri::async_runtime::spawn(async move {
        workers::sync_all(&app2, &state2).await;
        workers::sync_dav_all(&app2, &state2).await;
    });
    Ok(account)
}

/// Signs an OAuth account in again (its refresh token was revoked or expired).
#[tauri::command]
pub async fn reauth_oauth_account(app: AppHandle, state: State<'_, Shared>, id: String) -> Res<Account> {
    let account = with_store(&state, |s| s.account(&id))?;
    let o = account.config.oauth.clone().ok_or("this account signs in with a password")?;
    let (client, tokens, _) = sign_in(&app, state.inner(), o.issuer, Some(&account.config.address)).await?;
    let mut config = account.config.clone();
    config.oauth = Some(OAuthAccount { client_id: client.client_id.clone(), ..o });
    let address = net::gmail::verify(&config, &tokens.access_token).await.map_err(|e| e.to_string())?;
    if !address.eq_ignore_ascii_case(&account.config.address) {
        return Err(format!("that was {address}; sign in as {} to reconnect this account", account.config.address));
    }
    secrets::set_tokens(&id, &tokens)?;
    let account = with_store(&state, |s| s.update_account_config(&id, &config))?;
    with_store(&state, |s| s.record_sync_result(&id, None))?;
    let _ = app.emit(events::ACCOUNTS_CHANGED, ());
    workers::sync_soon(&app, state.inner());
    workers::dav_sync_soon(&app, state.inner());
    Ok(account)
}
