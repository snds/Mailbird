//! Copy by reference (ADR-0070): the core puts a secret on the clipboard
//! itself, so its bytes never reach the UI, and later clears it only if the
//! clipboard still holds what the core put there.

use std::sync::Mutex;

use ring::digest;
use serde::Serialize;

use crate::{AppHandle, commands::Res};

/// The digest of the last secret the core copied. One clipboard per process.
static COPIED: Mutex<Option<String>> = Mutex::new(None);

fn digest_hex(text: &str) -> String {
    digest::digest(&digest::SHA256, text.as_bytes()).as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

/// What the UI gets back from a copy: the digest, never the secret.
#[derive(Debug, Serialize)]
pub struct CopyRef {
    pub hash: String,
}

pub(crate) fn copy_secret(app: &AppHandle, text: &str) -> Res<CopyRef> {
    app.clipboard_write(text)?;
    let hash = digest_hex(text);
    *COPIED.lock().expect("clipboard lock") = Some(hash.clone());
    Ok(CopyRef { hash })
}

/// Does the clipboard still hold what the core copied? Only ever about the
/// core's own copy, so a page can't use it to test guesses at the clipboard.
pub fn clipboard_holds(app: &AppHandle, hash: String) -> Res<bool> {
    if COPIED.lock().expect("clipboard lock").as_deref() != Some(hash.as_str()) {
        return Ok(false);
    }
    Ok(digest_hex(&app.clipboard_read()?) == hash)
}

/// Clears the core's copy. Something copied since stays; if the clipboard
/// can't be read, it's cleared anyway. Returns whether it cleared.
pub fn clear_clipboard(app: &AppHandle) -> Res<bool> {
    let Some(hash) = COPIED.lock().expect("clipboard lock").take() else { return Ok(false) };
    if app.clipboard_read().is_ok_and(|now| digest_hex(&now) != hash) {
        return Ok(false);
    }
    app.clipboard_write("")?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::sync::Arc;

    use super::*;
    use crate::host::Host;

    struct Board(Arc<Mutex<String>>);

    impl Host for Board {
        fn emit(&self, _: &str, _: serde_json::Value) {}
        fn notify(&self, _: &str, _: &str) -> Result<(), String> {
            Ok(())
        }
        fn open_url(&self, _: &str) -> Result<(), String> {
            Ok(())
        }
        fn download_dir(&self) -> Result<PathBuf, String> {
            Err("none".into())
        }
        fn open_path(&self, _: &Path) -> Result<(), String> {
            Ok(())
        }
        fn clipboard_write(&self, text: &str) -> Result<(), String> {
            *self.0.lock().unwrap() = text.into();
            Ok(())
        }
        fn clipboard_read(&self) -> Result<String, String> {
            Ok(self.0.lock().unwrap().clone())
        }
    }

    #[test]
    fn a_copy_clears_itself_and_nothing_else() {
        let board = Arc::new(Mutex::new(String::new()));
        let app = AppHandle::new(Board(board.clone()));
        let r = copy_secret(&app, "the sync key").unwrap();
        assert_eq!(r.hash.len(), 64);
        assert_eq!(*board.lock().unwrap(), "the sync key");
        assert!(clipboard_holds(&app, r.hash.clone()).unwrap());
        assert!(!clipboard_holds(&app, digest_hex("a guess")).unwrap(), "only the core's own copy");
        assert!(clear_clipboard(&app).unwrap());
        assert_eq!(*board.lock().unwrap(), "");
        assert!(!clipboard_holds(&app, r.hash).unwrap(), "forgotten once cleared");

        // Something copied since stays.
        copy_secret(&app, "the sync key").unwrap();
        *board.lock().unwrap() = "a shopping list".into();
        assert!(!clear_clipboard(&app).unwrap());
        assert_eq!(*board.lock().unwrap(), "a shopping list");
        assert!(!clear_clipboard(&app).unwrap(), "nothing of ours to clear");
    }
}
