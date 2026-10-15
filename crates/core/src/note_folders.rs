//! Smart folders for notes (ADR-0042): saved searches that keep themselves
//! up to date, the way Bear's and Apple Notes' do. A folder is a rule, not a
//! place: a note can be in several, and leaving one never moves the note.
//! Rules live in a device setting, like contacts' smart groups (ADR-0023).

use serde::{Deserialize, Serialize};

use crate::store::{Store, from_json, json};
use crate::{Error, NoteQuery, Result};

const FOLDERS_KEY: &str = "notes.folders";

/// What a note must have to be in the folder: every filled-in part (tags
/// count when it has any of them).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteFolderInput {
    pub name: String,
    /// Has any of these tags.
    #[serde(default)]
    pub tags: Vec<String>,
    /// Contains these words (the same search as the search field).
    #[serde(default)]
    pub words: Option<String>,
    /// Linked to an `event`, `contact`, or `thread`, or `any` of them.
    #[serde(default)]
    pub linked: Option<String>,
    /// A card color (ADR-0038), or `any` color.
    #[serde(default)]
    pub color: Option<String>,
    /// Has a reminder set (ADR-0039).
    #[serde(default)]
    pub has_reminder: bool,
    /// Has checklist items still to do.
    #[serde(default)]
    pub has_open_tasks: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteFolder {
    pub id: String,
    #[serde(flatten)]
    pub rule: NoteFolderInput,
    /// Notes in it right now, archived ones aside (filled in when listed).
    #[serde(default)]
    pub count: u32,
}

const LINK_KINDS: &[&str] = &["any", "event", "contact", "thread"];

fn check(input: &NoteFolderInput) -> Result<NoteFolderInput> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err(Error::Invalid("give the folder a name".into()));
    }
    let mut tags: Vec<String> = Vec::new();
    for t in &input.tags {
        let t = t.trim().trim_start_matches('#').to_string();
        if !t.is_empty() && !tags.iter().any(|x| x.eq_ignore_ascii_case(&t)) {
            tags.push(t);
        }
    }
    let words = input.words.as_deref().map(str::trim).filter(|w| !w.is_empty()).map(String::from);
    let linked = match input.linked.as_deref().map(|l| l.trim().to_lowercase()).filter(|l| !l.is_empty()) {
        Some(l) if !LINK_KINDS.contains(&l.as_str()) => return Err(Error::Invalid(format!("“{l}” isn't something a note links to"))),
        l => l,
    };
    let color = match input.color.as_deref().map(|c| c.trim().to_lowercase()).filter(|c| !c.is_empty()) {
        Some(c) if c != "any" && !crate::NOTE_COLORS.contains(&c.as_str()) => return Err(Error::Invalid(format!("“{c}” isn't a note color"))),
        c => c,
    };
    if tags.is_empty() && words.is_none() && linked.is_none() && color.is_none() && !input.has_reminder && !input.has_open_tasks {
        return Err(Error::Invalid("say which notes belong in it: a tag, some words, a link, a color, or one of the checks".into()));
    }
    Ok(NoteFolderInput { name, tags, words, linked, color, has_reminder: input.has_reminder, has_open_tasks: input.has_open_tasks })
}

impl Store {
    fn folder_rules(&self) -> Result<Vec<NoteFolder>> {
        Ok(self.setting(FOLDERS_KEY)?.map(from_json::<Vec<NoteFolder>>).unwrap_or_default())
    }

    /// A folder's rule, for the notes query.
    pub(crate) fn note_folder_rule(&self, id: &str) -> Result<NoteFolderInput> {
        self.folder_rules()?.into_iter().find(|f| f.id == id).map(|f| f.rule).ok_or_else(|| Error::NotFound("that folder was deleted".into()))
    }

    fn folder_count(&self, id: &str) -> Result<u32> {
        Ok(self.notes(&NoteQuery { folder: Some(id.to_string()), ..Default::default() })?.len() as u32)
    }

    /// Smart folders in your order, each with how many notes are in it.
    pub fn note_folders(&self) -> Result<Vec<NoteFolder>> {
        let mut folders = self.folder_rules()?;
        for f in &mut folders {
            f.count = self.folder_count(&f.id)?;
        }
        Ok(folders)
    }

    /// Adds (`id` None) or replaces a folder.
    pub fn save_note_folder(&self, id: Option<&str>, input: &NoteFolderInput) -> Result<NoteFolder> {
        let rule = check(input)?;
        let mut folders = self.folder_rules()?;
        let folder = NoteFolder { id: id.map(String::from).unwrap_or_else(|| uuid::Uuid::new_v4().to_string()), rule, count: 0 };
        match folders.iter_mut().find(|f| f.id == folder.id) {
            Some(f) => *f = folder.clone(),
            None if id.is_some() => return Err(Error::NotFound("that folder was deleted".into())),
            None => folders.push(folder.clone()),
        }
        self.set_setting(FOLDERS_KEY, Some(&json(&folders)))?;
        let count = self.folder_count(&folder.id)?;
        Ok(NoteFolder { count, ..folder })
    }

    /// Removes the folder; its notes stay as they are.
    pub fn delete_note_folder(&self, id: &str) -> Result<()> {
        let mut folders = self.folder_rules()?;
        folders.retain(|f| f.id != id);
        self.set_setting(FOLDERS_KEY, Some(&json(&folders)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{NoteInput, NoteLink, NoteLinkKind, NoteMeta};

    fn store() -> Store {
        Store::open_in_memory().unwrap()
    }

    fn note(s: &Store, md: &str, tags: &[&str]) -> String {
        s.create_note(&NoteInput { markdown: md.into(), tags: tags.iter().map(|t| t.to_string()).collect(), ..Default::default() }).unwrap().summary.id
    }

    fn rule(name: &str) -> NoteFolderInput {
        NoteFolderInput { name: name.into(), ..Default::default() }
    }

    #[test]
    fn folders_keep_their_own_notes() {
        let s = store();
        let trip = note(&s, "Packing\n\n- [ ] Rain jacket\n- [x] Tickets", &["trip"]);
        let crit = note(&s, "Crit notes\n\nTokens for the composer", &["work", "design"]);
        let done = note(&s, "Groceries\n\n- [x] Lemons", &["home"]);
        s.set_note_meta(&crit, &NoteMeta { color: Some("teal".into()), remind_at: Some(4_000_000_000), ..Default::default() }).unwrap();
        let link = NoteLink { kind: NoteLinkKind::Event, key: "uid-1".into(), label: "Design review".into(), target: None };
        s.set_note_meta(&done, &NoteMeta { links: Some(vec![link]), ..Default::default() }).unwrap();

        let ids = |f: &NoteFolder| s.notes(&NoteQuery { folder: Some(f.id.clone()), ..Default::default() }).unwrap().into_iter().map(|n| n.id).collect::<Vec<_>>();
        let tags = s.save_note_folder(None, &NoteFolderInput { tags: vec!["#Trip".into(), "design".into()], ..rule("Ideas and trips") }).unwrap();
        assert_eq!(tags.count, 2, "any of the tags, ignoring # and case");
        let todo = s.save_note_folder(None, &NoteFolderInput { has_open_tasks: true, ..rule("To do") }).unwrap();
        assert_eq!(ids(&todo), std::slice::from_ref(&trip), "only lists with something left");
        let soon = s.save_note_folder(None, &NoteFolderInput { has_reminder: true, color: Some("any".into()), ..rule("Coming up") }).unwrap();
        assert_eq!(ids(&soon), std::slice::from_ref(&crit), "every part must match");
        let words = s.save_note_folder(None, &NoteFolderInput { words: Some("composer".into()), ..rule("Composer") }).unwrap();
        assert_eq!(ids(&words), std::slice::from_ref(&crit));
        let linked = s.save_note_folder(None, &NoteFolderInput { linked: Some("event".into()), ..rule("Meetings") }).unwrap();
        assert_eq!(ids(&linked), std::slice::from_ref(&done));
        // A search inside a folder narrows it further.
        assert_eq!(s.notes(&NoteQuery { folder: Some(tags.id.clone()), search: Some("packing".into()), ..Default::default() }).unwrap().len(), 1);
        // Notes come and go on their own; archived ones leave.
        s.set_note_meta(&crit, &NoteMeta { archived: Some(true), ..Default::default() }).unwrap();
        assert_eq!(s.note_folders().unwrap().iter().map(|f| (f.rule.name.as_str(), f.count)).collect::<Vec<_>>(), [("Ideas and trips", 1), ("To do", 1), ("Coming up", 0), ("Composer", 0), ("Meetings", 1)]);
        // Edit keeps its place; delete leaves the notes.
        s.save_note_folder(Some(&todo.id), &NoteFolderInput { has_open_tasks: true, tags: vec!["home".into()], ..rule("Home to-dos") }).unwrap();
        assert_eq!(s.note_folders().unwrap()[1].rule.name, "Home to-dos");
        s.delete_note_folder(&tags.id).unwrap();
        assert_eq!(s.note_folders().unwrap().len(), 4);
        assert_eq!(s.notes(&NoteQuery::default()).unwrap().len(), 2);
        assert!(s.notes(&NoteQuery { folder: Some(tags.id), ..Default::default() }).is_err(), "a deleted folder says so");
    }

    #[test]
    fn folders_need_a_name_and_a_rule() {
        let s = store();
        assert!(s.save_note_folder(None, &rule("Empty")).unwrap_err().to_string().contains("say which notes"));
        assert!(s.save_note_folder(None, &NoteFolderInput { has_reminder: true, ..rule("  ") }).unwrap_err().to_string().contains("name"));
        assert!(s.save_note_folder(None, &NoteFolderInput { color: Some("chartreuse".into()), ..rule("Odd") }).is_err());
        assert!(s.save_note_folder(None, &NoteFolderInput { linked: Some("planet".into()), ..rule("Odd") }).is_err());
        assert!(s.save_note_folder(Some("gone"), &NoteFolderInput { has_reminder: true, ..rule("Gone") }).is_err());
    }
}
