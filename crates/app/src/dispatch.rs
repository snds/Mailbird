//! One entry point for every command, by name, with JSON arguments: what
//! the Tauri shell's single `core` command and the web gateway's `/api`
//! both call. Argument names are the UI's camelCase (`threadId`), as Tauri
//! IPC already used.

#![allow(unused_imports)]

use pim_core::net::oauth;
use pim_core::*;
use serde::Serialize;
use serde_json::Value;

use crate::notes_commands::RelayConfig;
use crate::push::PushMode;
use pim_core::net::push_relay::PushTarget;
use crate::{AppHandle, Shared, commands, compose_commands, notes_commands, sender_commands, oauth_commands, pim_commands, push, workers};

/// A command's result: JSON, or raw bytes (attachments, so a 10 MB PDF
/// isn't a 13 MB string).
pub enum Output {
    Json(Value),
    Bytes(Vec<u8>),
}

impl Output {
    fn json<T: Serialize>(v: T) -> Self {
        Output::Json(serde_json::to_value(v).unwrap_or(Value::Null))
    }
}

/// Reads named arguments (camelCase) from the JSON object. A missing
/// `Option` is `None`, as with Tauri IPC.
macro_rules! args {
    ($v:expr, $($name:ident : $t:ty),+) => {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Args { $($name: $t),+ }
        let Args { $($name),+ } = serde_json::from_value::<Args>(if $v.is_null() { Value::Object(Default::default()) } else { $v })
            .map_err(|e| format!("bad arguments: {e}"))?;
    };
}

/// Every command the UI can call.
pub const COMMANDS: &[&str] = &[
    "list_splits",
    "save_split",
    "delete_split",
    "move_split",
    "inbox_overview",
    "bundle_mark_read",
    "bundle_archive",
    "unarchive_bundle",
    "swipe_actions",
    "set_swipe_actions",
    "key_bindings",
    "set_key_bindings",
    "provider_capabilities",
    "list_accounts",
    "add_account",
    "remove_account",
    "sync_now",
    "list_messages",
    "get_thread",
    "set_thread_seen",
    "set_thread_flagged",
    "set_thread_archived",
    "snooze_thread",
    "unsnooze_thread",
    "open_attachment",
    "attachment_data",
    "queue_send",
    "cancel_send",
    "list_outbox",
    "reschedule_send",
    "set_follow_up",
    "cancel_follow_up",
    "unsubscribe",
    "list_templates",
    "save_template",
    "delete_template",
    "list_signatures",
    "set_signature",
    "screener_status",
    "set_screener",
    "decide_sender",
    "set_sender_category",
    "list_senders",
    "set_account_dav",
    "set_time_zone",
    "list_collections",
    "set_collection_hidden",
    "list_occurrences",
    "get_event",
    "create_event",
    "update_event",
    "delete_event",
    "list_contacts",
    "get_contact",
    "contact_activity",
    "sender_profile",
    "local_times",
    "contact_labels",
    "contact_copies",
    "contact_photos",
    "smart_groups",
    "interesting_calendars",
    "booking_links",
    "save_booking_link",
    "delete_booking_link",
    "public_booking",
    "book_slot",
    "managed_booking",
    "change_booking",
    "add_interesting_calendar",
    "remove_interesting_calendar",
    "set_holiday_region",
    "save_smart_group",
    "delete_smart_group",
    "contacts_restore_preview",
    "restore_contacts",
    "deleted_contacts",
    "restore_contact",
    "contact_vcard",
    "save_contact_vcard",
    "contact_qr",
    "contact_suggestion",
    "parse_signature",
    "take_missed_reminders",
    "create_contact",
    "update_contact",
    "delete_contact",
    "duplicate_contacts",
    "merge_contacts",
    "suggest_recipients",
    "sync_pim_now",
    "respond_to_invite",
    "apply_invite_update",
    "propose_time",
    "accept_counter",
    "decline_counter",
    "find_times",
    "calendar_sets",
    "save_calendar_set",
    "delete_calendar_set",
    "apply_calendar_set",
    "event_guests",
    "get_oauth_client",
    "set_oauth_client",
    "add_oauth_account",
    "reauth_oauth_account",
    "cancel_oauth_sign_in",
    "list_notes",
    "get_note",
    "create_note",
    "save_note_body",
    "set_note_meta",
    "delete_note",
    "restore_note",
    "note_tags",
    "note_backlinks",
    "find_note",
    "notes_linking_to",
    "export_notes",
    "save_notes_export",
    "note_tasks",
    "meeting_prefs",
    "set_meeting_prefs",
    "open_meeting",
    "notes_prefs",
    "note_folders",
    "notes_lock",
    "set_notes_passphrase",
    "unlock_notes",
    "unlock_notes_with_identity",
    "lock_notes_now",
    "lock_note",
    "remove_note_lock",
    "open_locked_note",
    "save_locked_note",
    "notes_lock_setting",
    "apply_notes_lock_setting",
    "add_note_file",
    "note_file",
    "note_files",
    "note_file_records",
    "note_file_raw",
    "put_note_file",
    "set_note_file_text",
    "note_files_without_text",
    "save_note_folder",
    "delete_note_folder",
    "set_notes_prefs",
    "note_link_for",
    "import_notes",
    "note_records",
    "apply_note_records",
    "get_notes_relay",
    "set_notes_relay",
    "get_push_settings",
    "set_push_settings",
    "set_push_target",
    "send_test_push",
    "background_pass",
];

pub async fn dispatch(app: &AppHandle, state: &Shared, name: &str, args: Value) -> std::result::Result<Output, String> {
    Ok(match name {
        "provider_capabilities" => {
            args!(args, provider: Provider);
            Output::json(commands::provider_capabilities(provider))
        }
        "list_accounts" => Output::json(commands::list_accounts(state)?),
        "add_account" => {
            args!(args, config: AccountConfig, password: String, dav_password: Option<String>);
            Output::json(commands::add_account(app.clone(), state, config, password, dav_password).await?)
        }
        "remove_account" => {
            args!(args, id: String);
            Output::json(commands::remove_account(app.clone(), state, id).await?)
        }
        "sync_now" => Output::json(commands::sync_now(app.clone(), state).await?),
        "list_messages" => {
            args!(args, query: MessageQuery);
            Output::json(commands::list_messages(state, query)?)
        }
        "get_thread" => {
            args!(args, thread_id: String);
            Output::json(commands::get_thread(state, thread_id)?)
        }
        "set_thread_seen" => {
            args!(args, thread_id: String, seen: bool);
            Output::json(commands::set_thread_seen(app.clone(), state, thread_id, seen)?)
        }
        "set_thread_flagged" => {
            args!(args, thread_id: String, flagged: bool);
            Output::json(commands::set_thread_flagged(app.clone(), state, thread_id, flagged)?)
        }
        "set_thread_archived" => {
            args!(args, thread_id: String, archived: bool);
            Output::json(commands::set_thread_archived(app.clone(), state, thread_id, archived)?)
        }
        "snooze_thread" => {
            args!(args, thread_id: String, until: i64);
            Output::json(commands::snooze_thread(app.clone(), state, thread_id, until)?)
        }
        "unsnooze_thread" => {
            args!(args, thread_id: String);
            Output::json(commands::unsnooze_thread(app.clone(), state, thread_id)?)
        }
        "open_attachment" => {
            args!(args, id: String);
            Output::json(commands::open_attachment(app.clone(), state, id)?)
        }
        "attachment_data" => {
            args!(args, id: String);
            Output::Bytes(commands::attachment_data(state, id)?)
        }
        "queue_send" => {
            args!(args, draft: Draft, undo_secs: i64, send_at: Option<i64>);
            Output::json(commands::queue_send(app.clone(), state, draft, undo_secs, send_at)?)
        }
        "cancel_send" => {
            args!(args, id: String);
            Output::json(commands::cancel_send(app.clone(), state, id)?)
        }
        "list_outbox" => Output::json(commands::list_outbox(state)?),
        "reschedule_send" => {
            args!(args, id: String, send_at: Option<i64>);
            Output::json(compose_commands::reschedule_send(app.clone(), state, id, send_at)?)
        }
        "set_follow_up" => {
            args!(args, thread_id: String, due_at: i64);
            Output::json(compose_commands::set_follow_up(app.clone(), state, thread_id, due_at)?)
        }
        "cancel_follow_up" => {
            args!(args, thread_id: String);
            Output::json(compose_commands::cancel_follow_up(app.clone(), state, thread_id)?)
        }
        "unsubscribe" => {
            args!(args, id: String);
            Output::json(compose_commands::unsubscribe(app.clone(), state, id).await?)
        }
        "list_templates" => Output::json(compose_commands::list_templates(state)?),
        "save_template" => {
            args!(args, input: pim_core::TemplateInput);
            Output::json(compose_commands::save_template(app.clone(), state, input)?)
        }
        "delete_template" => {
            args!(args, id: String);
            Output::json(compose_commands::delete_template(app.clone(), state, id)?)
        }
        "list_signatures" => Output::json(compose_commands::list_signatures(state)?),
        "screener_status" => Output::json(sender_commands::screener_status(state)?),
        "set_screener" => {
            args!(args, enabled: bool);
            Output::json(sender_commands::set_screener(app.clone(), state, enabled)?)
        }
        "decide_sender" => {
            args!(args, email: String, decision: Option<SenderDecision>);
            Output::json(sender_commands::decide_sender(app.clone(), state, email, decision)?)
        }
        "set_sender_category" => {
            args!(args, email: String, category: Option<Category>);
            Output::json(sender_commands::set_sender_category(app.clone(), state, email, category)?)
        }
        "list_senders" => Output::json(sender_commands::list_senders(state)?),
        "set_signature" => {
            args!(args, account_id: String, html: String);
            Output::json(compose_commands::set_signature(app.clone(), state, account_id, html)?)
        }
        "set_account_dav" => {
            args!(args, id: String, dav: Option<pim_core::DavConfig>, password: Option<String>);
            Output::json(commands::set_account_dav(app.clone(), state, id, dav, password).await?)
        }
        "set_time_zone" => {
            args!(args, tz: String);
            Output::json(pim_commands::set_time_zone(state, tz)?)
        }
        "list_collections" => {
            args!(args, kind: CollectionKind);
            Output::json(pim_commands::list_collections(state, kind)?)
        }
        "set_collection_hidden" => {
            args!(args, id: String, hidden: bool);
            Output::json(pim_commands::set_collection_hidden(app.clone(), state, id, hidden)?)
        }
        "list_occurrences" => {
            args!(args, from: i64, to: i64);
            Output::json(pim_commands::list_occurrences(state, from, to)?)
        }
        "get_event" => {
            args!(args, id: String, start: Option<i64>);
            Output::json(pim_commands::get_event(state, id, start)?)
        }
        "create_event" => {
            args!(args, input: EventInput);
            Output::json(pim_commands::create_event(app.clone(), state, input)?)
        }
        "update_event" => {
            args!(args, id: String, input: EventInput, scope: Option<EditScope>, occurrence: Option<i64>);
            Output::json(pim_commands::update_event(app.clone(), state, id, input, scope, occurrence)?)
        }
        "delete_event" => {
            args!(args, id: String, occurrence: Option<i64>, scope: Option<EditScope>);
            Output::json(pim_commands::delete_event(app.clone(), state, id, occurrence, scope)?)
        }
        "list_contacts" => {
            args!(args, search: Option<String>, label: Option<String>, group: Option<String>);
            Output::json(pim_commands::list_contacts(state, search, label, group)?)
        }
        "smart_groups" => Output::json(pim_commands::smart_groups(state)?),
        "interesting_calendars" => Output::json(pim_commands::interesting_calendars(state)?),
        "booking_links" => Output::json(pim_commands::booking_links(state)?),
        "save_booking_link" => {
            args!(args, id: Option<String>, input: pim_core::BookingLinkInput);
            Output::json(pim_commands::save_booking_link(state, id, input)?)
        }
        "delete_booking_link" => {
            args!(args, id: String);
            Output::json(pim_commands::delete_booking_link(state, id)?)
        }
        "public_booking" => {
            args!(args, token: String);
            Output::json(pim_commands::public_booking(state, token)?)
        }
        "book_slot" => {
            args!(args, token: String, request: pim_core::BookingRequest, manage_base: Option<String>);
            Output::json(pim_commands::book_slot(app.clone(), state, token, request, manage_base)?)
        }
        "managed_booking" => {
            args!(args, token: String, code: String);
            Output::json(pim_commands::managed_booking(state, token, code)?)
        }
        "change_booking" => {
            args!(args, token: String, code: String, change: pim_core::BookingChange);
            Output::json(pim_commands::change_booking(app.clone(), state, token, code, change)?)
        }
        "add_interesting_calendar" => {
            args!(args, id: String);
            Output::json(pim_commands::add_interesting_calendar(app.clone(), state, id)?)
        }
        "remove_interesting_calendar" => {
            args!(args, id: String);
            Output::json(pim_commands::remove_interesting_calendar(app.clone(), state, id)?)
        }
        "set_holiday_region" => {
            args!(args, id: String, region: Option<String>);
            Output::json(pim_commands::set_holiday_region(app.clone(), state, id, region)?)
        }
        "save_smart_group" => {
            args!(args, id: Option<String>, input: pim_core::SmartGroupInput);
            Output::json(pim_commands::save_smart_group(app.clone(), state, id, input)?)
        }
        "delete_smart_group" => {
            args!(args, id: String);
            Output::json(pim_commands::delete_smart_group(app.clone(), state, id)?)
        }
        "contacts_restore_preview" => {
            args!(args, since: Option<i64>, after: Option<i64>);
            Output::json(pim_commands::contacts_restore_preview(state, since, after)?)
        }
        "restore_contacts" => {
            args!(args, since: Option<i64>, after: Option<i64>);
            Output::json(pim_commands::restore_contacts(app.clone(), state, since, after)?)
        }
        "list_splits" => Output::json(commands::list_splits(state)?),
        "swipe_actions" => Output::json(commands::swipe_actions(state)?),
        "set_swipe_actions" => {
            args!(args, actions: pim_core::SwipeActions);
            Output::json(commands::set_swipe_actions(state, actions)?)
        }
        "key_bindings" => Output::json(commands::key_bindings(state)?),
        "set_key_bindings" => {
            args!(args, bindings: pim_core::KeyBindings);
            Output::json(commands::set_key_bindings(state, bindings)?)
        }
        "save_split" => {
            args!(args, id: Option<String>, input: pim_core::SplitInput);
            Output::json(commands::save_split(app.clone(), state, id, input)?)
        }
        "delete_split" => {
            args!(args, id: String);
            Output::json(commands::delete_split(app.clone(), state, id)?)
        }
        "move_split" => {
            args!(args, id: String, index: usize);
            Output::json(commands::move_split(app.clone(), state, id, index)?)
        }
        "inbox_overview" => {
            args!(args, account_id: Option<String>);
            Output::json(commands::inbox_overview(state, account_id)?)
        }
        "bundle_mark_read" => {
            args!(args, account_id: Option<String>);
            Output::json(commands::bundle_mark_read(app.clone(), state, account_id)?)
        }
        "bundle_archive" => {
            args!(args, account_id: Option<String>);
            Output::json(commands::bundle_archive(app.clone(), state, account_id)?)
        }
        "unarchive_bundle" => {
            args!(args, keys: Vec<String>);
            Output::json(commands::unarchive_bundle(app.clone(), state, keys)?)
        }
        "contact_labels" => Output::json(pim_commands::contact_labels(state)?),
        "contact_copies" => {
            args!(args, id: String);
            Output::json(pim_commands::contact_copies(state, id)?)
        }
        "contact_photos" => Output::json(pim_commands::contact_photos(state)?),
        "deleted_contacts" => Output::json(pim_commands::deleted_contacts(state)?),
        "restore_contact" => {
            args!(args, id: String);
            Output::json(pim_commands::restore_contact(app.clone(), state, id)?)
        }
        "contact_vcard" => {
            args!(args, id: String);
            Output::json(pim_commands::contact_vcard(state, id)?)
        }
        "save_contact_vcard" => {
            args!(args, id: String);
            Output::json(pim_commands::save_contact_vcard(app.clone(), state, id)?)
        }
        "contact_qr" => {
            args!(args, id: String);
            Output::json(pim_commands::contact_qr(state, id)?)
        }
        "contact_suggestion" => {
            args!(args, message_id: String);
            Output::json(pim_commands::contact_suggestion(state, message_id)?)
        }
        "parse_signature" => {
            args!(args, text: String);
            Output::json(pim_commands::parse_signature(text))
        }
        "get_contact" => {
            args!(args, id: String);
            Output::json(pim_commands::get_contact(state, id)?)
        }
        "contact_activity" => {
            args!(args, id: String);
            Output::json(pim_commands::contact_activity(state, id)?)
        }
        "sender_profile" => {
            args!(args, email: String);
            Output::json(pim_commands::sender_profile(state, email)?)
        }
        "local_times" => {
            args!(args, emails: Vec<String>);
            Output::json(pim_commands::local_times(state, emails)?)
        }
        "take_missed_reminders" => Output::json(pim_commands::take_missed_reminders(state)),
        "create_contact" => {
            args!(args, input: ContactInput);
            Output::json(pim_commands::create_contact(app.clone(), state, input)?)
        }
        "update_contact" => {
            args!(args, id: String, input: ContactInput);
            Output::json(pim_commands::update_contact(app.clone(), state, id, input)?)
        }
        "delete_contact" => {
            args!(args, id: String);
            Output::json(pim_commands::delete_contact(app.clone(), state, id)?)
        }
        "duplicate_contacts" => Output::json(pim_commands::duplicate_contacts(state)?),
        "merge_contacts" => {
            args!(args, primary: String, others: Vec<String>);
            Output::json(pim_commands::merge_contacts(app.clone(), state, primary, others)?)
        }
        "suggest_recipients" => {
            args!(args, prefix: String);
            Output::json(pim_commands::suggest_recipients(state, prefix)?)
        }
        "sync_pim_now" => Output::json(pim_commands::sync_pim_now(app.clone(), state).await?),
        "respond_to_invite" => {
            args!(args, message_id: String, response: InviteResponse, calendar_id: Option<String>);
            Output::json(pim_commands::respond_to_invite(app.clone(), state, message_id, response, calendar_id)?)
        }
        "propose_time" => {
            args!(args, message_id: String, start: i64, end: i64, comment: Option<String>);
            Output::json(pim_commands::propose_time(app.clone(), state, message_id, start, end, comment)?)
        }
        "accept_counter" => {
            args!(args, message_id: String);
            Output::json(pim_commands::accept_counter(app.clone(), state, message_id)?)
        }
        "decline_counter" => {
            args!(args, message_id: String);
            Output::json(pim_commands::decline_counter(app.clone(), state, message_id)?)
        }
        "find_times" => {
            args!(args, from: i64, minutes: u32, day_start: u32, day_end: u32, weekdays_only: bool, limit: Option<usize>);
            Output::json(pim_commands::find_times(state, from, minutes, day_start, day_end, weekdays_only, limit)?)
        }
        "calendar_sets" => Output::json(pim_commands::calendar_sets(state)?),
        "save_calendar_set" => {
            args!(args, name: String);
            Output::json(pim_commands::save_calendar_set(state, name)?)
        }
        "delete_calendar_set" => {
            args!(args, id: String);
            Output::json(pim_commands::delete_calendar_set(state, id)?)
        }
        "apply_calendar_set" => {
            args!(args, id: String);
            Output::json(pim_commands::apply_calendar_set(app.clone(), state, id)?)
        }
        "apply_invite_update" => {
            args!(args, message_id: String);
            Output::json(pim_commands::apply_invite_update(app.clone(), state, message_id)?)
        }
        "event_guests" => {
            args!(args, id: String);
            Output::json(pim_commands::event_guests(state, id)?)
        }
        "get_oauth_client" => {
            args!(args, issuer: OAuthIssuer);
            Output::json(oauth_commands::get_oauth_client(state, issuer))
        }
        "set_oauth_client" => {
            args!(args, issuer: OAuthIssuer, client: Option<oauth::Client>);
            Output::json(oauth_commands::set_oauth_client(state, issuer, client)?)
        }
        "add_oauth_account" => {
            args!(args, issuer: OAuthIssuer, login_hint: Option<String>);
            Output::json(oauth_commands::add_oauth_account(app.clone(), state, issuer, login_hint).await?)
        }
        "reauth_oauth_account" => {
            args!(args, id: String);
            Output::json(oauth_commands::reauth_oauth_account(app.clone(), state, id).await?)
        }
        "cancel_oauth_sign_in" => {
            oauth_commands::cancel_oauth_sign_in(state);
            Output::json(())
        },
        "list_notes" => {
            args!(args, query: NoteQuery);
            Output::json(notes_commands::list_notes(state, query)?)
        }
        "get_note" => {
            args!(args, id: String);
            Output::json(notes_commands::get_note(state, id)?)
        }
        "create_note" => {
            args!(args, input: NoteInput);
            Output::json(notes_commands::create_note(app.clone(), state, input)?)
        }
        "save_note_body" => {
            args!(args, id: String, markdown: String, ydoc: Option<String>, touch: bool);
            Output::json(notes_commands::save_note_body(app.clone(), state, id, markdown, ydoc, touch)?)
        }
        "set_note_meta" => {
            args!(args, id: String, meta: NoteMeta);
            Output::json(notes_commands::set_note_meta(app.clone(), state, id, meta)?)
        }
        "delete_note" => {
            args!(args, id: String);
            Output::json(notes_commands::delete_note(app.clone(), state, id)?)
        }
        "restore_note" => {
            args!(args, id: String);
            Output::json(notes_commands::restore_note(app.clone(), state, id)?)
        }
        "note_tags" => Output::json(notes_commands::note_tags(state)?),
        "note_backlinks" => {
            args!(args, id: String);
            Output::json(notes_commands::note_backlinks(state, id)?)
        }
        "find_note" => {
            args!(args, title: String);
            Output::json(notes_commands::find_note(state, title)?)
        }
        "notes_linking_to" => {
            args!(args, title: String, except: Option<String>);
            Output::json(notes_commands::notes_linking_to(state, title, except)?)
        }
        "export_notes" => Output::json(notes_commands::export_notes(state)?),
        "save_notes_export" => Output::json(notes_commands::save_notes_export(app.clone(), state)?),
        "note_tasks" => {
            args!(args, done: Option<bool>);
            Output::json(notes_commands::note_tasks(state, done.unwrap_or(false))?)
        }
        "notes_prefs" => Output::json(notes_commands::notes_prefs(state)?),
        "note_folders" => Output::json(notes_commands::note_folders(state)?),
        "notes_lock" => Output::json(notes_commands::notes_lock(state)?),
        "set_notes_passphrase" => {
            args!(args, passphrase: String, hint: Option<String>);
            Output::json(notes_commands::set_notes_passphrase(app.clone(), state, passphrase, hint)?)
        }
        "unlock_notes" => {
            args!(args, passphrase: String);
            Output::json(notes_commands::unlock_notes(state, passphrase)?)
        }
        "unlock_notes_with_identity" => Output::json(notes_commands::unlock_notes_with_identity(state)?),
        "lock_notes_now" => Output::json(notes_commands::lock_notes_now(app.clone(), state)?),
        "lock_note" => {
            args!(args, id: String);
            Output::json(notes_commands::lock_note(app.clone(), state, id)?)
        }
        "remove_note_lock" => {
            args!(args, id: String);
            Output::json(notes_commands::remove_note_lock(app.clone(), state, id)?)
        }
        "open_locked_note" => {
            args!(args, id: String);
            Output::json(notes_commands::open_locked_note(state, id)?)
        }
        "save_locked_note" => {
            args!(args, id: String, markdown: String, touch: bool);
            Output::json(notes_commands::save_locked_note(app.clone(), state, id, markdown, touch)?)
        }
        "notes_lock_setting" => Output::json(notes_commands::notes_lock_setting(state)?),
        "apply_notes_lock_setting" => {
            args!(args, setting: pim_core::NotesLockSetting);
            Output::json(notes_commands::apply_notes_lock_setting(app.clone(), state, setting)?)
        }
        "add_note_file" => {
            args!(args, note_id: String, mime: String, data_base64: String, width: Option<u32>, height: Option<u32>);
            Output::json(notes_commands::add_note_file(app.clone(), state, note_id, mime, data_base64, width, height)?)
        }
        "note_file" => {
            args!(args, id: String);
            Output::json(notes_commands::note_file(state, id)?)
        }
        "note_files" => {
            args!(args, note_id: String);
            Output::json(notes_commands::note_files(state, note_id)?)
        }
        "note_file_records" => Output::json(notes_commands::note_file_records(state)?),
        "note_file_raw" => {
            args!(args, id: String);
            Output::json(notes_commands::note_file_raw(state, id)?)
        }
        "put_note_file" => {
            args!(args, file: pim_core::NoteFile, raw_base64: String);
            Output::json(notes_commands::put_note_file(app.clone(), state, file, raw_base64)?)
        }
        "set_note_file_text" => {
            args!(args, id: String, text: String);
            Output::json(notes_commands::set_note_file_text(app.clone(), state, id, text)?)
        }
        "note_files_without_text" => {
            args!(args, limit: u32);
            Output::json(notes_commands::note_files_without_text(state, limit)?)
        }
        "save_note_folder" => {
            args!(args, id: Option<String>, input: pim_core::NoteFolderInput);
            Output::json(notes_commands::save_note_folder(app.clone(), state, id, input)?)
        }
        "delete_note_folder" => {
            args!(args, id: String);
            Output::json(notes_commands::delete_note_folder(app.clone(), state, id)?)
        }
        "meeting_prefs" => Output::json(pim_commands::meeting_prefs(state)?),
        "set_meeting_prefs" => {
            args!(args, prefs: pim_core::meeting::MeetingPrefs);
            Output::json(pim_commands::set_meeting_prefs(app.clone(), state, prefs)?)
        }
        "open_meeting" => {
            args!(args, url: String);
            Output::json(pim_commands::open_meeting(app.clone(), url)?)
        }
        "set_notes_prefs" => {
            args!(args, prefs: pim_core::NotesPrefs);
            Output::json(notes_commands::set_notes_prefs(app.clone(), state, prefs)?)
        }
        "note_link_for" => {
            args!(args, target: NoteTarget);
            Output::json(notes_commands::note_link_for(state, target)?)
        }
        "import_notes" => {
            args!(args, files: Vec<ImportFile>);
            Output::json(notes_commands::import_notes(app.clone(), state, files)?)
        }
        "note_records" => Output::json(notes_commands::note_records(state)?),
        "apply_note_records" => {
            args!(args, records: Vec<NoteRecord>);
            Output::json(notes_commands::apply_note_records(app.clone(), state, records)?)
        }
        "get_notes_relay" => Output::json(notes_commands::get_notes_relay(state)?),
        "set_notes_relay" => {
            args!(args, relay: Option<RelayConfig>);
            Output::json(notes_commands::set_notes_relay(state, relay)?)
        }
        "get_push_settings" => Output::json(push::get_push_settings(state).await?),
        "set_push_settings" => {
            args!(args, mode: PushMode, relay_url: Option<String>, relay_token: Option<String>, unified_push_endpoint: Option<String>);
            Output::json(push::set_push_settings(state, mode, relay_url, relay_token, unified_push_endpoint).await?)
        }
        "set_push_target" => {
            args!(args, target: PushTarget);
            Output::json(push::set_push_target(state, target).await?)
        }
        "send_test_push" => Output::json(push::send_test_push(state).await?),
        "background_pass" => Output::json(workers::background_pass(app.clone(), state).await?),
        _ => return Err(format!("unknown command “{name}”")),
    })
}
