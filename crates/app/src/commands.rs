//! IPC commands. Each mirrors a method on the web client in
//! `apps/web/src/core/client.ts`; errors come back as human-readable strings.

use pim_core::{
    Account, AccountConfig, Capabilities, Draft, MessageDetail, MessageQuery, MessageSummary,
    OutboxItem, Provider, net,
};
use crate::host::AppHandle;

use crate::{Shared, events, secrets, workers};

pub type Res<T> = Result<T, String>;

pub fn with_store<T>(state: &Shared, f: impl FnOnce(&pim_core::Store) -> pim_core::Result<T>) -> Res<T> {
    let store = state.store.lock().map_err(|_| "the mail database is unavailable".to_string())?;
    f(&store).map_err(|e| e.to_string())
}

pub fn provider_capabilities(provider: Provider) -> Capabilities {
    provider.capabilities()
}

pub fn list_accounts(state: &Shared) -> Res<Vec<Account>> {
    with_store(state, |s| s.accounts())
}

/// Checks calendar and contacts sign-in before anything is saved.
async fn verify_dav(config: &AccountConfig, secret: &str) -> Res<()> {
    let Some(dav) = &config.dav else { return Ok(()) };
    for (kind, url) in [(pim_core::CollectionKind::Calendar, &dav.calendar_url), (pim_core::CollectionKind::Contacts, &dav.contacts_url)] {
        if let Some(url) = url {
            let client = net::dav::Dav::new(url, &config.username, secret).map_err(|e| format!("Calendars and contacts: {e}"))?;
            client.discover(kind).await.map_err(|e| format!("Calendars and contacts: {e}"))?;
        }
    }
    Ok(())
}

/// Verify the credentials against every server before saving anything.
/// `dav_password` is only for providers whose CalDAV needs its own app
/// password (`DavConfig::separate_secret`).
pub async fn add_account(
    app: AppHandle,
    state: &Shared,
    config: AccountConfig,
    password: String,
    dav_password: Option<String>,
) -> Res<Account> {
    if !matches!(config.provider.capabilities().auth, pim_core::AuthMethod::AppPassword | pim_core::AuthMethod::Password) {
        return Err("this provider signs in through the browser: choose it under Add an account".into());
    }
    match config.jmap {
        Some(_) => net::jmap::verify(&config, &password).await,
        None => net::verify(&config, &password).await,
    }
    .map_err(|e| e.to_string())?;
    let separate = config.dav.as_ref().is_some_and(|d| d.separate_secret);
    let dav_secret = if separate { dav_password.clone().filter(|p| !p.is_empty()).ok_or("enter the calendar app password")? } else { password.clone() };
    verify_dav(&config, &dav_secret).await?;
    let account = with_store(state, |s| s.add_account(&config))?;
    let saved = secrets::set(&account.id, &password).and_then(|_| if separate { secrets::set(&secrets::dav_key(&account.id), &dav_secret) } else { Ok(()) });
    if let Err(e) = saved {
        let _ = with_store(state, |s| s.remove_account(&account.id));
        secrets::delete(&account.id);
        return Err(e);
    }
    let _ = app.emit(events::ACCOUNTS_CHANGED, ());
    crate::push::accounts_changed(state);
    let (app2, state2) = (app.clone(), state.clone());
    tokio::spawn(async move {
        workers::sync_all(&app2, &state2).await;
        workers::sync_dav_all(&app2, &state2).await;
    });
    Ok(account)
}

/// Connects calendars and contacts to an existing account (or disconnects
/// them with `dav: None`). The password is required when DAV has its own.
pub async fn set_account_dav(app: AppHandle, state: &Shared, id: String, dav: Option<pim_core::DavConfig>, password: Option<String>) -> Res<Account> {
    let mut account = with_store(state, |s| s.account(&id))?;
    account.config.dav = dav.clone();
    if let Some(d) = &dav {
        let secret = match password.filter(|p| !p.is_empty()) {
            Some(p) => p,
            None if !d.separate_secret => secrets::get(&id)?,
            None => return Err("enter the calendar app password".into()),
        };
        verify_dav(&account.config, &secret).await?;
        if d.separate_secret {
            secrets::set(&secrets::dav_key(&id), &secret)?;
        }
    } else {
        secrets::delete(&secrets::dav_key(&id));
    }
    let account = with_store(state, |s| s.set_account_dav(&id, dav.as_ref()))?;
    let _ = app.emit(events::ACCOUNTS_CHANGED, ());
    let _ = app.emit(events::PIM_CHANGED, ());
    workers::dav_sync_soon(&app, state);
    Ok(account)
}

/// Removes the account and its mail. An OAuth sign-in is revoked with the provider too.
pub async fn remove_account(app: AppHandle, state: &Shared, id: String) -> Res<()> {
    let account = with_store(state, |s| s.account(&id))?;
    crate::push::account_removing(state, &account).await;
    secrets::revoke(&account).await;
    with_store(state, |s| s.remove_account(&id))?;
    secrets::delete(&id);
    secrets::delete(&secrets::dav_key(&id));
    let _ = app.emit(events::ACCOUNTS_CHANGED, ());
    let _ = app.emit(events::PIM_CHANGED, ());
    let _ = app.emit(events::MAIL_CHANGED, ());
    crate::push::accounts_changed(state);
    Ok(())
}

pub async fn sync_now(app: AppHandle, state: &Shared) -> Res<()> {
    workers::sync_all(&app, state).await;
    Ok(())
}

pub fn list_messages(state: &Shared, query: MessageQuery) -> Res<Vec<MessageSummary>> {
    with_store(state, |s| s.messages(&query))
}

pub fn get_thread(state: &Shared, thread_id: String) -> Res<Vec<MessageDetail>> {
    with_store(state, |s| s.thread(&thread_id))
}

/// Local changes apply instantly; the next sync pushes them up.
fn changed(app: &AppHandle, state: &Shared) {
    let _ = app.emit(events::MAIL_CHANGED, ());
    workers::sync_soon(app, state);
}

// ── Splits and the newsletter bundle (ADR-0022) ──

pub fn list_splits(state: &Shared) -> Res<Vec<pim_core::Split>> {
    with_store(state, |s| s.splits())
}

pub fn save_split(app: AppHandle, state: &Shared, id: Option<String>, input: pim_core::SplitInput) -> Res<pim_core::Split> {
    let split = with_store(state, |s| s.save_split(id.as_deref(), &input))?;
    let _ = app.emit(events::MAIL_CHANGED, ());
    Ok(split)
}

pub fn delete_split(app: AppHandle, state: &Shared, id: String) -> Res<Vec<pim_core::Split>> {
    let all = with_store(state, |s| s.delete_split(&id))?;
    let _ = app.emit(events::MAIL_CHANGED, ());
    Ok(all)
}

pub fn move_split(app: AppHandle, state: &Shared, id: String, index: usize) -> Res<Vec<pim_core::Split>> {
    let all = with_store(state, |s| s.move_split(&id, index))?;
    let _ = app.emit(events::MAIL_CHANGED, ());
    Ok(all)
}

pub fn inbox_overview(state: &Shared, account_id: Option<String>) -> Res<pim_core::InboxOverview> {
    with_store(state, |s| s.inbox_overview(account_id.as_deref()))
}

pub fn bundle_mark_read(app: AppHandle, state: &Shared, account_id: Option<String>) -> Res<u32> {
    let n = with_store(state, |s| s.bundle_mark_read(account_id.as_deref()))?;
    changed(&app, state);
    Ok(n)
}

/// Archives the bundle; returns the keys Undo needs.
pub fn bundle_archive(app: AppHandle, state: &Shared, account_id: Option<String>) -> Res<Vec<String>> {
    let ids = with_store(state, |s| s.bundle_archive(account_id.as_deref()))?;
    changed(&app, state);
    Ok(ids)
}

/// Which mail actions your swipes do (ADR-0025).
pub fn swipe_actions(state: &Shared) -> Res<pim_core::SwipeActions> {
    with_store(state, |s| s.swipe_actions())
}

pub fn set_swipe_actions(state: &Shared, actions: pim_core::SwipeActions) -> Res<pim_core::SwipeActions> {
    with_store(state, |s| s.set_swipe_actions(&actions))
}

pub fn unarchive_bundle(app: AppHandle, state: &Shared, keys: Vec<String>) -> Res<()> {
    with_store(state, |s| s.unarchive_bundle(&keys))?;
    changed(&app, state);
    Ok(())
}

pub fn set_thread_seen(app: AppHandle, state: &Shared, thread_id: String, seen: bool) -> Res<()> {
    with_store(state, |s| s.set_thread_seen(&thread_id, seen))?;
    changed(&app, state);
    Ok(())
}

pub fn set_thread_flagged(app: AppHandle, state: &Shared, thread_id: String, flagged: bool) -> Res<()> {
    with_store(state, |s| s.set_thread_flagged(&thread_id, flagged))?;
    changed(&app, state);
    Ok(())
}

pub fn set_thread_archived(app: AppHandle, state: &Shared, thread_id: String, archived: bool) -> Res<()> {
    with_store(state, |s| s.set_thread_archived(&thread_id, archived))?;
    changed(&app, state);
    Ok(())
}

pub fn snooze_thread(app: AppHandle, state: &Shared, thread_id: String, until: i64) -> Res<()> {
    with_store(state, |s| s.snooze_thread(&thread_id, until))?;
    let _ = app.emit(events::MAIL_CHANGED, ());
    Ok(())
}

pub fn unsnooze_thread(app: AppHandle, state: &Shared, thread_id: String) -> Res<()> {
    with_store(state, |s| s.unsnooze_thread(&thread_id))?;
    let _ = app.emit(events::MAIL_CHANGED, ());
    Ok(())
}

/// An attachment's bytes for in-app preview. Sent as a raw IPC response
/// (an ArrayBuffer in the UI), not JSON, so a 10 MB PDF isn't a 13 MB string.
pub fn attachment_data(state: &Shared, id: String) -> Res<Vec<u8>> {
    let (_, bytes) = with_store(state, |s| s.attachment(&id))?;
    Ok(bytes)
}

/// Save an attachment to Downloads and open it with the default app.
/// Returns the saved path so the UI can say where it went.
pub fn open_attachment(app: AppHandle, state: &Shared, id: String) -> Res<String> {
    let (info, bytes) = with_store(state, |s| s.attachment(&id))?;
    let dir = app.download_dir()?;
    let path = unique_path(&dir, &safe_filename(&info.filename));
    std::fs::write(&path, bytes).map_err(|e| format!("couldn't save {}: {e}", info.filename))?;
    app.open_path(&path).map_err(|e| format!("saved to {}, but couldn't open it: {e}", path.display()))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Attachment names come from strangers: strip anything path-like.
pub(crate) fn safe_filename(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let cleaned: String = base
        .chars()
        .map(|c| if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') { '_' } else { c })
        .collect();
    let cleaned = cleaned.trim().trim_start_matches('.').to_string();
    if cleaned.is_empty() { "attachment".into() } else { cleaned }
}

pub(crate) fn unique_path(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.to_string(), String::new()),
    };
    (1..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .expect("some numbered name is free")
}

pub fn queue_send(app: AppHandle, state: &Shared, draft: Draft, undo_secs: i64, send_at: Option<i64>) -> Res<OutboxItem> {
    let item = with_store(state, |s| s.queue_send(&draft, undo_secs, send_at))?;
    let _ = app.emit(events::OUTBOX_CHANGED, ());
    Ok(item)
}

pub fn cancel_send(app: AppHandle, state: &Shared, id: String) -> Res<Draft> {
    let draft = with_store(state, |s| s.cancel_send(&id))?;
    let _ = app.emit(events::OUTBOX_CHANGED, ());
    Ok(draft)
}

pub fn list_outbox(state: &Shared) -> Res<Vec<OutboxItem>> {
    with_store(state, |s| s.outbox())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attachment_names_cannot_escape_downloads() {
        assert_eq!(safe_filename("../../.ssh/authorized_keys"), "authorized_keys");
        assert_eq!(safe_filename("C:\\Windows\\evil.exe"), "evil.exe");
        assert_eq!(safe_filename("..."), "attachment");
        assert_eq!(safe_filename("report: final?.pdf"), "report_ final_.pdf");
    }

    #[test]
    fn existing_files_are_never_overwritten() {
        let dir = std::env::temp_dir().join(format!("mb-unique-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.pdf"), b"x").unwrap();
        assert_eq!(unique_path(&dir, "a.pdf"), dir.join("a (1).pdf"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
