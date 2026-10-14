//! Send later, follow-up reminders, unsubscribe, templates, and signatures.

use pim_core::{Address, Draft, OutboxItem, Signature, Template, TemplateInput, UnsubscribeMethod, net, unsubscribe};

use crate::commands::{Res, with_store};
use crate::host::AppHandle;
use crate::{Shared, events};

pub fn reschedule_send(app: AppHandle, state: &Shared, id: String, send_at: Option<i64>) -> Res<OutboxItem> {
    let item = with_store(state, |s| s.reschedule_send(&id, send_at))?;
    let _ = app.emit(events::OUTBOX_CHANGED, ());
    Ok(item)
}

pub fn set_follow_up(app: AppHandle, state: &Shared, thread_id: String, due_at: i64) -> Res<()> {
    with_store(state, |s| s.set_follow_up(&thread_id, due_at))?;
    let _ = app.emit(events::MAIL_CHANGED, ());
    Ok(())
}

pub fn cancel_follow_up(app: AppHandle, state: &Shared, thread_id: String) -> Res<()> {
    with_store(state, |s| s.cancel_follow_up(&thread_id))?;
    let _ = app.emit(events::MAIL_CHANGED, ());
    Ok(())
}

/// Unsubscribe from the list a message came from, the quietest way it
/// offers: one-click, then a message to its address, then its web page.
pub async fn unsubscribe(app: AppHandle, state: &Shared, id: String) -> Res<UnsubscribeMethod> {
    let msg = with_store(state, |s| s.message(&id))?;
    let Some(options) = msg.unsubscribe else {
        return Err("this message doesn't say how to unsubscribe".into());
    };
    let mut one_click_error = None;
    if let Some(url) = &options.one_click {
        match net::unsubscribe::one_click(url).await {
            Ok(()) => return Ok(UnsubscribeMethod::OneClick),
            Err(e) => one_click_error = Some(e.to_string()),
        }
    }
    if let Some((to, subject, body)) = options.mailto.as_deref().and_then(unsubscribe::parse_mailto) {
        let draft = Draft {
            account_id: msg.summary.account_id.clone(),
            to: vec![Address { name: None, email: to }],
            cc: vec![],
            subject,
            body,
            body_html: None,
            in_reply_to: None,
            references: vec![],
            attachments: vec![],
            calendar: None,
            follow_up_after: None,
        };
        with_store(state, |s| s.queue_send(&draft, 0, None))?;
        let _ = app.emit(events::OUTBOX_CHANGED, ());
        return Ok(UnsubscribeMethod::Mail);
    }
    if let Some(url) = &options.web {
        app.open_url(url)?;
        return Ok(UnsubscribeMethod::Web);
    }
    Err(one_click_error.unwrap_or_else(|| "this message doesn't say how to unsubscribe".into()))
}

pub fn list_templates(state: &Shared) -> Res<Vec<Template>> {
    with_store(state, |s| s.templates())
}

pub fn save_template(app: AppHandle, state: &Shared, input: TemplateInput) -> Res<Template> {
    let t = with_store(state, |s| s.save_template(&input))?;
    let _ = app.emit(events::COMPOSE_CHANGED, ());
    Ok(t)
}

pub fn delete_template(app: AppHandle, state: &Shared, id: String) -> Res<()> {
    with_store(state, |s| s.delete_template(&id))?;
    let _ = app.emit(events::COMPOSE_CHANGED, ());
    Ok(())
}

pub fn list_signatures(state: &Shared) -> Res<Vec<Signature>> {
    with_store(state, |s| s.signatures())
}

pub fn set_signature(app: AppHandle, state: &Shared, account_id: String, html: String) -> Res<()> {
    with_store(state, |s| s.set_signature(&account_id, &html))?;
    let _ = app.emit(events::COMPOSE_CHANGED, ());
    Ok(())
}
