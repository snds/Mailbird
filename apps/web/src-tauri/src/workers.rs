//! Background work: sending once the undo window closes, waking snoozes,
//! and syncing every account on an interval.

use std::time::Duration;

use pim_core::{net, now};
use tauri::{AppHandle, Emitter};

use crate::{Shared, events, secrets};

const TICK: Duration = Duration::from_secs(1);
const SYNC_EVERY: Duration = Duration::from_secs(120);

pub fn start(app: AppHandle, state: Shared) {
    // Outbox + snooze: cheap local checks, once a second, so undo-send timing
    // and snooze wake-ups feel exact.
    let (a, s) = (app.clone(), state.clone());
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(TICK);
        loop {
            tick.tick().await;
            send_due(&a, &s).await;
            wake_snoozes(&a, &s);
        }
    });

    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(SYNC_EVERY);
        loop {
            tick.tick().await; // first tick fires immediately: sync on launch
            sync_all(&app, &state).await;
        }
    });
}

fn wake_snoozes(app: &AppHandle, state: &Shared) {
    let woke = state.store.lock().ok().and_then(|s| s.wake_snoozed(now()).ok()).unwrap_or(0);
    if woke > 0 {
        let _ = app.emit(events::MAIL_CHANGED, ());
        // Snoozed mail resurfaces unread, and that op should reach the server.
        sync_soon(app, state);
    }
}

async fn send_due(app: &AppHandle, state: &Shared) {
    let due = match state.store.lock() {
        Ok(s) => s.claim_due(now()).unwrap_or_default(),
        Err(_) => return,
    };
    if due.is_empty() {
        return;
    }
    for item in due {
        let account = state.store.lock().ok().and_then(|s| s.account(&item.draft.account_id).ok());
        let result = match account {
            None => Err("the sending account was removed".to_string()),
            Some(account) => match secrets::get(&account.id) {
                Err(e) => Err(e),
                Ok(password) => net::send(&account.config, &password, &item.draft)
                    .await
                    .map(|_| ())
                    .map_err(|e| e.to_string()),
            },
        };
        if let Ok(s) = state.store.lock() {
            let _ = s.finish_send(&item.id, result.as_ref().err().map(String::as_str));
        }
        let _ = app.emit(events::OUTBOX_CHANGED, &item.id);
    }
}

/// Sync shortly, off the caller's path (after a local change).
pub fn sync_soon(app: &AppHandle, state: &Shared) {
    let (app, state) = (app.clone(), state.clone());
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(2)).await;
        sync_all(&app, &state).await;
    });
}

pub async fn sync_all(app: &AppHandle, state: &Shared) {
    let _guard = state.sync_lock.lock().await;
    let accounts = state.store.lock().ok().and_then(|s| s.accounts().ok()).unwrap_or_default();
    for account in accounts {
        let prepared = state.store.lock().ok().and_then(|s| {
            Some((s.sync_cursor(&account.id, net::INBOX).ok()?, s.pending_ops(&account.id, net::INBOX).ok()?))
        });
        let Some((cursor, ops)) = prepared else { continue };

        let result = match secrets::get(&account.id) {
            Err(e) => Err(e),
            Ok(password) => net::sync_inbox(&account.config, &password, cursor, &ops)
                .await
                .map_err(|e| e.to_string()),
        };

        if let Ok(s) = state.store.lock() {
            match &result {
                Ok(batch) => {
                    let applied = s.apply_sync(&account.id, batch);
                    let _ = s.record_sync_result(&account.id, applied.as_ref().err().map(|e| e.to_string()).as_deref());
                }
                Err(e) => {
                    let _ = s.record_sync_result(&account.id, Some(e));
                }
            }
        }
    }
    let _ = app.emit(events::MAIL_CHANGED, ());
    let _ = app.emit(events::ACCOUNTS_CHANGED, ());
}
