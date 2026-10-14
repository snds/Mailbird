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
            args!(args, search: Option<String>);
            Output::json(pim_commands::list_contacts(state, search)?)
        }
        "get_contact" => {
            args!(args, id: String);
            Output::json(pim_commands::get_contact(state, id)?)
        }
        "contact_activity" => {
            args!(args, id: String);
            Output::json(pim_commands::contact_activity(state, id)?)
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
