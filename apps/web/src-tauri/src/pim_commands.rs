//! IPC commands for calendars and contacts. Edits land in the local store
//! at once (so the UI updates instantly) and reach the server on the next
//! DAV pass, which each edit schedules.

use pim_core::{Address, Collection, CollectionKind, ContactDetail, ContactInput, ContactSummary, EventDetail, EventInput, Occurrence};
use tauri::{AppHandle, Emitter, State};

use crate::commands::{Res, with_store};
use crate::{Shared, events, workers};

/// After a local edit: tell the UI, then push it.
fn edited(app: &AppHandle, state: &Shared) {
    let _ = app.emit(events::PIM_CHANGED, ());
    workers::dav_sync_soon(app, state);
}

/// The webview reports the device zone on launch; all-day events follow it.
#[tauri::command]
pub fn set_time_zone(state: State<'_, Shared>, tz: String) -> Res<()> {
    with_store(&state, |s| s.set_time_zone(&tz))
}

#[tauri::command]
pub fn list_collections(state: State<'_, Shared>, kind: CollectionKind) -> Res<Vec<Collection>> {
    with_store(&state, |s| s.collections(kind))
}

#[tauri::command]
pub fn set_collection_hidden(app: AppHandle, state: State<'_, Shared>, id: String, hidden: bool) -> Res<()> {
    with_store(&state, |s| s.set_collection_hidden(&id, hidden))?;
    let _ = app.emit(events::PIM_CHANGED, ());
    Ok(())
}

#[tauri::command]
pub fn list_occurrences(state: State<'_, Shared>, from: i64, to: i64) -> Res<Vec<Occurrence>> {
    with_store(&state, |s| s.occurrences(from, to))
}

#[tauri::command]
pub fn get_event(state: State<'_, Shared>, id: String, start: Option<i64>) -> Res<EventDetail> {
    with_store(&state, |s| s.event(&id, start))
}

#[tauri::command]
pub fn create_event(app: AppHandle, state: State<'_, Shared>, input: EventInput) -> Res<EventDetail> {
    let e = with_store(&state, |s| s.create_event(&input))?;
    edited(&app, &state);
    Ok(e)
}

#[tauri::command]
pub fn update_event(app: AppHandle, state: State<'_, Shared>, id: String, input: EventInput) -> Res<EventDetail> {
    let e = with_store(&state, |s| s.update_event(&id, &input))?;
    edited(&app, &state);
    Ok(e)
}

#[tauri::command]
pub fn delete_event(app: AppHandle, state: State<'_, Shared>, id: String, occurrence: Option<i64>) -> Res<()> {
    with_store(&state, |s| s.delete_event(&id, occurrence))?;
    edited(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn list_contacts(state: State<'_, Shared>, search: Option<String>) -> Res<Vec<ContactSummary>> {
    with_store(&state, |s| s.contacts(search.as_deref()))
}

#[tauri::command]
pub fn get_contact(state: State<'_, Shared>, id: String) -> Res<ContactDetail> {
    with_store(&state, |s| s.contact(&id))
}

#[tauri::command]
pub fn create_contact(app: AppHandle, state: State<'_, Shared>, input: ContactInput) -> Res<ContactDetail> {
    let c = with_store(&state, |s| s.create_contact(&input))?;
    edited(&app, &state);
    Ok(c)
}

#[tauri::command]
pub fn update_contact(app: AppHandle, state: State<'_, Shared>, id: String, input: ContactInput) -> Res<ContactDetail> {
    let c = with_store(&state, |s| s.update_contact(&id, &input))?;
    edited(&app, &state);
    Ok(c)
}

#[tauri::command]
pub fn delete_contact(app: AppHandle, state: State<'_, Shared>, id: String) -> Res<()> {
    with_store(&state, |s| s.delete_contact(&id))?;
    edited(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn duplicate_contacts(state: State<'_, Shared>) -> Res<Vec<Vec<ContactSummary>>> {
    with_store(&state, |s| s.duplicate_contacts())
}

#[tauri::command]
pub fn merge_contacts(app: AppHandle, state: State<'_, Shared>, primary: String, others: Vec<String>) -> Res<ContactDetail> {
    let c = with_store(&state, |s| s.merge_contacts(&primary, &others))?;
    edited(&app, &state);
    Ok(c)
}

/// Composer autocomplete from contacts.
#[tauri::command]
pub fn suggest_recipients(state: State<'_, Shared>, prefix: String) -> Res<Vec<Address>> {
    with_store(&state, |s| s.contact_emails(&prefix, 8))
}

#[tauri::command]
pub async fn sync_pim_now(app: AppHandle, state: State<'_, Shared>) -> Res<()> {
    workers::sync_dav_all(&app, state.inner()).await;
    Ok(())
}
