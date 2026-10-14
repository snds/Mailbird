//! Background work: sending once the undo window closes, waking snoozes,
//! IDLE push per account, and a periodic sync as the safety net.

use std::{sync::atomic::Ordering, time::Duration};

use pim_core::{
    net, now,
    store::{ARCHIVE, INBOX, SENT},
};
use crate::host::AppHandle;

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
/// How often Outlook subscriptions to the push relay are checked (renewed at half-life).
const RENEW_EVERY: Duration = Duration::from_secs(6 * 3600);
/// How long a phone's background pass may run (iOS gives about 30 seconds).
const BACKGROUND_BUDGET: Duration = Duration::from_secs(25);
/// How long one Gmail or Outlook poll loop runs before the supervisor restarts it.
const POLL_WINDOW: Duration = Duration::from_secs(10 * 60);

pub fn start(app: AppHandle, state: Shared) {
    // Outbox + snooze: cheap local checks, once a second, so undo-send timing
    // and snooze wake-ups feel exact.
    let (a, s) = (app.clone(), state.clone());
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(TICK);
        // Reminders that came due while the app was closed show in the inbox
        // without a notification each; only ones from now on announce themselves.
        let mut checked = now();
        loop {
            tick.tick().await;
            send_due(&a, &s).await;
            wake_snoozes(&a, &s);
            checked = announce_follow_ups(&a, &s, checked);
        }
    });

    let (a, s) = (app.clone(), state.clone());
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(SYNC_EVERY);
        loop {
            tick.tick().await; // first tick fires immediately: sync on launch
            sync_all(&a, &s).await;
        }
    });

    // Backfill: while any account has older mail left, take another chunk.
    let (a, s) = (app.clone(), state.clone());
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(BACKFILL_PAUSE).await;
            if s.backfill_pending.swap(false, Ordering::Relaxed) && sync_pass(&a, &s).await {
                s.backfill_pending.store(true, Ordering::Relaxed);
            }
        }
    });

    // Calendars and contacts: CalDAV/CardDAV has no push we can rely on, so poll.
    let (a, s) = (app.clone(), state.clone());
    tokio::spawn(async move {
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
    tokio::spawn(async move {
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

    // Push relay: keep Outlook's Graph subscriptions alive (ADR-0015).
    let s = state.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(RENEW_EVERY);
        loop {
            tick.tick().await;
            crate::push::renew_outlook(&s).await;
        }
    });

    // Push: keep one IDLE connection per account.
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(IDLE_SUPERVISE_EVERY);
        loop {
            tick.tick().await;
            let accounts = state.store.lock().ok().and_then(|s| s.accounts().ok()).unwrap_or_default();
            for account in accounts {
                let fresh = state.idling.lock().map(|mut set| set.insert(account.id.clone())).unwrap_or(false);
                if fresh {
                    let (app, state) = (app.clone(), state.clone());
                    tokio::spawn(async move { idle_loop(app, state, account.id).await });
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

/// Which API an OAuth account's mail goes through.
fn remote_of(account: &pim_core::Account) -> Option<Remote> {
    match account.config.oauth.as_ref()?.issuer {
        pim_core::OAuthIssuer::Google => Some(Remote::Gmail),
        pim_core::OAuthIssuer::Microsoft => Some(Remote::Graph),
    }
}

/// Hold a push connection (IMAP IDLE, or JMAP EventSource) and sync whenever
/// the server says something changed. Ends when the account is removed or the
/// server has no push; the periodic sync covers those.
async fn idle_loop(app: AppHandle, state: Shared, account_id: String) {
    loop {
        let account = state.store.lock().ok().and_then(|s| s.account(&account_id).ok());
        let Some(account) = account else { break }; // removed
        let outcome = match secret(&state, &account).await {
            Ok(token) if remote_of(&account).is_some() => {
                // No push without a server of our own: poll instead (ADR-0013, ADR-0014).
                let state = state.store.lock().ok().and_then(|s| s.remote_cursor(&account.id).ok()).and_then(|c| c.state);
                match remote_of(&account) {
                    Some(Remote::Graph) => net::graph::wait_for_change(&account.config, &token, state.as_deref(), POLL_WINDOW).await,
                    _ => net::gmail::wait_for_change(&account.config, &token, state.as_deref(), POLL_WINDOW).await,
                }
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

/// Bring back conversations whose follow-up came due since `after`, with a
/// notification for each. Returns the time checked up to.
fn announce_follow_ups(app: &AppHandle, state: &Shared, after: i64) -> i64 {
    let until = now();
    if until <= after {
        return after;
    }
    let due = state.store.lock().ok().and_then(|s| s.follow_ups_due(after, until).ok()).unwrap_or_default();
    if !due.is_empty() {
        let _ = app.emit(events::MAIL_CHANGED, ());
        for (_, subject) in &due {
            let _ = app.notify("No reply yet", subject);
        }
    }
    until
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
                Ok(password) => match (remote_of(&account), &account.config.jmap) {
                    (Some(Remote::Gmail), _) => net::gmail::send(&account.config, &password, &item.draft).await,
                    (Some(Remote::Graph), _) => net::graph::send(&account.config, &password, &item.draft).await,
                    (_, Some(_)) => net::jmap::send(&account.config, &password, &item.draft).await,
                    _ => net::send(&account.config, &password, &item.draft).await,
                }
                .map_err(|e| e.to_string()),
            },
        };
        if let Ok(s) = state.store.lock() {
            let _ = s.finish_send(&item.id, result.as_ref().err().map(String::as_str));
            // Keep a local copy so the reply shows up inside its conversation.
            if let Ok(raw) = &result {
                let _ = s.insert_local(&item.draft.account_id, SENT, raw, true);
                // The reminder keys on the Message-ID the message went out with.
                if let (Some(after), Some(mid)) = (item.draft.follow_up_after, pim_core::mime::parse(raw).ok().and_then(|p| p.message_id)) {
                    let _ = s.add_follow_up(&item.draft.account_id, &mid, now() + after);
                }
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
    tokio::spawn(async move {
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
            Ok(token) if let Some(kind) = remote_of(&account) => sync_remote(state, &account, &token, kind).await,
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

#[derive(Clone, Copy)]
enum Remote {
    Jmap,
    Gmail,
    Graph,
}

/// One JMAP, Gmail, or Outlook pass for one account (every mailbox at once). Returns whether older mail remains.
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
        Remote::Graph => net::graph::sync_account(&account.config, password, cursor, &ops).await,
    }
    .map_err(|e| e.to_string())?;
    let s = state.store.lock().map_err(|_| "the mail database is unavailable".to_string())?;
    s.apply_remote(&account.id, &batch).map_err(|e| e.to_string())?;
    Ok(batch.more_older)
}

/// Sync calendars and contacts shortly, after a local edit.
pub fn dav_sync_soon(app: &AppHandle, state: &Shared) {
    let (app, state) = (app.clone(), state.clone());
    tokio::spawn(async move {
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
    if matches!(remote_of(account), Some(Remote::Graph)) {
        return sync_outlook_pim(state, account).await;
    }
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

/// Outlook calendars and contacts: Graph behind the same store contract as DAV (ADR-0014).
async fn sync_outlook_pim(state: &Shared, account: &pim_core::Account) -> Result<(), String> {
    use pim_core::CollectionKind;
    let token = secret(state, account).await?;
    let unavailable = || "the database is unavailable".to_string();
    let tz = state.store.lock().map_err(|_| unavailable())?.time_zone().map_err(|e| e.to_string())?;
    let pim = net::graph_pim::Pim::new(&account.config, &token, &tz).map_err(|e| e.to_string())?;
    for kind in [CollectionKind::Calendar, CollectionKind::Contacts] {
        let remote = pim.discover(kind).await.map_err(|e| e.to_string())?;
        let plans = {
            let s = state.store.lock().map_err(|_| unavailable())?;
            s.sync_collections(&account.id, kind, &remote).map_err(|e| e.to_string())?;
            s.dav_cursors(&account.id)
                .map_err(|e| e.to_string())?
                .into_iter()
                .filter(|(c, _)| c.kind == kind)
                .map(|(c, cursor)| Ok(net::dav::DavPlan { changes: s.pending_dav(&c.id).map_err(|e| e.to_string())?, collection_id: c.id, kind, cursor }))
                .collect::<Result<Vec<_>, String>>()?
        };
        let results = net::graph_pim::sync(&pim, plans).await.map_err(|e| e.to_string())?;
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

/// What a background pass found.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundOutcome {
    new_mail: usize,
    finished: bool,
}

/// One bounded sync for when the OS wakes the app in the background: iOS
/// background refresh, Android WorkManager, or a push from the relay
/// (ADR-0015). Syncs mail, renews Outlook subscriptions, and notifies about
/// mail that's new since the last pass, within the platform's time budget.
pub async fn background_pass(app: AppHandle, state: &Shared) -> Result<BackgroundOutcome, String> {
    let unread = |s: &Shared| -> Vec<pim_core::MessageSummary> {
        s.store
            .lock()
            .ok()
            .and_then(|st| st.messages(&pim_core::MessageQuery { lane: pim_core::Lane::Unread, account_id: None, search: None, limit: None, offset: None }).ok())
            .unwrap_or_default()
    };
    let before: std::collections::HashSet<String> = unread(state).into_iter().map(|m| m.id).collect();
    let finished = tokio::time::timeout(BACKGROUND_BUDGET, async {
        sync_pass(&app, state).await;
        crate::push::renew_outlook(state).await;
    })
    .await
    .is_ok();
    let fresh: Vec<_> = unread(state).into_iter().filter(|m| !before.contains(&m.id)).collect();
    // The notification is written here, on the device: the relay never saw the mail.
    if !fresh.is_empty() {
        let (title, body) = match fresh.as_slice() {
            [one] => (one.from.name.clone().filter(|n| !n.is_empty()).unwrap_or_else(|| one.from.email.clone()), one.subject.clone()),
            many => (format!("{} new messages", many.len()), many.iter().take(3).map(|m| m.subject.as_str()).collect::<Vec<_>>().join(" · ")),
        };
        let _ = app.notify(&title, &body);
    }
    Ok(BackgroundOutcome { new_mail: fresh.len(), finished })
}

/// Shows a reminder as an OS notification and tells the UI.
fn notify(app: &AppHandle, r: &pim_core::DueReminder) {
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
    if let Err(e) = app.notify(&r.title, &body) {
        log::info!("couldn't show a notification: {e}");
    }
    let _ = app.emit(events::REMINDER, r);
}
