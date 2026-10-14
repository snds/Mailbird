//! Tauri shell: exposes `pim-core` to the web UI over IPC and runs the
//! background workers (undo-send outbox, snooze wake-ups, periodic sync).
//!
//! Locking rule: the store mutex is never held across a network await.
//! Workers read what they need, release the lock, talk to the server, then
//! lock again to write the result.

mod commands;
mod notes_commands;
mod oauth_commands;
mod pim_commands;
mod secrets;
mod workers;

use std::{
    collections::HashSet,
    sync::{Arc, Mutex, atomic::AtomicBool},
};

use pim_core::Store;
use tauri::Manager;

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
}

pub type Shared = Arc<AppState>;

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
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let store = Store::open(dir.join("mail.db"))?;
            // Somewhere to save events and contacts even with no account.
            store.ensure_local_collections()?;
            let state: Shared = Arc::new(AppState {
                store: Mutex::new(store),
                sync_lock: tokio::sync::Mutex::new(()),
                idling: Mutex::new(HashSet::new()),
                backfill_pending: AtomicBool::new(false),
                dav_lock: tokio::sync::Mutex::new(()),
                oauth_cancel: Mutex::new(None),
            });
            app.manage(state.clone());
            workers::start(app.handle().clone(), state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::provider_capabilities,
            commands::list_accounts,
            commands::add_account,
            commands::remove_account,
            commands::sync_now,
            commands::list_messages,
            commands::get_thread,
            commands::set_thread_seen,
            commands::set_thread_flagged,
            commands::set_thread_archived,
            commands::snooze_thread,
            commands::unsnooze_thread,
            commands::open_attachment,
            commands::attachment_data,
            commands::queue_send,
            commands::cancel_send,
            commands::list_outbox,
            commands::set_account_dav,
            pim_commands::set_time_zone,
            pim_commands::list_collections,
            pim_commands::set_collection_hidden,
            pim_commands::list_occurrences,
            pim_commands::get_event,
            pim_commands::create_event,
            pim_commands::update_event,
            pim_commands::delete_event,
            pim_commands::list_contacts,
            pim_commands::get_contact,
            pim_commands::create_contact,
            pim_commands::update_contact,
            pim_commands::delete_contact,
            pim_commands::duplicate_contacts,
            pim_commands::merge_contacts,
            pim_commands::suggest_recipients,
            pim_commands::sync_pim_now,
            pim_commands::respond_to_invite,
            pim_commands::apply_invite_update,
            pim_commands::event_guests,
            oauth_commands::get_oauth_client,
            oauth_commands::set_oauth_client,
            oauth_commands::add_oauth_account,
            oauth_commands::reauth_oauth_account,
            oauth_commands::cancel_oauth_sign_in,
            notes_commands::list_notes,
            notes_commands::get_note,
            notes_commands::create_note,
            notes_commands::save_note_body,
            notes_commands::set_note_meta,
            notes_commands::delete_note,
            notes_commands::restore_note,
            notes_commands::note_tags,
            notes_commands::note_link_for,
            notes_commands::import_notes,
            notes_commands::note_records,
            notes_commands::apply_note_records,
            notes_commands::get_notes_relay,
            notes_commands::set_notes_relay,
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
