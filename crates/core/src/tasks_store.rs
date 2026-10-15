//! Tasks are the checklist items in notes (ADR-0028). There is no separate
//! task list to keep in step: the note stays the one place a task lives,
//! and syncs the way notes do. This reads them out, in note order, and
//! says which are already on the calendar.
//!
//! A task is *planned* when its note links to an event with the task's
//! words as its title: planning a task creates exactly that event and link,
//! and both sync on their own (the event over CalDAV, the link in the note's
//! record), so every device agrees without new state.

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::notes_store::plain_line;
use crate::store::{Store, from_json, json};
use crate::{NoteLink, NoteLinkKind, Result, now};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteTask {
    pub note_id: String,
    pub note_title: String,
    /// Which checklist item this is in its note, counting from 0 in
    /// document order (nested items included), as the editor walks them.
    pub index: usize,
    pub text: String,
    pub done: bool,
    pub planned: Option<PlannedTask>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedTask {
    pub event_id: String,
    pub start: i64,
    pub end: Option<i64>,
}

/// How checklists behave in every note's editor, and how the list looks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesPrefs {
    /// Checking an item moves it below the unchecked ones in its list.
    pub sort_checked: bool,
    /// Notes as cards in a grid, the way Keep shows them (ADR-0038).
    #[serde(default)]
    pub grid: bool,
}

impl Default for NotesPrefs {
    fn default() -> Self {
        Self { sort_checked: true, grid: false }
    }
}

const PREFS: &str = "notes.prefs";

/// One checklist item's state and words, or `None` for any other line.
fn task_line(line: &str) -> Option<(bool, &str)> {
    let l = line.trim_start();
    let rest = l.strip_prefix("- ").or_else(|| l.strip_prefix("* ")).or_else(|| l.strip_prefix("+ "))?;
    let (done, words) = match rest.get(..4) {
        Some("[ ] ") => (false, &rest[4..]),
        Some("[x] " | "[X] ") => (true, &rest[4..]),
        _ => match rest {
            "[ ]" => (false, ""),
            "[x]" | "[X]" => (true, ""),
            _ => return None,
        },
    };
    Some((done, words))
}

/// A note's checklist items in document order, skipping code blocks.
pub(crate) fn tasks_in(markdown: &str) -> Vec<(bool, String)> {
    let mut fenced = false;
    let mut out = Vec::new();
    for line in markdown.lines() {
        if line.trim_start().starts_with("```") {
            fenced = !fenced;
            continue;
        }
        if fenced {
            continue;
        }
        if let Some((done, words)) = task_line(line) {
            out.push((done, plain_line(words)));
        }
    }
    out
}

impl Store {
    pub fn notes_prefs(&self) -> Result<NotesPrefs> {
        Ok(self.setting(PREFS)?.map(from_json::<NotesPrefs>).unwrap_or_default())
    }

    pub fn set_notes_prefs(&self, prefs: &NotesPrefs) -> Result<NotesPrefs> {
        self.set_setting(PREFS, Some(&json(prefs)))?;
        Ok(prefs.clone())
    }

    /// Checklist items across notes that aren't archived or deleted, newest
    /// note first. Done items come only with `done`, for Undo and counts.
    pub fn note_tasks(&self, done: bool) -> Result<Vec<NoteTask>> {
        let mut st = self.db.prepare("SELECT id, title, body, links FROM notes WHERE deleted = 0 AND archived = 0 ORDER BY pinned DESC, updated DESC")?;
        let notes =
            st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
        let mut out = Vec::new();
        for (id, title, body, links) in notes {
            let items = tasks_in(&body);
            if items.is_empty() {
                continue;
            }
            let events: Vec<String> = from_json::<Vec<NoteLink>>(links).into_iter().filter(|l| l.kind == NoteLinkKind::Event).map(|l| l.key).collect();
            for (index, (is_done, text)) in items.into_iter().enumerate() {
                if text.is_empty() || (is_done && !done) {
                    continue;
                }
                let planned = self.planned_task(&events, &text)?;
                out.push(NoteTask { note_id: id.clone(), note_title: title.clone(), index, text, done: is_done, planned });
            }
        }
        Ok(out)
    }

    /// The event a task was planned as: linked from its note, titled with its
    /// words. With several, the next one to come, else the latest.
    fn planned_task(&self, uids: &[String], text: &str) -> Result<Option<PlannedTask>> {
        let t = now();
        let mut best: Option<PlannedTask> = None;
        for uid in uids {
            let row = self
                .db
                .query_row("SELECT id, first_start, last_end FROM events WHERE uid = ?1 AND state != 'deleted' AND title = ?2 COLLATE NOCASE LIMIT 1", params![uid, text], |r| {
                    Ok(PlannedTask { event_id: r.get(0)?, start: r.get(1)?, end: r.get(2)? })
                })
                .optional()?;
            let Some(p) = row else { continue };
            let upcoming = |x: &PlannedTask| x.end.unwrap_or(x.start) >= t;
            best = match best {
                None => Some(p),
                Some(b) if upcoming(&p) && (!upcoming(&b) || p.start < b.start) => Some(p),
                Some(b) if !upcoming(&p) && !upcoming(&b) && p.start > b.start => Some(p),
                keep => keep,
            };
        }
        Ok(best)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CollectionKind, EventInput, NoteInput, NoteMeta, NoteTarget, Repeat};

    #[test]
    fn checklist_lines_in_document_order() {
        let md = "# Trip\n\n- [ ] Book **flights**\n  - [x] Compare prices\n- [x] Hotel\n- plain bullet\n\n```\n- [ ] not a task\n```\n\n* [X] Visa\n- [ ]\n- [ ] Pack";
        assert_eq!(
            tasks_in(md),
            [(false, "Book flights".to_string()), (true, "Compare prices".into()), (true, "Hotel".into()), (true, "Visa".into()), (false, "".into()), (false, "Pack".into())]
        );
    }

    #[test]
    fn tasks_across_notes_and_planned_ones() {
        let s = Store::open_in_memory().unwrap();
        s.ensure_local_collections().unwrap();
        let a = s.create_note(&NoteInput { markdown: "Errands\n\n- [ ] Call the bank\n- [x] Return parcel\n- [ ]\n- [ ] Draft the brief".into(), ..Default::default() }).unwrap();
        s.create_note(&NoteInput { markdown: "Ideas\n\nNo checklist here".into(), ..Default::default() }).unwrap();
        let open = s.note_tasks(false).unwrap();
        assert_eq!(
            open.iter().map(|t| (t.index, t.text.as_str())).collect::<Vec<_>>(),
            [(0, "Call the bank"), (3, "Draft the brief")],
            "indexes count every item, empty and done ones too"
        );
        assert!(open.iter().all(|t| t.note_title == "Errands" && t.planned.is_none()));
        assert_eq!(s.note_tasks(true).unwrap().len(), 3);

        // Planning: an event titled with the task's words, linked from the note.
        let cal = s.collections(CollectionKind::Calendar).unwrap().remove(0);
        let event = |title: &str, start: &str, end: &str| {
            s.create_event(&EventInput {
                calendar_id: cal.id.clone(),
                title: title.into(),
                location: None,
                notes: None,
                start: start.into(),
                end: end.into(),
                all_day: false,
                time_zone: "UTC".into(),
                repeat: Repeat::None,
                reminders: None,
                attendees: None,
                travel: None,
            })
            .unwrap()
        };
        let past = event("call the bank", "2020-01-02T09:00", "2020-01-02T09:30");
        let next = event("Call the bank", "2099-01-02T09:00", "2099-01-02T09:30");
        let other = event("Lunch", "2099-01-03T12:00", "2099-01-03T13:00");
        let links = [&past, &next, &other]
            .iter()
            .map(|e| s.note_link_for(&NoteTarget { kind: NoteLinkKind::Event, id: e.occurrence.event_id.clone() }).unwrap().unwrap())
            .collect::<Vec<_>>();
        s.set_note_meta(&a.summary.id, &NoteMeta { links: Some(links), ..Default::default() }).unwrap();
        let open = s.note_tasks(false).unwrap();
        assert_eq!(open[0].planned.as_ref().map(|p| p.event_id.as_str()), Some(next.occurrence.event_id.as_str()), "the upcoming block wins");
        assert_eq!(open[1].planned, None, "an event with other words doesn't count");
        s.delete_event(&next.occurrence.event_id, None, crate::EditScope::All).unwrap();
        assert_eq!(s.note_tasks(false).unwrap()[0].planned.as_ref().map(|p| p.event_id.as_str()), Some(past.occurrence.event_id.as_str()));

        s.set_note_meta(&a.summary.id, &NoteMeta { archived: Some(true), ..Default::default() }).unwrap();
        assert!(s.note_tasks(true).unwrap().is_empty(), "archived notes keep their tasks to themselves");

        assert!(s.notes_prefs().unwrap().sort_checked, "checked items sort down unless you say otherwise");
        s.set_notes_prefs(&NotesPrefs { sort_checked: false, ..Default::default() }).unwrap();
        assert!(!s.notes_prefs().unwrap().sort_checked);
    }
}
