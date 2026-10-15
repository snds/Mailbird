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
        std::fs::write(dir.join(&f.path), &f.contents).map_err(|e| format!("couldn't save {}: {e}", f.path))?;
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
