//! Tauri shell: exposes `pim-core` to the web UI over IPC and runs the
//! background workers (undo-send outbox, snooze wake-ups, periodic sync).
//!
//! Locking rule: the store mutex is never held across a network await.
//! Workers read what they need, release the lock, talk to the server, then
//! lock again to write the result.

mod commands;
mod secrets;
mod workers;

use std::sync::{Arc, Mutex};

use pim_core::Store;
use tauri::Manager;

pub struct AppState {
    pub store: Mutex<Store>,
    /// One sync at a time, so two passes never race on the same cursor.
    pub sync_lock: tokio::sync::Mutex<()>,
}

pub type Shared = Arc<AppState>;

/// Events the UI listens for to refresh its queries.
pub mod events {
    pub const MAIL_CHANGED: &str = "mail:changed";
    pub const OUTBOX_CHANGED: &str = "outbox:changed";
    pub const ACCOUNTS_CHANGED: &str = "accounts:changed";
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
            let state: Shared = Arc::new(AppState {
                store: Mutex::new(store),
                sync_lock: tokio::sync::Mutex::new(()),
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
            commands::get_message,
            commands::set_seen,
            commands::set_flagged,
            commands::set_archived,
            commands::snooze,
            commands::unsnooze,
            commands::queue_send,
            commands::cancel_send,
            commands::list_outbox,
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
