//! What the app needs from wherever it runs: the Tauri shell on desktop and
//! phones, or the web gateway. Everything else is the same code.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;

pub trait Host: Send + Sync + 'static {
    /// Tells the UI something changed (see [`crate::events`]).
    fn emit(&self, event: &str, payload: serde_json::Value);
    /// Shows a system notification.
    fn notify(&self, title: &str, body: &str) -> Result<(), String>;
    /// Opens a web page in the person's browser (OAuth sign-in).
    fn open_url(&self, url: &str) -> Result<(), String>;
    /// Where saved attachments go.
    fn download_dir(&self) -> Result<PathBuf, String>;
    /// Opens a saved file with its default app.
    fn open_path(&self, path: &Path) -> Result<(), String>;
}

/// A cheap, cloneable handle to the host.
#[derive(Clone)]
pub struct AppHandle(pub Arc<dyn Host>);

impl AppHandle {
    pub fn new(host: impl Host) -> Self {
        Self(Arc::new(host))
    }

    pub fn emit<S: Serialize>(&self, event: &str, payload: S) -> Result<(), String> {
        self.0.emit(event, serde_json::to_value(payload).unwrap_or_default());
        Ok(())
    }

    pub fn notify(&self, title: &str, body: &str) -> Result<(), String> {
        self.0.notify(title, body)
    }

    pub fn open_url(&self, url: &str) -> Result<(), String> {
        self.0.open_url(url)
    }

    pub fn download_dir(&self) -> Result<PathBuf, String> {
        self.0.download_dir()
    }

    pub fn open_path(&self, path: &Path) -> Result<(), String> {
        self.0.open_path(path)
    }
}
