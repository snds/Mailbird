//! IPC commands for calendars and contacts. Edits land in the local store
//! at once (so the UI updates instantly) and reach the server on the next
//! DAV pass, which each edit schedules.

use pim_core::{
    Address, Collection, CollectionKind, ContactDetail, ContactInput, ContactSummary, EditScope, EventDetail, EventInput, Invite, InviteResponse, Occurrence,
};
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

/// `scope` and `occurrence` (its `originalStart`) pick which occurrences of a series change.
#[tauri::command]
pub fn update_event(app: AppHandle, state: State<'_, Shared>, id: String, input: EventInput, scope: Option<EditScope>, occurrence: Option<i64>) -> Res<EventDetail> {
    let e = with_store(&state, |s| s.update_event(&id, &input, scope.unwrap_or_default(), occurrence))?;
    edited(&app, &state);
    Ok(e)
}

#[tauri::command]
pub fn delete_event(app: AppHandle, state: State<'_, Shared>, id: String, occurrence: Option<i64>, scope: Option<EditScope>) -> Res<()> {
    // Older callers passed an occurrence alone to mean "just this one".
    let scope = scope.unwrap_or(if occurrence.is_some() { EditScope::This } else { EditScope::All });
    with_store(&state, |s| s.delete_event(&id, occurrence, scope))?;
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

/// After answering or applying an invitation: calendars, the message's card,
/// and the outbox (a reply may be queued) all changed.
fn invite_changed(app: &AppHandle, state: &Shared) {
    let _ = app.emit(events::MAIL_CHANGED, ());
    let _ = app.emit(events::OUTBOX_CHANGED, ());
    edited(app, state);
}

#[tauri::command]
pub fn respond_to_invite(app: AppHandle, state: State<'_, Shared>, message_id: String, response: InviteResponse, calendar_id: Option<String>) -> Res<Invite> {
    let inv = with_store(&state, |s| s.respond_to_invite(&message_id, response, calendar_id.as_deref()))?;
    invite_changed(&app, &state);
    Ok(inv)
}

/// Applies a cancellation or a guest's reply from a message.
#[tauri::command]
pub fn apply_invite_update(app: AppHandle, state: State<'_, Shared>, message_id: String) -> Res<Invite> {
    let inv = with_store(&state, |s| s.apply_invite_update(&message_id))?;
    invite_changed(&app, &state);
    Ok(inv)
}

#[tauri::command]
pub fn event_guests(state: State<'_, Shared>, id: String) -> Res<Vec<Address>> {
    with_store(&state, |s| s.event_guests(&id))
}
