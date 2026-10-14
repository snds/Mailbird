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
pub fn dav_secret(account: &pim_core::Account) -> Result<String, String> {
    match &account.config.dav {
        Some(d) if d.separate_secret => get(&dav_key(&account.id)),
        _ => get(&account.id),
    }
}
