//! Conversations shared with teammates (ADR-0060): the list, sharing and
//! joining, and each shared document's saved state. The documents
//! themselves sync in the web layer, on the owner's notes relay.

use pim_core::{TeamLink, TeamThread};

use crate::commands::{Res, with_store};
use crate::host::AppHandle;
use crate::{Shared, events};

fn changed(app: &AppHandle) {
    let _ = app.emit(events::TEAM_CHANGED, ());
}

pub fn team_threads(state: &Shared) -> Res<Vec<TeamThread>> {
    with_store(state, |s| s.team_threads())
}

/// Your share of a conversation, if it's shared right now.
pub fn thread_share(state: &Shared, thread_id: String) -> Res<Option<TeamThread>> {
    with_store(state, |s| s.thread_share(&thread_id))
}

/// Shares a conversation; teammates see you by your first account's name.
pub fn share_thread(app: AppHandle, state: &Shared, thread_id: String) -> Res<TeamThread> {
    let sealed = crate::notes_commands::relay_sealed(state)?;
    let t = with_store(state, |s| {
        let from = s.accounts()?.into_iter().next().map(|a| if a.config.display_name.trim().is_empty() { a.config.address } else { a.config.display_name });
        s.share_thread(&thread_id, from.as_deref(), sealed)
    })?;
    changed(&app);
    Ok(t)
}

pub fn join_team_thread(app: AppHandle, state: &Shared, link: TeamLink) -> Res<TeamThread> {
    let t = with_store(state, |s| s.join_team_thread(&link))?;
    changed(&app);
    Ok(t)
}

pub fn stop_team_thread(app: AppHandle, state: &Shared, id: String) -> Res<TeamThread> {
    let t = with_store(state, |s| s.stop_team_thread(&id))?;
    changed(&app);
    Ok(t)
}

pub fn remove_team_thread(app: AppHandle, state: &Shared, id: String) -> Res<()> {
    with_store(state, |s| s.remove_team_thread(&id))?;
    changed(&app);
    Ok(())
}

pub fn team_doc(state: &Shared, id: String) -> Res<Option<String>> {
    with_store(state, |s| s.team_doc(&id))
}

pub fn save_team_doc(app: AppHandle, state: &Shared, id: String, ydoc: String, title: Option<String>) -> Res<TeamThread> {
    let t = with_store(state, |s| s.save_team_doc(&id, &ydoc, title.as_deref()))?;
    changed(&app);
    Ok(t)
}
