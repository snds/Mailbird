//! IPC commands for calendars and contacts. Edits land in the local store
//! at once (so the UI updates instantly) and reach the server on the next
//! DAV pass, which each edit schedules.

use pim_core::{
    Address, Collection, CollectionKind, ContactDetail, ContactInput, ContactSummary, EditScope, EventDetail, EventInput, Invite, InviteResponse, Occurrence,
};
use crate::host::AppHandle;

use crate::commands::{Res, with_store};
use crate::{Shared, events, workers};

/// After a local edit: tell the UI, then push it.
fn edited(app: &AppHandle, state: &Shared) {
    let _ = app.emit(events::PIM_CHANGED, ());
    workers::dav_sync_soon(app, state);
}

/// The webview reports the device zone on launch; all-day events follow it.
pub fn set_time_zone(state: &Shared, tz: String) -> Res<()> {
    with_store(state, |s| s.set_time_zone(&tz))
}

pub fn list_collections(state: &Shared, kind: CollectionKind) -> Res<Vec<Collection>> {
    with_store(state, |s| s.collections(kind))
}

pub fn set_collection_hidden(app: AppHandle, state: &Shared, id: String, hidden: bool) -> Res<()> {
    with_store(state, |s| s.set_collection_hidden(&id, hidden))?;
    let _ = app.emit(events::PIM_CHANGED, ());
    Ok(())
}

pub fn list_occurrences(state: &Shared, from: i64, to: i64) -> Res<Vec<Occurrence>> {
    with_store(state, |s| s.occurrences(from, to))
}

pub fn get_event(state: &Shared, id: String, start: Option<i64>) -> Res<EventDetail> {
    with_store(state, |s| s.event(&id, start))
}

pub fn create_event(app: AppHandle, state: &Shared, input: EventInput) -> Res<EventDetail> {
    let e = with_store(state, |s| s.create_event(&input))?;
    edited(&app, state);
    Ok(e)
}

/// `scope` and `occurrence` (its `originalStart`) pick which occurrences of a series change.
pub fn update_event(app: AppHandle, state: &Shared, id: String, input: EventInput, scope: Option<EditScope>, occurrence: Option<i64>) -> Res<EventDetail> {
    let e = with_store(state, |s| s.update_event(&id, &input, scope.unwrap_or_default(), occurrence))?;
    edited(&app, state);
    Ok(e)
}

pub fn delete_event(app: AppHandle, state: &Shared, id: String, occurrence: Option<i64>, scope: Option<EditScope>) -> Res<()> {
    // Older callers passed an occurrence alone to mean "just this one".
    let scope = scope.unwrap_or(if occurrence.is_some() { EditScope::This } else { EditScope::All });
    with_store(state, |s| s.delete_event(&id, occurrence, scope))?;
    edited(&app, state);
    Ok(())
}

pub fn list_contacts(state: &Shared, search: Option<String>, label: Option<String>, group: Option<String>) -> Res<Vec<ContactSummary>> {
    with_store(state, |s| s.contacts_in(search.as_deref(), label.as_deref(), group.as_deref()))
}

/// Your scheduling links (ADR-0026).
pub fn booking_links(state: &Shared) -> Res<Vec<pim_core::BookingLink>> {
    with_store(state, |s| s.booking_links())
}

pub fn save_booking_link(state: &Shared, id: Option<String>, input: pim_core::BookingLinkInput) -> Res<pim_core::BookingLink> {
    with_store(state, |s| s.save_booking_link(id.as_deref(), &input))
}

pub fn delete_booking_link(state: &Shared, id: String) -> Res<()> {
    with_store(state, |s| s.delete_booking_link(&id))
}

/// The public page's data: the only thing a visitor can read.
pub fn public_booking(state: &Shared, token: String) -> Res<pim_core::PublicBooking> {
    with_store(state, |s| s.public_booking(&token))
}

/// A visitor's booking: the only thing a visitor can write.
pub fn book_slot(app: AppHandle, state: &Shared, token: String, request: pim_core::BookingRequest) -> Res<pim_core::Booked> {
    let done = with_store(state, |s| s.book(&token, &request))?;
    edited(&app, state);
    Ok(done)
}

/// Holidays and moon phases you can add (ADR-0024).
pub fn interesting_calendars(state: &Shared) -> Res<Vec<pim_core::InterestingCalendar>> {
    with_store(state, |s| s.interesting_calendars())
}

pub fn add_interesting_calendar(app: AppHandle, state: &Shared, id: String) -> Res<()> {
    with_store(state, |s| s.add_interesting_calendar(&id))?;
    let _ = app.emit(events::PIM_CHANGED, ());
    Ok(())
}

pub fn remove_interesting_calendar(app: AppHandle, state: &Shared, id: String) -> Res<()> {
    with_store(state, |s| s.remove_interesting_calendar(&id))?;
    let _ = app.emit(events::PIM_CHANGED, ());
    Ok(())
}

/// Smart groups with their member counts (ADR-0023).
pub fn smart_groups(state: &Shared) -> Res<Vec<pim_core::SmartGroup>> {
    with_store(state, |s| s.smart_groups())
}

pub fn save_smart_group(app: AppHandle, state: &Shared, id: Option<String>, input: pim_core::SmartGroupInput) -> Res<pim_core::SmartGroup> {
    let g = with_store(state, |s| s.save_smart_group(id.as_deref(), &input))?;
    let _ = app.emit(events::PIM_CHANGED, ());
    Ok(g)
}

pub fn delete_smart_group(app: AppHandle, state: &Shared, id: String) -> Res<()> {
    with_store(state, |s| s.delete_smart_group(&id))?;
    let _ = app.emit(events::PIM_CHANGED, ());
    Ok(())
}

/// "Since a time" or "after a mark" (the mark undoes an earlier restore).
fn restore_point(since: Option<i64>, after: Option<i64>) -> Res<pim_core::RestorePoint> {
    match (since, after) {
        (_, Some(m)) => Ok(pim_core::RestorePoint::After(m)),
        (Some(t), None) => Ok(pim_core::RestorePoint::Since(t)),
        (None, None) => Err("say when to restore to".into()),
    }
}

pub fn contacts_restore_preview(state: &Shared, since: Option<i64>, after: Option<i64>) -> Res<pim_core::ContactsRestore> {
    let point = restore_point(since, after)?;
    with_store(state, |s| s.contacts_restore_preview(point))
}

pub fn restore_contacts(app: AppHandle, state: &Shared, since: Option<i64>, after: Option<i64>) -> Res<pim_core::ContactsRestored> {
    let point = restore_point(since, after)?;
    let done = with_store(state, |s| s.restore_contacts(point))?;
    edited(&app, state);
    Ok(done)
}

/// Every label in use, with counts (ADR-0020).
pub fn contact_labels(state: &Shared) -> Res<Vec<pim_core::ContactLabel>> {
    with_store(state, |s| s.contact_labels())
}

/// Recently deleted contacts (30 days).
pub fn deleted_contacts(state: &Shared) -> Res<Vec<pim_core::DeletedContact>> {
    with_store(state, |s| s.deleted_contacts())
}

pub fn restore_contact(app: AppHandle, state: &Shared, id: String) -> Res<ContactDetail> {
    let c = with_store(state, |s| s.restore_contact(&id))?;
    edited(&app, state);
    Ok(c)
}

/// The card as a `.vcf` file to save or share.
pub fn contact_vcard(state: &Shared, id: String) -> Res<pim_core::ContactExport> {
    with_store(state, |s| s.contact_vcard(&id))
}

/// Saves the card to Downloads (desktop and phones); returns where it went.
pub fn save_contact_vcard(app: AppHandle, state: &Shared, id: String) -> Res<String> {
    let file = with_store(state, |s| s.contact_vcard(&id))?;
    let path = crate::commands::unique_path(&app.download_dir()?, &crate::commands::safe_filename(&file.file_name));
    std::fs::write(&path, file.vcf).map_err(|e| format!("couldn't save {}: {e}", file.file_name))?;
    Ok(path.to_string_lossy().into_owned())
}

/// A QR code (SVG) of a short card, to scan with a phone.
pub fn contact_qr(state: &Shared, id: String) -> Res<String> {
    with_store(state, |s| s.contact_qr(&id))
}

/// A contact (or missing details) from a message's signature, if it has one.
pub fn contact_suggestion(state: &Shared, message_id: String) -> Res<Option<pim_core::ContactSuggestion>> {
    with_store(state, |s| s.contact_suggestion(&message_id))
}

/// Pasted signature text, read into a card for the editor.
pub fn parse_signature(text: String) -> pim_core::SignatureCard {
    pim_core::signature::parse_signature(&text, None)
}

pub fn get_contact(state: &Shared, id: String) -> Res<ContactDetail> {
    with_store(state, |s| s.contact(&id))
}

/// Recent conversations with a contact, and meetings they're in (ADR-0019).
pub fn contact_activity(state: &Shared, id: String) -> Res<pim_core::ContactActivity> {
    with_store(state, |s| s.contact_activity(&id))
}

/// The reminders missed while the app was closed, once: a second call gets none.
pub fn take_missed_reminders(state: &Shared) -> Vec<pim_core::DueReminder> {
    state.missed_reminders.lock().map(|mut m| std::mem::take(&mut *m)).unwrap_or_default()
}

pub fn create_contact(app: AppHandle, state: &Shared, input: ContactInput) -> Res<ContactDetail> {
    let c = with_store(state, |s| s.create_contact(&input))?;
    edited(&app, state);
    Ok(c)
}

pub fn update_contact(app: AppHandle, state: &Shared, id: String, input: ContactInput) -> Res<ContactDetail> {
    let c = with_store(state, |s| s.update_contact(&id, &input))?;
    edited(&app, state);
    Ok(c)
}

pub fn delete_contact(app: AppHandle, state: &Shared, id: String) -> Res<()> {
    with_store(state, |s| s.delete_contact(&id))?;
    edited(&app, state);
    Ok(())
}

pub fn duplicate_contacts(state: &Shared) -> Res<Vec<Vec<ContactSummary>>> {
    with_store(state, |s| s.duplicate_contacts())
}

pub fn merge_contacts(app: AppHandle, state: &Shared, primary: String, others: Vec<String>) -> Res<ContactDetail> {
    let c = with_store(state, |s| s.merge_contacts(&primary, &others))?;
    edited(&app, state);
    Ok(c)
}

/// Composer autocomplete from contacts.
pub fn suggest_recipients(state: &Shared, prefix: String) -> Res<Vec<Address>> {
    with_store(state, |s| s.contact_emails(&prefix, 8))
}

pub async fn sync_pim_now(app: AppHandle, state: &Shared) -> Res<()> {
    workers::sync_dav_all(&app, state).await;
    Ok(())
}

/// After answering or applying an invitation: calendars, the message's card,
/// and the outbox (a reply may be queued) all changed.
fn invite_changed(app: &AppHandle, state: &Shared) {
    let _ = app.emit(events::MAIL_CHANGED, ());
    let _ = app.emit(events::OUTBOX_CHANGED, ());
    edited(app, state);
}

pub fn respond_to_invite(app: AppHandle, state: &Shared, message_id: String, response: InviteResponse, calendar_id: Option<String>) -> Res<Invite> {
    let inv = with_store(state, |s| s.respond_to_invite(&message_id, response, calendar_id.as_deref()))?;
    invite_changed(&app, state);
    Ok(inv)
}

/// Applies a cancellation or a guest's reply from a message.
pub fn apply_invite_update(app: AppHandle, state: &Shared, message_id: String) -> Res<Invite> {
    let inv = with_store(state, |s| s.apply_invite_update(&message_id))?;
    invite_changed(&app, state);
    Ok(inv)
}

/// Proposes another time for an invitation (an iTIP COUNTER to the organizer, ADR-0021).
pub fn propose_time(app: AppHandle, state: &Shared, message_id: String, start: i64, end: i64, comment: Option<String>) -> Res<Invite> {
    let inv = with_store(state, |s| s.propose_time(&message_id, start, end, comment.as_deref()))?;
    invite_changed(&app, state);
    Ok(inv)
}

/// Takes a guest's proposed time: moves your event and tells everyone.
pub fn accept_counter(app: AppHandle, state: &Shared, message_id: String) -> Res<Invite> {
    let inv = with_store(state, |s| s.accept_counter(&message_id))?;
    invite_changed(&app, state);
    Ok(inv)
}

/// Keeps the original time and tells the guest.
pub fn decline_counter(app: AppHandle, state: &Shared, message_id: String) -> Res<Invite> {
    let inv = with_store(state, |s| s.decline_counter(&message_id))?;
    invite_changed(&app, state);
    Ok(inv)
}

/// Free times in your calendars (see `Store::find_times`).
pub fn find_times(state: &Shared, from: i64, minutes: u32, day_start: u32, day_end: u32, weekdays_only: bool, limit: Option<usize>) -> Res<Vec<pim_core::TimeSlot>> {
    with_store(state, |s| s.find_times(from, minutes, day_start, day_end, weekdays_only, limit.unwrap_or(6).min(20)))
}

pub fn calendar_sets(state: &Shared) -> Res<Vec<pim_core::CalendarSet>> {
    with_store(state, |s| s.calendar_sets())
}

pub fn save_calendar_set(state: &Shared, name: String) -> Res<Vec<pim_core::CalendarSet>> {
    with_store(state, |s| s.save_calendar_set(&name))
}

pub fn delete_calendar_set(state: &Shared, id: String) -> Res<Vec<pim_core::CalendarSet>> {
    with_store(state, |s| s.delete_calendar_set(&id))
}

pub fn apply_calendar_set(app: AppHandle, state: &Shared, id: String) -> Res<()> {
    with_store(state, |s| s.apply_calendar_set(&id))?;
    let _ = app.emit(events::PIM_CHANGED, ());
    Ok(())
}

pub fn event_guests(state: &Shared, id: String) -> Res<Vec<Address>> {
    with_store(state, |s| s.event_guests(&id))
}
