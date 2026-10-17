//! Tauri shell (desktop, and phones after the ADR-0002 spike): a thin host
//! around `pim-app`. It supplies what only Tauri can (events to the webview,
//! system notifications, opening links and files, the OS keychain) and
//! routes every UI call through one `core` command to `pim_app::dispatch`,
//! the same entry point the web gateway uses (ADR-0016).

mod menu_bar;

use std::path::{Path, PathBuf};

use pim_app::{AppHandle, AppState, Host, Output, Shared, secrets::SecretStore};
use tauri::ipc::{InvokeResponseBody, Response};
use tauri::{Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

struct TauriHost(tauri::AppHandle, menu_bar::InTray);

impl Host for TauriHost {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        let _ = self.0.emit(event, payload);
    }

    fn notify(&self, title: &str, body: &str) -> Result<(), String> {
        self.0.notification().builder().title(title).body(body).show().map_err(|e| e.to_string())
    }

    fn open_url(&self, url: &str) -> Result<(), String> {
        self.0.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
    }

    fn download_dir(&self) -> Result<PathBuf, String> {
        self.0.path().download_dir().map_err(|e| format!("no Downloads folder: {e}"))
    }

    fn open_path(&self, path: &Path) -> Result<(), String> {
        self.0.opener().open_path(path.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
    }

    // Tray and window calls belong on the main thread (macOS requires it).
    fn menu_bar(&self, state: &pim_app::menu_bar::MenuBarState) {
        let (app, in_tray, state) = (self.0.clone(), self.1.clone(), state.clone());
        let _ = self.0.run_on_main_thread(move || menu_bar::draw(&app, &in_tray, &state));
    }

    fn show_app(&self, jump: Option<serde_json::Value>) -> Result<(), String> {
        let app = self.0.clone();
        self.0.run_on_main_thread(move || menu_bar::show_main(&app, jump)).map_err(|e| e.to_string())
    }
}

/// Account secrets in the OS keychain: macOS/iOS Keychain, Windows
/// Credential Manager, Secret Service on Linux.
struct Keychain;

const SERVICE: &str = "design.snds.mailbird";

impl SecretStore for Keychain {
    fn get(&self, key: &str) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new(SERVICE, key).map_err(|e| format!("keychain unavailable: {e}"))?;
        match entry.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("couldn't read from the keychain: {e}")),
        }
    }

    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(SERVICE, key).map_err(|e| format!("keychain unavailable: {e}"))?;
        entry.set_password(value).map_err(|e| format!("couldn't save to the keychain: {e}"))
    }

    fn delete(&self, key: &str) {
        if let Ok(e) = keyring::Entry::new(SERVICE, key) {
            let _ = e.delete_credential();
        }
    }
}

/// Every UI call: a command name and its arguments, as `client.ts` sends them.
#[tauri::command]
async fn core(app: State<'_, AppHandle>, state: State<'_, Shared>, name: String, args: serde_json::Value) -> Result<Response, String> {
    Ok(match pim_app::dispatch(app.inner(), state.inner(), &name, args).await? {
        Output::Json(v) => Response::new(InvokeResponseBody::Json(v.to_string())),
        // Attachments travel as raw bytes (an ArrayBuffer in the UI).
        Output::Bytes(b) => Response::new(b),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let in_tray = menu_bar::InTray::default();
    let closing = in_tray.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(move |app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())?;
            }
            pim_app::secrets::install(Box::new(Keychain));
            let data_dir = app.path().app_data_dir()?;
            let state = AppState::open(&data_dir)?;
            // The locked-notes key is also kept in the shared identity (ADR-0051).
            if let Some(config) = pim_app::identity::desktop_config(&data_dir) {
                state.enable_identity(config);
            }
            let handle = AppHandle::new(TauriHost(app.handle().clone(), in_tray.clone()));
            app.manage(state.clone());
            app.manage(handle.clone());
            // Inside Tauri's async runtime: the workers spawn Tokio tasks.
            tauri::async_runtime::spawn(async move { pim_app::workers::start(handle, state) });
            Ok(())
        })
        // With the menu-bar calendar up, closing the window keeps Mailbird
        // running there (ADR-0054); the mini calendar closes when you click away.
        .on_window_event(move |window, event| match (window.label(), event) {
            (menu_bar::MAIN, tauri::WindowEvent::CloseRequested { api, .. }) if closing.get() => {
                api.prevent_close();
                let _ = window.hide();
            }
            (menu_bar::MINI, tauri::WindowEvent::Focused(false)) => {
                let _ = window.hide();
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![core])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // macOS: clicking the Dock icon brings a hidden window back.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                menu_bar::show_main(app, None);
            }
            let _ = (app, event);
        });
}
