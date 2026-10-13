use pim_core::{Capabilities, Provider};

/// Exposes the core's capability matrix to the web UI over Tauri IPC.
/// The same call will be served by the web gateway, so the UI stays shell-agnostic.
#[tauri::command]
fn provider_capabilities(provider: Provider) -> Capabilities {
  provider.capabilities()
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
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![provider_capabilities])
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}
