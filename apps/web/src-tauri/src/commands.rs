//! IPC commands. Each mirrors a method on the web client in
//! `apps/web/src/core/client.ts`; errors come back as human-readable strings.

use pim_core::{
    Account, AccountConfig, Capabilities, Draft, MessageDetail, MessageQuery, MessageSummary,
    OutboxItem, Provider, net,
};
use tauri::{AppHandle, Emitter, State};

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
pub fn get_message(state: State<'_, Shared>, id: String) -> Res<MessageDetail> {
    with_store(&state, |s| s.message(&id))
}

/// Local flag changes apply instantly; the next sync pushes them up.
fn changed(app: &AppHandle, state: &Shared) {
    let _ = app.emit(events::MAIL_CHANGED, ());
    workers::sync_soon(app, state);
}

#[tauri::command]
pub fn set_seen(app: AppHandle, state: State<'_, Shared>, id: String, seen: bool) -> Res<()> {
    with_store(&state, |s| s.set_seen(&id, seen))?;
    changed(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn set_flagged(app: AppHandle, state: State<'_, Shared>, id: String, flagged: bool) -> Res<()> {
    with_store(&state, |s| s.set_flagged(&id, flagged))?;
    changed(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn set_archived(app: AppHandle, state: State<'_, Shared>, id: String, archived: bool) -> Res<()> {
    with_store(&state, |s| s.set_archived(&id, archived))?;
    changed(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn snooze(app: AppHandle, state: State<'_, Shared>, id: String, until: i64) -> Res<()> {
    with_store(&state, |s| s.snooze(&id, until))?;
    let _ = app.emit(events::MAIL_CHANGED, ());
    Ok(())
}

#[tauri::command]
pub fn unsnooze(app: AppHandle, state: State<'_, Shared>, id: String) -> Res<()> {
    with_store(&state, |s| s.unsnooze(&id))?;
    let _ = app.emit(events::MAIL_CHANGED, ());
    Ok(())
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
