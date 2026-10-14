//! Background work: sending once the undo window closes, waking snoozes,
//! IDLE push per account, and a periodic sync as the safety net.

use std::{sync::atomic::Ordering, time::Duration};

use pim_core::{
    net, now,
    store::{ARCHIVE, INBOX, SENT},
};
use tauri::{AppHandle, Emitter};

use crate::{Shared, events, secrets};

const TICK: Duration = Duration::from_secs(1);
/// With IDLE push this is only a safety net (and the path for servers without IDLE).
const SYNC_EVERY: Duration = Duration::from_secs(120);
/// How often the supervisor checks that every account has a push connection.
const IDLE_SUPERVISE_EVERY: Duration = Duration::from_secs(30);
/// Wait after a failed IDLE connection before trying again.
const IDLE_RETRY: Duration = Duration::from_secs(60);
/// Pause between backfill passes, so a big mailbox doesn't hog the connection.
const BACKFILL_PAUSE: Duration = Duration::from_secs(3);
/// How often due reminders are checked.
const REMINDER_TICK: Duration = Duration::from_secs(10);
/// How long one Gmail poll loop runs before the supervisor restarts it.
const GMAIL_POLL_WINDOW: Duration = Duration::from_secs(10 * 60);

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

    let (a, s) = (app.clone(), state.clone());
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(SYNC_EVERY);
        loop {
            tick.tick().await; // first tick fires immediately: sync on launch
            sync_all(&a, &s).await;
        }
    });

    // Backfill: while any account has older mail left, take another chunk.
    let (a, s) = (app.clone(), state.clone());
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(BACKFILL_PAUSE).await;
            if s.backfill_pending.swap(false, Ordering::Relaxed) && sync_pass(&a, &s).await {
                s.backfill_pending.store(true, Ordering::Relaxed);
            }
        }
    });

    // Calendars and contacts: CalDAV/CardDAV has no push we can rely on, so poll.
    let (a, s) = (app.clone(), state.clone());
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(net::dav::POLL);
        loop {
            tick.tick().await;
            sync_dav_all(&a, &s).await;
        }
    });

    // Reminders: check every few seconds for alarms that came due. Starts a
    // minute back, so one that fired while the app launched isn't lost, but
    // never replays hours of reminders missed while it was closed.
    let (a, s) = (app.clone(), state.clone());
    tauri::async_runtime::spawn(async move {
        let mut checked = now() - 60;
        let mut tick = tokio::time::interval(REMINDER_TICK);
        loop {
            tick.tick().await;
            let until = now();
            let due = s.store.lock().ok().and_then(|st| st.due_reminders(checked, until).ok()).unwrap_or_default();
            checked = until;
            for r in due {
                notify(&a, &r);
            }
        }
    });

    // Push: keep one IDLE connection per account.
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(IDLE_SUPERVISE_EVERY);
        loop {
            tick.tick().await;
            let accounts = state.store.lock().ok().and_then(|s| s.accounts().ok()).unwrap_or_default();
            for account in accounts {
                let fresh = state.idling.lock().map(|mut set| set.insert(account.id.clone())).unwrap_or(false);
                if fresh {
                    let (app, state) = (app.clone(), state.clone());
                    tauri::async_runtime::spawn(async move { idle_loop(app, state, account.id).await });
                }
            }
        }
    });
}

/// What an account signs in with right now: its password, or a fresh OAuth access token.
pub async fn secret(state: &Shared, account: &pim_core::Account) -> Result<String, String> {
    let client = account.config.oauth.as_ref().and_then(|o| crate::oauth_commands::client(state, o.issuer));
    secrets::mail_secret(account, client).await
}

fn is_gmail(account: &pim_core::Account) -> bool {
    account.config.oauth.as_ref().is_some_and(|o| o.issuer == pim_core::OAuthIssuer::Google)
}

/// Hold a push connection (IMAP IDLE, or JMAP EventSource) and sync whenever
/// the server says something changed. Ends when the account is removed or the
/// server has no push; the periodic sync covers those.
async fn idle_loop(app: AppHandle, state: Shared, account_id: String) {
    loop {
        let account = state.store.lock().ok().and_then(|s| s.account(&account_id).ok());
        let Some(account) = account else { break }; // removed
        let outcome = match secret(&state, &account).await {
            Ok(token) if is_gmail(&account) => {
                // No push without a server of our own: poll the history id (ADR-0013).
                let state = state.store.lock().ok().and_then(|s| s.remote_cursor(&account.id).ok()).and_then(|c| c.state);
                net::gmail::wait_for_change(&account.config, &token, state.as_deref(), GMAIL_POLL_WINDOW).await
            }
            Ok(password) if account.config.jmap.is_some() => {
                let state = state.store.lock().ok().and_then(|s| s.remote_cursor(&account.id).ok()).and_then(|c| c.state);
                net::jmap::wait_for_change(&account.config, &password, state.as_deref(), net::IDLE_TIMEOUT).await
            }
            Ok(password) => net::wait_for_change(&account.config, &password, net::IDLE_TIMEOUT).await,
            Err(e) => Err(pim_core::Error::Auth(e)),
        };
        match outcome {
            Ok(net::Change::Changed) => sync_all(&app, &state).await,
            Ok(net::Change::Quiet) => {}
            Ok(net::Change::Unsupported) => break, // the periodic sync covers it
            Err(e) => {
                log::info!("IDLE for {} paused: {e}", account.config.address);
                tokio::time::sleep(IDLE_RETRY).await;
            }
        }
    }
    if let Ok(mut set) = state.idling.lock() {
        set.remove(&account_id);
    }
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
            Some(account) => match secret(state, &account).await {
                Err(e) => Err(e),
                Ok(password) => match account.config.jmap {
                    _ if is_gmail(&account) => net::gmail::send(&account.config, &password, &item.draft).await,
                    Some(_) => net::jmap::send(&account.config, &password, &item.draft).await,
                    None => net::send(&account.config, &password, &item.draft).await,
                }
                .map_err(|e| e.to_string()),
            },
        };
        if let Ok(s) = state.store.lock() {
            let _ = s.finish_send(&item.id, result.as_ref().err().map(String::as_str));
            // Keep a local copy so the reply shows up inside its conversation.
            if let Ok(raw) = &result {
                let _ = s.insert_local(&item.draft.account_id, SENT, raw, true);
            }
        }
        let _ = app.emit(events::OUTBOX_CHANGED, &item.id);
        if result.is_ok() {
            let _ = app.emit(events::MAIL_CHANGED, ());
        }
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
    if sync_pass(app, state).await {
        // Big mailbox: the backfill worker keeps pulling older chunks.
        state.backfill_pending.store(true, Ordering::Relaxed);
    }
}

/// One pass over every account. Returns whether any still has older mail to backfill.
async fn sync_pass(app: &AppHandle, state: &Shared) -> bool {
    let mut more_older = false;
    let _guard = state.sync_lock.lock().await;
    let accounts = state.store.lock().ok().and_then(|s| s.accounts().ok()).unwrap_or_default();
    for account in accounts {
        let result = match secret(state, &account).await {
            Err(e) => Err(e),
            Ok(token) if is_gmail(&account) => sync_remote(state, &account, &token, Remote::Gmail).await,
            Ok(password) if account.config.jmap.is_some() => sync_remote(state, &account, &password, Remote::Jmap).await,
            Ok(password) => sync_imap(state, &account, &password).await,
        };
        if let Ok(s) = state.store.lock() {
            let _ = s.record_sync_result(&account.id, result.as_ref().err().map(String::as_str));
        }
        more_older |= result.unwrap_or(false);
    }
    let _ = app.emit(events::MAIL_CHANGED, ());
    let _ = app.emit(events::ACCOUNTS_CHANGED, ());
    more_older
}

/// One IMAP pass for one account: INBOX, Archive, and Sent on one connection.
/// Returns whether older mail remains anywhere.
async fn sync_imap(state: &Shared, account: &pim_core::Account, password: &str) -> Result<bool, String> {
    let plans = {
        let s = state.store.lock().map_err(|_| "the mail database is unavailable".to_string())?;
        [INBOX, ARCHIVE, SENT]
            .into_iter()
            .map(|m| {
                Ok(net::MailboxPlan {
                    store: m,
                    cursor: s.sync_cursor(&account.id, m).map_err(|e| e.to_string())?,
                    ops: s.pending_ops(&account.id, m).map_err(|e| e.to_string())?,
                })
            })
            .collect::<Result<Vec<_>, String>>()?
    };
    let batches = net::sync_account(&account.config, password, plans).await.map_err(|e| e.to_string())?;
    let s = state.store.lock().map_err(|_| "the mail database is unavailable".to_string())?;
    let mut more_older = false;
    for batch in &batches {
        s.apply_sync(&account.id, batch).map_err(|e| e.to_string())?;
        more_older |= batch.more_older;
    }
    Ok(more_older)
}

enum Remote {
    Jmap,
    Gmail,
}

/// One JMAP or Gmail pass for one account (every mailbox at once). Returns whether older mail remains.
async fn sync_remote(state: &Shared, account: &pim_core::Account, password: &str, kind: Remote) -> Result<bool, String> {
    let (cursor, ops) = {
        let s = state.store.lock().map_err(|_| "the mail database is unavailable".to_string())?;
        (
            s.remote_cursor(&account.id).map_err(|e| e.to_string())?,
            s.pending_remote_ops(&account.id).map_err(|e| e.to_string())?,
        )
    };
    let batch = match kind {
        Remote::Jmap => net::jmap::sync_account(&account.config, password, cursor, &ops).await,
        Remote::Gmail => net::gmail::sync_account(&account.config, password, cursor, &ops).await,
    }
    .map_err(|e| e.to_string())?;
    let s = state.store.lock().map_err(|_| "the mail database is unavailable".to_string())?;
    s.apply_remote(&account.id, &batch).map_err(|e| e.to_string())?;
    Ok(batch.more_older)
}

/// Sync calendars and contacts shortly, after a local edit.
pub fn dav_sync_soon(app: &AppHandle, state: &Shared) {
    let (app, state) = (app.clone(), state.clone());
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(1)).await;
        sync_dav_all(&app, &state).await;
    });
}

/// One CalDAV/CardDAV pass over every account that has it.
pub async fn sync_dav_all(app: &AppHandle, state: &Shared) {
    let _guard = state.dav_lock.lock().await;
    let accounts = state.store.lock().ok().and_then(|s| s.accounts().ok()).unwrap_or_default();
    for account in accounts.into_iter().filter(|a| a.config.dav.is_some()) {
        let result = sync_dav(state, &account).await;
        if let Ok(s) = state.store.lock() {
            let _ = s.record_dav_result(&account.id, result.as_ref().err().map(String::as_str));
        }
        if let Err(e) = result {
            log::info!("calendar sync for {} failed: {e}", account.config.address);
        }
    }
    let _ = app.emit(events::PIM_CHANGED, ());
    let _ = app.emit(events::ACCOUNTS_CHANGED, ());
}

async fn sync_dav(state: &Shared, account: &pim_core::Account) -> Result<(), String> {
    use pim_core::CollectionKind;
    let Some(cfg) = account.config.dav.clone() else { return Ok(()) };
    // OAuth accounts (Google) send their access token; others their password.
    let bearer = account.config.oauth.is_some();
    let secret = if bearer { secret(state, account).await? } else { secrets::dav_secret(account)? };
    let user = &account.config.username;
    let unavailable = || "the database is unavailable".to_string();
    for (kind, url) in [(CollectionKind::Calendar, &cfg.calendar_url), (CollectionKind::Contacts, &cfg.contacts_url)] {
        let Some(url) = url else { continue };
        let dav = if bearer { net::dav::Dav::with_bearer(url, &secret) } else { net::dav::Dav::new(url, user, &secret) }.map_err(|e| e.to_string())?;
        let remote = dav.discover(kind).await.map_err(|e| e.to_string())?;
        let plans = {
            let s = state.store.lock().map_err(|_| unavailable())?;
            s.sync_collections(&account.id, kind, &remote).map_err(|e| e.to_string())?;
            s.dav_cursors(&account.id)
                .map_err(|e| e.to_string())?
                .into_iter()
                .filter(|(c, _)| c.kind == kind)
                .map(|(c, cursor)| {
                    Ok(net::dav::DavPlan { changes: s.pending_dav(&c.id).map_err(|e| e.to_string())?, collection_id: c.id, kind, cursor })
                })
                .collect::<Result<Vec<_>, String>>()?
        };
        let results = net::dav::sync(&dav, plans).await.map_err(|e| e.to_string())?;
        let s = state.store.lock().map_err(|_| unavailable())?;
        for r in results {
            for (item, outcome) in &r.outcomes {
                s.dav_result(&r.collection_id, item, outcome).map_err(|e| e.to_string())?;
            }
            s.apply_dav(&r.collection_id, &r.batch).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Shows a reminder as an OS notification and tells the UI.
fn notify(app: &AppHandle, r: &pim_core::DueReminder) {
    use tauri_plugin_notification::NotificationExt;
    let minutes = (r.start - r.fire_at) / 60;
    let when = match minutes {
        m if m <= 0 => "Now".to_string(),
        m if m < 60 => format!("In {m} min"),
        m if m < 1440 => format!("In {} h", m / 60),
        m => format!("In {} days", m / 1440),
    };
    let body = match &r.location {
        Some(l) => format!("{when} · {l}"),
        None => when,
    };
    if let Err(e) = app.notification().builder().title(&r.title).body(&body).show() {
        log::info!("couldn't show a notification: {e}");
    }
    let _ = app.emit(events::REMINDER, r);
}
