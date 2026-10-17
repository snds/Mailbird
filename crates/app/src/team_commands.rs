//! Conversations shared with teammates (ADR-0060): the list, sharing and
//! joining, and each shared document's saved state. The documents
//! themselves sync in the web layer, on the owner's notes relay.

use std::collections::HashMap;

use pim_core::{TeamLink, TeamThread, Teammate, ThreadTeam};

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

// ── A shared inbox on the gateway (ADR-0063) ────────────────────────────────
// `by` and `owner` come from the gateway's session: it overwrites whatever
// the page sent, so nobody can act as someone else.

fn inbox_changed(app: &AppHandle, thread_id: &str) {
    let _ = app.emit(events::INBOX_TEAM_CHANGED, serde_json::json!({ "threadId": thread_id }));
}

pub fn thread_team(state: &Shared, thread_id: String) -> Res<ThreadTeam> {
    with_store(state, |s| s.thread_team(&thread_id))
}

pub fn thread_assignments(state: &Shared) -> Res<HashMap<String, Teammate>> {
    with_store(state, |s| s.thread_assignments())
}

pub fn assign_thread(app: AppHandle, state: &Shared, thread_id: String, to: Option<Teammate>, by: Teammate) -> Res<ThreadTeam> {
    let t = with_store(state, |s| s.assign_thread(&thread_id, to.as_ref(), &by))?;
    inbox_changed(&app, &thread_id);
    Ok(t)
}

pub fn add_thread_comment(app: AppHandle, state: &Shared, thread_id: String, text: String, by: Teammate) -> Res<ThreadTeam> {
    let t = with_store(state, |s| s.add_thread_comment(&thread_id, &by, &text))?;
    inbox_changed(&app, &thread_id);
    Ok(t)
}

pub fn remove_thread_comment(app: AppHandle, state: &Shared, id: String, by: Teammate, owner: bool) -> Res<()> {
    let thread_id = with_store(state, |s| s.remove_thread_comment(&id, &by, owner))?;
    inbox_changed(&app, &thread_id);
    Ok(())
}

/// Someone left the team: their conversations go back to nobody.
pub fn unassign_member(app: AppHandle, state: &Shared, member_id: String) -> Res<()> {
    if with_store(state, |s| s.unassign_member(&member_id))? > 0 {
        inbox_changed(&app, "");
    }
    Ok(())
}
