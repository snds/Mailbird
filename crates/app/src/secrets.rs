//! Account passwords and tokens live in a [`SecretStore`] chosen by the
//! host: the OS keychain in the desktop and phone apps, a sealed file in the
//! web gateway. They never touch SQLite, logs, or the web layer after sign-in.

use std::sync::OnceLock;

/// Where secrets are kept. `get` says in plain words when one is missing.
pub trait SecretStore: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<String>, String>;
    fn set(&self, key: &str, value: &str) -> Result<(), String>;
    fn delete(&self, key: &str);
}

static STORE: OnceLock<Box<dyn SecretStore>> = OnceLock::new();

/// Sets the store once, at startup.
pub fn install(store: Box<dyn SecretStore>) {
    let _ = STORE.set(store);
}

fn store() -> Result<&'static dyn SecretStore, String> {
    STORE.get().map(|s| s.as_ref()).ok_or_else(|| "no secret store is set up".to_string())
}

pub fn set(key: &str, value: &str) -> Result<(), String> {
    store()?.set(key, value)
}

pub fn get(key: &str) -> Result<String, String> {
    store()?.get(key)?.ok_or_else(|| "the saved password is missing — sign in to this account again".into())
}

pub fn delete(key: &str) {
    if let Ok(s) = store() {
        s.delete(key);
    }
}

/// Keychain key for an account's separate calendar/contacts password
/// (`DavConfig::separate_secret`).
pub fn dav_key(account_id: &str) -> String {
    format!("{account_id}:dav")
}

/// The secret CalDAV/CardDAV signs in with: its own, or the mail one.
/// (OAuth accounts use their access token; see `mail_secret`.)
pub fn dav_secret(account: &pim_core::Account) -> Result<String, String> {
    match &account.config.dav {
        Some(d) if d.separate_secret => get(&dav_key(&account.id)),
        _ => get(&account.id),
    }
}

// ── OAuth accounts ──────────────────────────────────────────────────────────
// For an OAuth account the keychain entry holds its token set as JSON. Every
// protocol gets a fresh access token from here, refreshing when it's about
// to expire. One refresh at a time, so two workers never race to rotate it.

use pim_core::net::oauth;

static REFRESH: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub fn set_tokens(account_id: &str, tokens: &oauth::TokenSet) -> Result<(), String> {
    set(account_id, &serde_json::to_string(tokens).expect("tokens serialize"))
}

fn tokens(account_id: &str) -> Result<oauth::TokenSet, String> {
    serde_json::from_str(&get(account_id)?).map_err(|_| "the saved sign-in is damaged — sign in to this account again".to_string())
}

/// What the account signs in with: its password, or a current OAuth access token.
pub async fn mail_secret(account: &pim_core::Account, client: Option<oauth::Client>) -> Result<String, String> {
    let Some(o) = &account.config.oauth else { return get(&account.id) };
    let _guard = REFRESH.lock().await;
    let t = tokens(&account.id)?;
    if t.fresh() {
        return Ok(t.access_token);
    }
    let client = client.filter(|c| c.client_id == o.client_id).unwrap_or(oauth::Client { client_id: o.client_id.clone(), client_secret: None });
    let token_url = o.token_url.clone().unwrap_or_else(|| oauth::endpoints(o.issuer).token);
    let fresh = oauth::refresh(&token_url, &client, &t).await.map_err(|e| e.to_string())?;
    set_tokens(&account.id, &fresh)?;
    Ok(fresh.access_token)
}

/// Best effort: revokes an OAuth account's tokens before they're deleted.
pub async fn revoke(account: &pim_core::Account) {
    if let (Some(o), Ok(t)) = (&account.config.oauth, tokens(&account.id)) {
        let _ = oauth::revoke(o.issuer, &t).await;
    }
}
