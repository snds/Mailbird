//! Account passwords live in the OS keychain, keyed by account id. They never
//! touch SQLite, logs, or the web layer after sign-in.

const SERVICE: &str = "design.snds.mailbird";

fn entry(account_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, account_id).map_err(|e| format!("keychain unavailable: {e}"))
}

pub fn set(account_id: &str, password: &str) -> Result<(), String> {
    entry(account_id)?
        .set_password(password)
        .map_err(|e| format!("couldn't save the password to the keychain: {e}"))
}

pub fn get(account_id: &str) -> Result<String, String> {
    entry(account_id)?.get_password().map_err(|e| match e {
        keyring::Error::NoEntry => "the saved password is missing — sign in to this account again".into(),
        e => format!("couldn't read the password from the keychain: {e}"),
    })
}

pub fn delete(account_id: &str) {
    if let Ok(e) = entry(account_id) {
        let _ = e.delete_credential();
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
