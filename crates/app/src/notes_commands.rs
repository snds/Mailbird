//! IPC commands for notes. The editor saves Markdown plus its Yjs state;
//! the web layer runs the Yjs sync with the relay itself (ADR-0012), and
//! uses the record commands to keep the shared index in step.

use pim_core::{ImportFile, ImportReport, NoteDetail, NoteInput, NoteLink, NoteMeta, NoteQuery, NoteRecord, NoteSummary, NoteTarget, TagCount};
use serde::{Deserialize, Serialize};
use crate::host::AppHandle;

use crate::commands::{Res, with_store};
use crate::{Shared, events, secrets};

const RELAY_URL: &str = "notes_relay_url";
const RELAY_SECRET: &str = "notes-relay";

/// Locked notes lock again after this long without being used (ADR-0043).
const AUTO_LOCK: std::time::Duration = std::time::Duration::from_secs(10 * 60);
const LOCKED: &str = "Locked notes are locked. Enter your passphrase to open them.";

fn changed(app: &AppHandle) {
    let _ = app.emit(events::NOTES_CHANGED, ());
}

pub fn list_notes(state: &Shared, query: NoteQuery) -> Res<Vec<NoteSummary>> {
    with_store(state, |s| s.notes(&query))
}

pub fn get_note(state: &Shared, id: String) -> Res<NoteDetail> {
    with_store(state, |s| s.note(&id))
}

pub fn create_note(app: AppHandle, state: &Shared, input: NoteInput) -> Res<NoteDetail> {
    let n = with_store(state, |s| s.create_note(&input))?;
    changed(&app);
    Ok(n)
}

/// `touch: false` stores another device's text without marking it edited here.
pub fn save_note_body(app: AppHandle, state: &Shared, id: String, markdown: String, ydoc: Option<String>, touch: bool) -> Res<()> {
    with_store(state, |s| s.save_note_body(&id, &markdown, ydoc.as_deref(), touch))?;
    changed(&app);
    Ok(())
}

pub fn set_note_meta(app: AppHandle, state: &Shared, id: String, meta: NoteMeta) -> Res<NoteSummary> {
    let n = with_store(state, |s| s.set_note_meta(&id, &meta))?;
    changed(&app);
    Ok(n)
}

pub fn delete_note(app: AppHandle, state: &Shared, id: String) -> Res<()> {
    with_store(state, |s| s.delete_note(&id))?;
    changed(&app);
    Ok(())
}

pub fn restore_note(app: AppHandle, state: &Shared, id: String) -> Res<()> {
    with_store(state, |s| s.restore_note(&id))?;
    changed(&app);
    Ok(())
}

pub fn note_tags(state: &Shared) -> Res<Vec<TagCount>> {
    with_store(state, |s| s.note_tags())
}

/// Checklist items across notes (ADR-0028).
pub fn note_tasks(state: &Shared, done: bool) -> Res<Vec<pim_core::NoteTask>> {
    with_store(state, |s| s.note_tasks(done))
}

/// Smart folders (ADR-0042), each with how many notes are in it.
pub fn note_folders(state: &Shared) -> Res<Vec<pim_core::NoteFolder>> {
    with_store(state, |s| s.note_folders())
}

pub fn save_note_folder(app: AppHandle, state: &Shared, id: Option<String>, input: pim_core::NoteFolderInput) -> Res<pim_core::NoteFolder> {
    let f = with_store(state, |s| s.save_note_folder(id.as_deref(), &input))?;
    let _ = app.emit(events::NOTES_CHANGED, ());
    Ok(f)
}

pub fn delete_note_folder(app: AppHandle, state: &Shared, id: String) -> Res<()> {
    with_store(state, |s| s.delete_note_folder(&id))?;
    let _ = app.emit(events::NOTES_CHANGED, ());
    Ok(())
}

pub fn notes_prefs(state: &Shared) -> Res<pim_core::NotesPrefs> {
    with_store(state, |s| s.notes_prefs())
}

pub fn set_notes_prefs(app: AppHandle, state: &Shared, prefs: pim_core::NotesPrefs) -> Res<pim_core::NotesPrefs> {
    let out = with_store(state, |s| s.set_notes_prefs(&prefs))?;
    changed(&app);
    Ok(out)
}

/// The notes a list would show, as a map with their links (ADR-0053).
pub fn note_graph(state: &Shared, query: NoteQuery) -> Res<pim_core::NoteGraph> {
    with_store(state, |s| s.note_graph(&query))
}

/// Notes that link here with `[[title]]` (ADR-0034).
pub fn note_backlinks(state: &Shared, id: String) -> Res<Vec<NoteSummary>> {
    with_store(state, |s| s.note_backlinks(&id))
}

/// Notes that link to a title, except one: the links a rename would update (ADR-0035).
pub fn notes_linking_to(state: &Shared, title: String, except: Option<String>) -> Res<Vec<NoteSummary>> {
    with_store(state, |s| s.notes_linking_to(&title, except.as_deref()))
}

/// The note a `[[title]]` link opens, if there is one.
pub fn find_note(state: &Shared, title: String) -> Res<Option<String>> {
    with_store(state, |s| s.find_note(&title))
}

/// Every note as a Markdown file, for the browser to package (ADR-0034).
pub fn export_notes(state: &Shared) -> Res<Vec<pim_core::ExportedNote>> {
    with_store(state, |s| s.export_notes())
}

/// Writes every note into a new folder in Downloads; returns where it went.
pub fn save_notes_export(app: AppHandle, state: &Shared) -> Res<String> {
    let files = with_store(state, |s| s.export_notes())?;
    // A fresh folder each time ("Notes", then "Notes (1)"…), never mixed into an old one.
    let name = "Notes".to_string();
    let dir = crate::commands::unique_path(&app.download_dir()?, &name);
    std::fs::create_dir_all(&dir).map_err(|e| format!("couldn't make the {name} folder: {e}"))?;
    for f in &files {
        let path = dir.join(&f.path);
        let bytes = match &f.data_base64 {
            Some(b) => base64::Engine::decode(&base64::engine::general_purpose::STANDARD, b).map_err(|_| format!("{} is damaged", f.path))?,
            None => f.contents.clone().into_bytes(),
        };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("couldn't make a folder for {}: {e}", f.path))?;
        }
        std::fs::write(&path, bytes).map_err(|e| format!("couldn't save {}: {e}", f.path))?;
    }
    Ok(dir.to_string_lossy().into_owned())
}

pub fn note_link_for(state: &Shared, target: NoteTarget) -> Res<Option<NoteLink>> {
    with_store(state, |s| s.note_link_for(&target))
}

pub fn import_notes(app: AppHandle, state: &Shared, files: Vec<ImportFile>) -> Res<ImportReport> {
    let r = with_store(state, |s| s.import_notes(&files))?;
    changed(&app);
    Ok(r)
}

pub fn note_records(state: &Shared) -> Res<Vec<NoteRecord>> {
    with_store(state, |s| s.note_records())
}

/// Returns the ids that changed.
pub fn apply_note_records(app: AppHandle, state: &Shared, records: Vec<NoteRecord>) -> Res<Vec<String>> {
    let ids = with_store(state, |s| {
        let mut ids = Vec::new();
        for r in &records {
            if s.apply_note_record(r)? {
                ids.push(r.id.clone());
            }
        }
        Ok(ids)
    })?;
    if !ids.is_empty() {
        changed(&app);
    }
    Ok(ids)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayConfig {
    pub url: String,
    pub token: String,
}

/// The notes relay, if one is set up. The token lives in the keychain.
pub fn get_notes_relay(state: &Shared) -> Res<Option<RelayConfig>> {
    let Some(url) = with_store(state, |s| s.setting(RELAY_URL))? else { return Ok(None) };
    Ok(Some(RelayConfig { url, token: secrets::get(RELAY_SECRET).unwrap_or_default() }))
}

pub fn set_notes_relay(state: &Shared, relay: Option<RelayConfig>) -> Res<()> {
    match relay {
        Some(r) => {
            secrets::set(RELAY_SECRET, &r.token)?;
            with_store(state, |s| s.set_setting(RELAY_URL, Some(&r.url)))
        }
        None => {
            secrets::delete(RELAY_SECRET);
            with_store(state, |s| s.set_setting(RELAY_URL, None))
        }
    }
}

// ── Locked notes (ADR-0043) ─────────────────────────────────────────────────

/// The key, if unlocked and used recently; using it keeps it alive.
fn key(state: &Shared) -> Res<pim_core::NotesKey> {
    let mut slot = state.notes_key.lock().map_err(|_| "the app state is unavailable".to_string())?;
    match slot.as_mut() {
        Some((k, at)) if at.elapsed() < AUTO_LOCK => {
            *at = std::time::Instant::now();
            Ok(k.clone())
        }
        _ => {
            *slot = None;
            Err(LOCKED.into())
        }
    }
}

fn keep(state: &Shared, key: pim_core::NotesKey) {
    if let Ok(mut slot) = state.notes_key.lock() {
        *slot = Some((key, std::time::Instant::now()));
    }
}

pub fn notes_lock(state: &Shared) -> Res<pim_core::NotesLockInfo> {
    let mut info = with_store(state, |s| s.notes_lock())?;
    info.unlocked = key(state).is_ok();
    info.identity = info.set && crate::identity::available(state);
    Ok(info)
}

/// Sets the passphrase, or changes it while unlocked; leaves notes unlocked.
pub fn set_notes_passphrase(app: AppHandle, state: &Shared, passphrase: String, hint: Option<String>) -> Res<pim_core::NotesLockInfo> {
    let current = key(state).ok();
    let k = with_store(state, |s| s.set_notes_passphrase(current.as_ref(), &passphrase, hint.as_deref()))?;
    crate::identity::link_quietly(state, &k);
    keep(state, k);
    changed(&app);
    notes_lock(state)
}

pub fn unlock_notes(state: &Shared, passphrase: String) -> Res<pim_core::NotesLockInfo> {
    let k = with_store(state, |s| s.unlock_notes(&passphrase))?;
    crate::identity::link_quietly(state, &k);
    keep(state, k);
    notes_lock(state)
}

/// Opens locked notes with the shared identity instead of the passphrase (ADR-0051).
pub fn unlock_notes_with_identity(state: &Shared) -> Res<pim_core::NotesLockInfo> {
    let k = crate::identity::unlock_with_identity(state)?;
    keep(state, k);
    notes_lock(state)
}

/// Forgets the key now: every locked note closes.
pub fn lock_notes_now(app: AppHandle, state: &Shared) -> Res<()> {
    if let Ok(mut slot) = state.notes_key.lock() {
        *slot = None;
    }
    changed(&app);
    Ok(())
}

pub fn lock_note(app: AppHandle, state: &Shared, id: String) -> Res<()> {
    let k = key(state)?;
    with_store(state, |s| s.lock_note(&id, &k))?;
    changed(&app);
    Ok(())
}

pub fn remove_note_lock(app: AppHandle, state: &Shared, id: String) -> Res<NoteDetail> {
    let k = key(state)?;
    let n = with_store(state, |s| s.remove_note_lock(&id, &k))?;
    changed(&app);
    Ok(n)
}

pub fn open_locked_note(state: &Shared, id: String) -> Res<NoteDetail> {
    let k = key(state)?;
    with_store(state, |s| s.open_locked_note(&id, &k))
}

pub fn save_locked_note(app: AppHandle, state: &Shared, id: String, markdown: String, touch: bool) -> Res<()> {
    let k = key(state)?;
    with_store(state, |s| s.save_locked_note(&id, &markdown, &k, touch))?;
    if touch {
        changed(&app);
    }
    Ok(())
}

/// The passphrase's salt and check, for the relay's index.
pub fn notes_lock_setting(state: &Shared) -> Res<Option<pim_core::NotesLockSetting>> {
    with_store(state, |s| s.notes_lock_setting())
}

pub fn apply_notes_lock_setting(app: AppHandle, state: &Shared, setting: pim_core::NotesLockSetting) -> Res<bool> {
    let changed_here = with_store(state, |s| s.apply_notes_lock_setting(&setting))?;
    if changed_here {
        // A new passphrase elsewhere: the old key here opens nothing now.
        if let Ok(mut slot) = state.notes_key.lock() {
            *slot = None;
        }
        changed(&app);
    }
    Ok(changed_here)
}

// ── Images in notes (ADR-0044) ──────────────────────────────────────────────

/// Adds an image to a note. A locked note's image is sealed, so it needs the
/// notes unlocked; an ordinary note's doesn't.
pub fn add_note_file(app: AppHandle, state: &Shared, note_id: String, mime: String, data_base64: String, width: Option<u32>, height: Option<u32>) -> Res<pim_core::NoteFile> {
    let k = key(state).ok();
    let f = with_store(state, |s| s.add_note_file(&note_id, &mime, &data_base64, width, height, k.as_ref()))?;
    changed(&app);
    Ok(f)
}

pub fn note_file(state: &Shared, id: String) -> Res<pim_core::NoteFileData> {
    let k = key(state).ok();
    with_store(state, |s| s.note_file(&id, k.as_ref()))
}

pub fn note_files(state: &Shared, note_id: String) -> Res<Vec<pim_core::NoteFile>> {
    with_store(state, |s| s.note_files(&note_id))
}

/// Every image's facts, for the relay's index.
pub fn note_file_records(state: &Shared) -> Res<Vec<pim_core::NoteFile>> {
    with_store(state, |s| s.note_file_records())
}

/// An image's bytes as stored (sealed stays sealed), for the relay.
pub fn note_file_raw(state: &Shared, id: String) -> Res<String> {
    with_store(state, |s| s.note_file_raw(&id))
}

pub fn put_note_file(app: AppHandle, state: &Shared, file: pim_core::NoteFile, raw_base64: String) -> Res<bool> {
    let kept = with_store(state, |s| s.put_note_file(&file, &raw_base64))?;
    if kept {
        changed(&app);
    }
    Ok(kept)
}

// ── Text in images (ADR-0045) ───────────────────────────────────────────────

/// Keeps the text found in an image; a locked note's needs the notes unlocked.
pub fn set_note_file_text(app: AppHandle, state: &Shared, id: String, text: String) -> Res<pim_core::NoteFile> {
    let k = key(state).ok();
    let f = with_store(state, |s| s.set_note_file_text(&id, &text, k.as_ref()))?;
    changed(&app);
    Ok(f)
}

/// Images whose text no one has read yet, for the app to read on the device.
pub fn note_files_without_text(state: &Shared, limit: u32) -> Res<Vec<pim_core::NoteFile>> {
    with_store(state, |s| s.note_files_without_text(limit.min(50)))
}
