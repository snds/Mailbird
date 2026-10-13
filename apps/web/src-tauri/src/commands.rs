//! IPC commands. Each mirrors a method on the web client in
//! `apps/web/src/core/client.ts`; errors come back as human-readable strings.

use pim_core::{
    Account, AccountConfig, Capabilities, Draft, MessageDetail, MessageQuery, MessageSummary,
    OutboxItem, Provider, net,
};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

use crate::{Shared, events, secrets, workers};

type Res<T> = Result<T, String>;

fn with_store<T>(state: &Shared, f: impl FnOnce(&pim_core::Store) -> pim_core::Result<T>) -> Res<T> {
    let store = state.store.lock().map_err(|_| "the mail database is unavailable".to_string())?;
    f(&store).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn provider_capabilities(provider: Provider) -> Capabilities {
    provider.capabilities()
}

#[tauri::command]
pub fn list_accounts(state: State<'_, Shared>) -> Res<Vec<Account>> {
    with_store(&state, |s| s.accounts())
}

/// Verify the credentials against both servers before saving anything.
#[tauri::command]
pub async fn add_account(
    app: AppHandle,
    state: State<'_, Shared>,
    config: AccountConfig,
    password: String,
) -> Res<Account> {
    if !matches!(config.provider.capabilities().auth, pim_core::AuthMethod::AppPassword | pim_core::AuthMethod::Password) {
        return Err("this provider needs browser sign-in, which is coming in a later release".into());
    }
    net::verify(&config, &password).await.map_err(|e| e.to_string())?;
    let account = with_store(&state, |s| s.add_account(&config))?;
    if let Err(e) = secrets::set(&account.id, &password) {
        let _ = with_store(&state, |s| s.remove_account(&account.id));
        return Err(e);
    }
    let _ = app.emit(events::ACCOUNTS_CHANGED, ());
    let (app2, state2) = (app.clone(), state.inner().clone());
    tauri::async_runtime::spawn(async move { workers::sync_all(&app2, &state2).await });
    Ok(account)
}

#[tauri::command]
pub fn remove_account(app: AppHandle, state: State<'_, Shared>, id: String) -> Res<()> {
    with_store(&state, |s| s.remove_account(&id))?;
    secrets::delete(&id);
    let _ = app.emit(events::ACCOUNTS_CHANGED, ());
    let _ = app.emit(events::MAIL_CHANGED, ());
    Ok(())
}

#[tauri::command]
pub async fn sync_now(app: AppHandle, state: State<'_, Shared>) -> Res<()> {
    workers::sync_all(&app, state.inner()).await;
    Ok(())
}

#[tauri::command]
pub fn list_messages(state: State<'_, Shared>, query: MessageQuery) -> Res<Vec<MessageSummary>> {
    with_store(&state, |s| s.messages(&query))
}

#[tauri::command]
pub fn get_thread(state: State<'_, Shared>, thread_id: String) -> Res<Vec<MessageDetail>> {
    with_store(&state, |s| s.thread(&thread_id))
}

/// Local changes apply instantly; the next sync pushes them up.
fn changed(app: &AppHandle, state: &Shared) {
    let _ = app.emit(events::MAIL_CHANGED, ());
    workers::sync_soon(app, state);
}

#[tauri::command]
pub fn set_thread_seen(app: AppHandle, state: State<'_, Shared>, thread_id: String, seen: bool) -> Res<()> {
    with_store(&state, |s| s.set_thread_seen(&thread_id, seen))?;
    changed(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn set_thread_flagged(app: AppHandle, state: State<'_, Shared>, thread_id: String, flagged: bool) -> Res<()> {
    with_store(&state, |s| s.set_thread_flagged(&thread_id, flagged))?;
    changed(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn set_thread_archived(app: AppHandle, state: State<'_, Shared>, thread_id: String, archived: bool) -> Res<()> {
    with_store(&state, |s| s.set_thread_archived(&thread_id, archived))?;
    changed(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn snooze_thread(app: AppHandle, state: State<'_, Shared>, thread_id: String, until: i64) -> Res<()> {
    with_store(&state, |s| s.snooze_thread(&thread_id, until))?;
    let _ = app.emit(events::MAIL_CHANGED, ());
    Ok(())
}

#[tauri::command]
pub fn unsnooze_thread(app: AppHandle, state: State<'_, Shared>, thread_id: String) -> Res<()> {
    with_store(&state, |s| s.unsnooze_thread(&thread_id))?;
    let _ = app.emit(events::MAIL_CHANGED, ());
    Ok(())
}

/// Save an attachment to Downloads and open it with the default app.
/// Returns the saved path so the UI can say where it went.
#[tauri::command]
pub fn open_attachment(app: AppHandle, state: State<'_, Shared>, id: String) -> Res<String> {
    let (info, bytes) = with_store(&state, |s| s.attachment(&id))?;
    let dir = app.path().download_dir().map_err(|e| format!("no Downloads folder: {e}"))?;
    let path = unique_path(&dir, &safe_filename(&info.filename));
    std::fs::write(&path, bytes).map_err(|e| format!("couldn't save {}: {e}", info.filename))?;
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| format!("saved to {}, but couldn't open it: {e}", path.display()))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Attachment names come from strangers: strip anything path-like.
fn safe_filename(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let cleaned: String = base
        .chars()
        .map(|c| if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') { '_' } else { c })
        .collect();
    let cleaned = cleaned.trim().trim_start_matches('.').to_string();
    if cleaned.is_empty() { "attachment".into() } else { cleaned }
}

fn unique_path(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
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

#[tauri::command]
pub fn queue_send(app: AppHandle, state: State<'_, Shared>, draft: Draft, undo_secs: i64) -> Res<OutboxItem> {
    let item = with_store(&state, |s| s.queue_send(&draft, undo_secs))?;
    let _ = app.emit(events::OUTBOX_CHANGED, ());
    Ok(item)
}

#[tauri::command]
pub fn cancel_send(app: AppHandle, state: State<'_, Shared>, id: String) -> Res<Draft> {
    let draft = with_store(&state, |s| s.cancel_send(&id))?;
    let _ = app.emit(events::OUTBOX_CHANGED, ());
    Ok(draft)
}

#[tauri::command]
pub fn list_outbox(state: State<'_, Shared>) -> Res<Vec<OutboxItem>> {
    with_store(&state, |s| s.outbox())
}
