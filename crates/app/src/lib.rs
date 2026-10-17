//! The app itself, on top of `pim-core`: every command the UI calls, the
//! background workers (undo-send outbox, snooze wake-ups, sync, push), and
//! one [`dispatch`] that routes a command by name. The Tauri shell (desktop
//! and phones) and the web gateway are thin hosts around it (ADR-0016).
//!
//! Locking rule: the store mutex is never held across a network await.
//! Workers read what they need, release the lock, talk to the server, then
//! lock again to write the result.

pub mod ai_commands;
pub mod clipboard;
pub mod commands;
pub mod compose_commands;
pub mod sender_commands;
pub mod dispatch;
pub mod host;
pub mod identity;
pub mod menu_bar;
pub mod notes_commands;
pub mod oauth_commands;
pub mod pim_commands;
pub mod push;
pub mod secrets;
pub mod team_commands;
pub mod workers;

use std::{
    collections::HashSet,
    path::Path,
    sync::{Arc, Mutex, atomic::AtomicBool},
};

pub use dispatch::{Output, dispatch};
pub use host::{AppHandle, Host};
use pim_core::Store;

pub struct AppState {
    pub store: Mutex<Store>,
    /// One sync at a time, so two passes never race on the same cursor.
    pub sync_lock: tokio::sync::Mutex<()>,
    /// Accounts with a live IDLE (push) connection.
    pub idling: Mutex<HashSet<String>>,
    /// Some account still has older mail on the server to backfill.
    pub backfill_pending: AtomicBool,
    /// One calendar/contacts sync at a time.
    pub dav_lock: tokio::sync::Mutex<()>,
    /// Ends the browser sign-in that's waiting, if any.
    pub oauth_cancel: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    /// Reminders that came due while the app was closed, kept until the UI
    /// asks: at launch it isn't listening yet, so an event would be lost.
    pub missed_reminders: Mutex<Vec<pim_core::DueReminder>>,
    /// The key that opens locked notes while they're unlocked, and when it
    /// was last used (ADR-0043). Only ever in memory.
    pub notes_key: Mutex<Option<(pim_core::NotesKey, std::time::Instant)>>,
    /// The shared identity, when the host turns it on (ADR-0051).
    pub identity: Mutex<Option<identity::IdentityConfig>>,
}

pub type Shared = Arc<AppState>;

impl AppState {
    /// Opens (or creates) the database in `dir`.
    pub fn open(dir: &Path) -> pim_core::Result<Shared> {
        std::fs::create_dir_all(dir).map_err(|e| pim_core::Error::Invalid(format!("can't create {}: {e}", dir.display())))?;
        let store = Store::open(dir.join("mail.db"))?;
        // Somewhere to save events and contacts even with no account.
        store.ensure_local_collections()?;
        Ok(Arc::new(AppState {
            store: Mutex::new(store),
            sync_lock: tokio::sync::Mutex::new(()),
            idling: Mutex::new(HashSet::new()),
            backfill_pending: AtomicBool::new(false),
            dav_lock: tokio::sync::Mutex::new(()),
            oauth_cancel: Mutex::new(None),
            missed_reminders: Mutex::new(Vec::new()),
            notes_key: Mutex::new(None),
            identity: Mutex::new(None),
        }))
    }

    /// Keeps the locked-notes key in the shared identity too (ADR-0051).
    /// Hosts on a person's own device call this; a server doesn't.
    pub fn enable_identity(&self, config: identity::IdentityConfig) {
        if let Ok(mut slot) = self.identity.lock() {
            *slot = Some(config);
        }
    }
}

/// Events the UI listens for to refresh its queries.
pub mod events {
    pub const MAIL_CHANGED: &str = "mail:changed";
    pub const OUTBOX_CHANGED: &str = "outbox:changed";
    pub const ACCOUNTS_CHANGED: &str = "accounts:changed";
    /// Calendars, events, or contacts changed (sync or local edit).
    pub const PIM_CHANGED: &str = "pim:changed";
    /// A reminder is due (payload: `DueReminder`); the UI shows it in-app too.
    pub const REMINDER: &str = "reminder";
    /// Notes changed (local edit, import, or sync).
    pub const NOTES_CHANGED: &str = "notes:changed";
    /// Templates or signatures changed.
    pub const COMPOSE_CHANGED: &str = "compose:changed";
    /// Shared conversations changed: shared, joined, stopped, or a document saved.
    pub const TEAM_CHANGED: &str = "team:changed";
    /// A conversation's assignee or team notes changed on a shared inbox (ADR-0063). Payload: `{ threadId }`.
    pub const INBOX_TEAM_CHANGED: &str = "inbox-team:changed";
}
