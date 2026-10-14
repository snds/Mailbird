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
