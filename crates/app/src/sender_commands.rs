//! The Screener, sender decisions, and categories (ADR-0018).

use pim_core::{Category, ScreenerStatus, Sender, SenderDecision};

use crate::commands::{Res, with_store};
use crate::host::AppHandle;
use crate::{Shared, events, workers};

pub fn screener_status(state: &Shared) -> Res<ScreenerStatus> {
    with_store(state, |s| s.screener_status())
}

pub fn set_screener(app: AppHandle, state: &Shared, enabled: bool) -> Res<ScreenerStatus> {
    let status = with_store(state, |s| s.set_screener(enabled))?;
    let _ = app.emit(events::MAIL_CHANGED, ());
    Ok(status)
}

/// Screening out or blocking archives mail on the server, so sync soon.
pub fn decide_sender(app: AppHandle, state: &Shared, email: String, decision: Option<SenderDecision>) -> Res<()> {
    with_store(state, |s| s.decide_sender(&email, decision))?;
    let _ = app.emit(events::MAIL_CHANGED, ());
    workers::sync_soon(&app, state);
    Ok(())
}

pub fn set_sender_category(app: AppHandle, state: &Shared, email: String, category: Option<Category>) -> Res<()> {
    with_store(state, |s| s.set_sender_category(&email, category))?;
    let _ = app.emit(events::MAIL_CHANGED, ());
    Ok(())
}

pub fn list_senders(state: &Shared) -> Res<Vec<Sender>> {
    with_store(state, |s| s.senders())
}
