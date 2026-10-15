//! Notes in the local store.
//!
//! A note is Markdown at rest (`body`), which is what search, export, and
//! lists read. Once an editor has opened a note it also has a Yjs document
//! (`ydoc`), and from then on the Markdown is derived from it: the editor
//! saves both together. Sync merges Yjs documents through a relay (see
//! ADR-0012). The store only keeps the bytes.
//!
//! Everything else about a note (pinned, archived, tags, links, deleted) is
//! its *record*, which syncs as a whole: the newest `updated` wins. Deletes
//! leave a tombstone so they can reach other devices.

use base64::Engine;
use rusqlite::{OptionalExtension, Row, params, params_from_iter, types::Value};

use crate::store::{Store, fts_query, from_json, json};
use crate::{
    Error, ImportFile, ImportReport, NoteDetail, NoteInput, NoteLink, NoteLinkKind, NoteMeta, NoteQuery, NoteRecord, NoteSummary, NoteTarget, Result,
    TagCount, notes_import, now,
};

/// Version 6: notes, with full-text search over title, text, and tags.
pub(crate) const MIGRATE_V6: &str = r#"
CREATE TABLE notes (
  id        TEXT PRIMARY KEY,
  title     TEXT NOT NULL,
  snippet   TEXT NOT NULL,
  body      TEXT NOT NULL,
  ydoc      BLOB,
  pinned    INTEGER NOT NULL DEFAULT 0,
  archived  INTEGER NOT NULL DEFAULT 0,
  deleted   INTEGER NOT NULL DEFAULT 0,
  tags      TEXT NOT NULL DEFAULT '[]',
  links     TEXT NOT NULL DEFAULT '[]',
  source    TEXT,                     -- where an imported note came from
  created   INTEGER NOT NULL,
  updated   INTEGER NOT NULL
);
CREATE INDEX notes_list ON notes (deleted, archived, pinned, updated);
CREATE UNIQUE INDEX notes_source ON notes (source) WHERE source IS NOT NULL;

CREATE VIRTUAL TABLE notes_fts USING fts5(
  title, body, tags,
  content = 'notes', content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts (rowid, title, body, tags) VALUES (new.rowid, new.title, new.body, new.tags);
END;
CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts (notes_fts, rowid, title, body, tags) VALUES ('delete', old.rowid, old.title, old.body, old.tags);
END;
CREATE TRIGGER notes_au AFTER UPDATE OF title, body, tags ON notes BEGIN
  INSERT INTO notes_fts (notes_fts, rowid, title, body, tags) VALUES ('delete', old.rowid, old.title, old.body, old.tags);
  INSERT INTO notes_fts (rowid, title, body, tags) VALUES (new.rowid, new.title, new.body, new.tags);
END;
"#;

const SNIPPET_CHARS: usize = 140;

const NOTE_COLS: &str = "n.id, n.title, n.snippet, n.pinned, n.archived, n.tags, n.links, n.created, n.updated";

fn summary_row(r: &Row) -> rusqlite::Result<NoteSummary> {
    Ok(NoteSummary {
        id: r.get(0)?,
        title: r.get(1)?,
        snippet: r.get(2)?,
        pinned: r.get(3)?,
        archived: r.get(4)?,
        tags: from_json(r.get(5)?),
        links: from_json(r.get(6)?),
        created: r.get(7)?,
        updated: r.get(8)?,
    })
}

impl Store {
    /// Notes, pinned first, then most recently changed. Search matches the
    /// title, text, and tags by word prefix.
    pub fn notes(&self, q: &NoteQuery) -> Result<Vec<NoteSummary>> {
        let mut sql = format!("SELECT {NOTE_COLS} FROM notes n");
        let mut clauses = vec!["n.deleted = 0".to_string(), "n.archived = ?".to_string()];
        let mut args: Vec<Value> = vec![Value::from(q.archived)];
        if let Some(search) = q.search.as_deref().map(fts_query).filter(|s| !s.is_empty()) {
            sql.push_str(" JOIN notes_fts f ON f.rowid = n.rowid");
            clauses.push("notes_fts MATCH ?".into());
            args.push(Value::from(search));
        }
        if let Some(tag) = q.tag.as_deref() {
            clauses.push("EXISTS (SELECT 1 FROM json_each(n.tags) t WHERE t.value = ? COLLATE NOCASE)".into());
            args.push(Value::from(tag.to_string()));
        }
        if let Some(t) = &q.linked {
            let Some(link) = self.note_link_for(t)? else { return Ok(Vec::new()) };
            clauses.push("EXISTS (SELECT 1 FROM json_each(n.links) l WHERE l.value ->> 'kind' = ? AND l.value ->> 'key' = ?)".into());
            args.push(Value::from(link.kind.as_str().to_string()));
            args.push(Value::from(link.key));
        }
        sql.push_str(&format!(" WHERE {} ORDER BY n.pinned DESC, n.updated DESC", clauses.join(" AND ")));
        let mut notes = self.db.prepare(&sql)?.query_map(params_from_iter(args), summary_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        for n in &mut notes {
            self.resolve_links(&mut n.links)?;
        }
        Ok(notes)
    }

    pub fn note(&self, id: &str) -> Result<NoteDetail> {
        let row = self
            .db
            .query_row(&format!("SELECT {NOTE_COLS}, n.body, n.ydoc FROM notes n WHERE n.id = ?1 AND n.deleted = 0"), [id], |r| {
                Ok((summary_row(r)?, r.get::<_, String>(9)?, r.get::<_, Option<Vec<u8>>>(10)?))
            })
            .optional()?;
        let (mut summary, markdown, ydoc) = row.ok_or_else(|| Error::NotFound("that note is gone".into()))?;
        self.resolve_links(&mut summary.links)?;
        Ok(NoteDetail { summary, markdown, ydoc: ydoc.map(|b| base64::engine::general_purpose::STANDARD.encode(b)) })
    }

    pub fn create_note(&self, input: &NoteInput) -> Result<NoteDetail> {
        let id = uuid::Uuid::new_v4().to_string();
        let t = now();
        self.insert_note(&id, &input.markdown, input.pinned, false, &clean_tags(&input.tags), &clean_links(&input.links), None, t, t)?;
        self.note(&id)
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_note(&self, id: &str, markdown: &str, pinned: bool, archived: bool, tags: &[String], links: &[NoteLink], source: Option<&str>, created: i64, updated: i64) -> Result<()> {
        let (title, snippet) = title_and_snippet(markdown);
        self.db.execute(
            "INSERT INTO notes (id, title, snippet, body, pinned, archived, tags, links, source, created, updated)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![id, title, snippet, markdown, pinned, archived, json(&tags), json(&links), source, created, updated],
        )?;
        Ok(())
    }

    /// Saves a note's text: its Markdown and, from an editor, its Yjs state.
    /// `touch` marks it changed now; sync passes `false` when it only stores
    /// what another device wrote.
    pub fn save_note_body(&self, id: &str, markdown: &str, ydoc: Option<&str>, touch: bool) -> Result<()> {
        let ydoc = ydoc
            .map(|b| base64::engine::general_purpose::STANDARD.decode(b).map_err(|_| Error::Invalid("the note's sync state is damaged".into())))
            .transpose()?;
        let (title, snippet) = title_and_snippet(markdown);
        let old: Option<String> = self.db.query_row("SELECT body FROM notes WHERE id = ?1", [id], |r| r.get(0)).optional()?;
        let Some(old) = old else { return Err(Error::NotFound("that note is gone".into())) };
        // Opening a note writes its Yjs state without changing a word: that
        // isn't an edit, so it shouldn't jump to the top of the list.
        let touch = touch && old != markdown;
        self.db.execute(
            "UPDATE notes SET title = ?2, snippet = ?3, body = ?4, ydoc = COALESCE(?5, ydoc),
               updated = CASE WHEN ?6 THEN MAX(?7, updated + 1) ELSE updated END
             WHERE id = ?1",
            params![id, title, snippet, markdown, ydoc, touch, now()],
        )?;
        Ok(())
    }

    pub fn set_note_meta(&self, id: &str, meta: &NoteMeta) -> Result<NoteSummary> {
        let n = self.note(id)?.summary;
        let tags = meta.tags.as_deref().map(clean_tags).unwrap_or(n.tags);
        let links = meta.links.as_deref().map(clean_links).unwrap_or(n.links);
        self.db.execute(
            "UPDATE notes SET pinned = ?2, archived = ?3, tags = ?4, links = ?5, updated = MAX(?6, updated + 1) WHERE id = ?1",
            params![id, meta.pinned.unwrap_or(n.pinned), meta.archived.unwrap_or(n.archived), json(&tags), json(&links), now()],
        )?;
        Ok(self.note(id)?.summary)
    }

    /// Hides a note and leaves a tombstone for sync. [`Store::restore_note`] undoes it.
    pub fn delete_note(&self, id: &str) -> Result<()> {
        self.set_note_deleted(id, true)
    }

    pub fn restore_note(&self, id: &str) -> Result<()> {
        self.set_note_deleted(id, false)
    }

    fn set_note_deleted(&self, id: &str, deleted: bool) -> Result<()> {
        let n = self.db.execute("UPDATE notes SET deleted = ?2, updated = MAX(?3, updated + 1) WHERE id = ?1", params![id, deleted, now()])?;
        if n == 0 {
            return Err(Error::NotFound("that note is gone".into()));
        }
        Ok(())
    }

    /// Tags in use on notes that aren't archived, most used first.
    pub fn note_tags(&self) -> Result<Vec<TagCount>> {
        let mut st = self.db.prepare(
            "SELECT t.value, COUNT(*) FROM notes n, json_each(n.tags) t
             WHERE n.deleted = 0 AND n.archived = 0 GROUP BY t.value COLLATE NOCASE ORDER BY COUNT(*) DESC, t.value COLLATE NOCASE",
        )?;
        Ok(st.query_map([], |r| Ok(TagCount { tag: r.get(0)?, count: r.get(1)? }))?.collect::<rusqlite::Result<_>>()?)
    }

    /// The link to put on a note for an event, contact, or conversation on this device.
    pub fn note_link_for(&self, t: &NoteTarget) -> Result<Option<NoteLink>> {
        let row: Option<(String, String)> = match t.kind {
            NoteLinkKind::Event => self.db.query_row("SELECT uid, title FROM events WHERE id = ?1 AND state != 'deleted'", [&t.id], |r| Ok((r.get(0)?, r.get(1)?))).optional()?,
            NoteLinkKind::Contact => {
                self.db.query_row("SELECT uid, full_name FROM contacts WHERE id = ?1 AND state != 'deleted'", [&t.id], |r| Ok((r.get(0)?, r.get(1)?))).optional()?
            }
            // A conversation's key is its first message's Message-ID, which every
            // device sees the same. Mail without one falls back to the local id.
            NoteLinkKind::Thread => self
                .db
                .query_row(
                    "SELECT COALESCE(message_id, 'local:' || thread_id), subject FROM messages WHERE thread_id = ?1 ORDER BY date LIMIT 1",
                    [&t.id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?,
        };
        Ok(row.map(|(key, label)| NoteLink { kind: t.kind, key, label, target: Some(t.id.clone()) }))
    }

    fn resolve_links(&self, links: &mut [NoteLink]) -> Result<()> {
        for l in links {
            l.target = match l.kind {
                NoteLinkKind::Event => self.db.query_row("SELECT id FROM events WHERE uid = ?1 AND state != 'deleted' LIMIT 1", [&l.key], |r| r.get(0)).optional()?,
                NoteLinkKind::Contact => self.db.query_row("SELECT id FROM contacts WHERE uid = ?1 AND state != 'deleted' LIMIT 1", [&l.key], |r| r.get(0)).optional()?,
                NoteLinkKind::Thread => match l.key.strip_prefix("local:") {
                    Some(thread) => self.db.query_row("SELECT thread_id FROM messages WHERE thread_id = ?1 LIMIT 1", [thread], |r| r.get(0)).optional()?,
                    None => self.db.query_row("SELECT thread_id FROM messages WHERE message_id = ?1 LIMIT 1", [&l.key], |r| r.get(0)).optional()?,
                },
            };
        }
        Ok(())
    }

    // ── Sync ──────────────────────────────────────────────────────────────

    /// Every note's record, tombstones included, for the sync index.
    pub fn note_records(&self) -> Result<Vec<NoteRecord>> {
        let mut st = self.db.prepare("SELECT id, pinned, archived, deleted, tags, links, created, updated FROM notes")?;
        Ok(st
            .query_map([], |r| {
                Ok(NoteRecord {
                    id: r.get(0)?,
                    pinned: r.get(1)?,
                    archived: r.get(2)?,
                    deleted: r.get(3)?,
                    tags: from_json(r.get(4)?),
                    links: from_json(r.get(5)?),
                    created: r.get(6)?,
                    updated: r.get(7)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?)
    }

    /// Applies another device's record when it's newer than ours (or new
    /// here). Returns whether anything changed. A new note starts with no
    /// text; its Yjs document brings that.
    pub fn apply_note_record(&self, rec: &NoteRecord) -> Result<bool> {
        let ours: Option<i64> = self.db.query_row("SELECT updated FROM notes WHERE id = ?1", [&rec.id], |r| r.get(0)).optional()?;
        let links: Vec<NoteLink> = clean_links(&rec.links);
        match ours {
            None => {
                self.insert_note(&rec.id, "", rec.pinned, rec.archived, &clean_tags(&rec.tags), &links, None, rec.created, rec.updated)?;
                if rec.deleted {
                    self.db.execute("UPDATE notes SET deleted = 1 WHERE id = ?1", [&rec.id])?;
                }
                Ok(true)
            }
            Some(u) if u < rec.updated => {
                self.db.execute(
                    "UPDATE notes SET pinned = ?2, archived = ?3, deleted = ?4, tags = ?5, links = ?6, updated = ?7 WHERE id = ?1",
                    params![rec.id, rec.pinned, rec.archived, rec.deleted, json(&clean_tags(&rec.tags)), json(&links), rec.updated],
                )?;
                Ok(true)
            }
            Some(_) => Ok(false),
        }
    }

    // ── Settings ──────────────────────────────────────────────────────────

    /// A device setting that isn't a secret (secrets go in the keychain).
    pub fn setting(&self, key: &str) -> Result<Option<String>> {
        Ok(self.db.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0)).optional()?)
    }

    pub fn set_setting(&self, key: &str, value: Option<&str>) -> Result<()> {
        match value {
            Some(v) => self.db.execute("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = ?2", [key, v])?,
            None => self.db.execute("DELETE FROM settings WHERE key = ?1", [key])?,
        };
        Ok(())
    }

    // ── Import ────────────────────────────────────────────────────────────

    /// Imports notes from another app's export (see [`notes_import`]).
    /// Importing the same files again adds nothing.
    pub fn import_notes(&self, files: &[ImportFile]) -> Result<ImportReport> {
        let (notes, mut report) = notes_import::parse(files);
        let tx = self.db.unchecked_transaction()?;
        for n in notes {
            let exists: bool = tx.query_row("SELECT 1 FROM notes WHERE source = ?1", [&n.source], |_| Ok(true)).optional()?.unwrap_or(false);
            if exists {
                report.duplicates += 1;
                continue;
            }
            let id = uuid::Uuid::new_v4().to_string();
            self.insert_note(&id, &n.markdown, n.pinned, n.archived, &clean_tags(&n.tags), &[], Some(&n.source), n.created, n.updated)?;
            report.imported += 1;
        }
        tx.commit()?;
        Ok(report)
    }
}

/// Trims, drops a leading `#`, and removes duplicates (ignoring case).
pub(crate) fn clean_tags(tags: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for t in tags {
        let t = t.trim().trim_start_matches('#').split_whitespace().collect::<Vec<_>>().join(" ");
        if !t.is_empty() && !out.iter().any(|o| o.eq_ignore_ascii_case(&t)) {
            out.push(t);
        }
    }
    out
}

fn clean_links(links: &[NoteLink]) -> Vec<NoteLink> {
    let mut out: Vec<NoteLink> = Vec::new();
    for l in links {
        if !l.key.is_empty() && !out.iter().any(|o| o.kind == l.kind && o.key == l.key) {
            out.push(NoteLink { target: None, ..l.clone() });
        }
    }
    out
}

/// A note's title is its first line, like Apple Notes; the snippet is the
/// text after it. Both drop Markdown marks.
pub(crate) fn title_and_snippet(markdown: &str) -> (String, String) {
    let mut lines = markdown.lines().map(plain_line).filter(|l| !l.is_empty());
    let title = lines.next().unwrap_or_default();
    let mut snippet = String::new();
    for l in lines {
        if snippet.chars().count() >= SNIPPET_CHARS {
            break;
        }
        if !snippet.is_empty() {
            snippet.push(' ');
        }
        snippet.push_str(&l);
    }
    let snippet = if snippet.chars().count() > SNIPPET_CHARS { format!("{}…", snippet.chars().take(SNIPPET_CHARS).collect::<String>().trim_end()) } else { snippet };
    (title.chars().take(200).collect(), snippet)
}

/// One line of Markdown as plain text.
pub(crate) fn plain_line(line: &str) -> String {
    let mut l = line.trim();
    if l.starts_with("```") || l.chars().all(|c| matches!(c, '-' | '*' | '_' | '=' | ' ')) {
        return String::new();
    }
    l = l.trim_start_matches('>').trim_start();
    l = l.trim_start_matches('#').trim_start();
    for marker in ["- [ ] ", "- [x] ", "- [X] ", "* [ ] ", "* [x] ", "- ", "* ", "+ "] {
        if let Some(rest) = l.strip_prefix(marker) {
            l = rest;
            break;
        }
    }
    if let Some((n, rest)) = l.split_once(". ")
        && !n.is_empty()
        && n.chars().all(|c| c.is_ascii_digit())
    {
        l = rest;
    }
    // [text](url) → text, ![alt](src) → alt, then drop emphasis and code marks.
    let mut out = String::with_capacity(l.len());
    let mut rest = l;
    while let Some(open) = rest.find('[') {
        let (before, after) = rest.split_at(open);
        out.push_str(before.trim_end_matches('!'));
        match after.find("](").and_then(|mid| after[mid..].find(')').map(|close| (mid, mid + close))) {
            Some((mid, close)) => {
                out.push_str(&after[1..mid]);
                rest = &after[close + 1..];
            }
            None => {
                out.push('[');
                rest = &after[1..];
            }
        }
    }
    out.push_str(rest);
    out.replace("**", "").replace("__", "").replace("~~", "").replace(['`', '*'], "").trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CollectionKind, EventInput, Repeat};

    fn store() -> Store {
        Store::open_in_memory().unwrap()
    }

    fn note(s: &Store, md: &str) -> NoteDetail {
        s.create_note(&NoteInput { markdown: md.into(), ..Default::default() }).unwrap()
    }

    #[test]
    fn titles_and_snippets_drop_markdown() {
        let (t, s) = title_and_snippet("# **Trip** to [Lisbon](https://x.test)\n\n- [ ] Book `flights`\n- [x] Hotel\n\n1. Pack");
        assert_eq!(t, "Trip to Lisbon");
        assert_eq!(s, "Book flights Hotel Pack");
        assert_eq!(title_and_snippet("\n\n").0, "");
        let long = format!("Title\n{}", "word ".repeat(80));
        assert!(title_and_snippet(&long).1.ends_with('…'));
    }

    #[test]
    fn create_list_search_and_order() {
        let s = store();
        let a = note(&s, "Groceries\n\n- oat milk\n- lemons");
        let b = note(&s, "Design crit notes\n\nTokens for the composer");
        s.set_note_meta(&a.summary.id, &NoteMeta { pinned: Some(true), tags: Some(vec!["#home".into(), "Home".into(), " errands ".into()]), ..Default::default() }).unwrap();
        let all = s.notes(&NoteQuery::default()).unwrap();
        assert_eq!(all.iter().map(|n| n.title.as_str()).collect::<Vec<_>>(), ["Groceries", "Design crit notes"]);
        assert_eq!(all[0].tags, ["home", "errands"]);
        let hits = s.notes(&NoteQuery { search: Some("tok".into()), ..Default::default() }).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, b.summary.id);
        let tagged = s.notes(&NoteQuery { search: Some("errands".into()), ..Default::default() }).unwrap();
        assert_eq!(tagged[0].id, a.summary.id, "search covers tags");
        assert_eq!(s.notes(&NoteQuery { tag: Some("HOME".into()), ..Default::default() }).unwrap().len(), 1);
        assert_eq!(s.note_tags().unwrap(), [TagCount { tag: "errands".into(), count: 1 }, TagCount { tag: "home".into(), count: 1 }]);
    }

    #[test]
    fn saving_without_changes_keeps_the_order() {
        let s = store();
        let a = note(&s, "First");
        let before = s.note(&a.summary.id).unwrap().summary.updated;
        s.save_note_body(&a.summary.id, "First", Some("AAE="), true).unwrap();
        let n = s.note(&a.summary.id).unwrap();
        assert_eq!(n.summary.updated, before);
        assert_eq!(n.ydoc.as_deref(), Some("AAE="));
        s.save_note_body(&a.summary.id, "First draft", None, true).unwrap();
        let n = s.note(&a.summary.id).unwrap();
        assert!(n.summary.updated > before);
        assert_eq!(n.summary.title, "First draft");
        assert_eq!(n.ydoc.as_deref(), Some("AAE="), "a save without state keeps the old state");
        assert!(s.save_note_body(&a.summary.id, "x", Some("not base64!"), true).is_err());
    }

    #[test]
    fn archive_delete_and_restore() {
        let s = store();
        let a = note(&s, "Old idea");
        s.set_note_meta(&a.summary.id, &NoteMeta { archived: Some(true), ..Default::default() }).unwrap();
        assert!(s.notes(&NoteQuery::default()).unwrap().is_empty());
        assert_eq!(s.notes(&NoteQuery { archived: true, ..Default::default() }).unwrap().len(), 1);
        s.delete_note(&a.summary.id).unwrap();
        assert!(s.notes(&NoteQuery { archived: true, ..Default::default() }).unwrap().is_empty());
        assert!(s.note(&a.summary.id).is_err());
        assert!(s.note_records().unwrap()[0].deleted, "a tombstone stays for sync");
        s.restore_note(&a.summary.id).unwrap();
        assert!(s.note(&a.summary.id).is_ok());
    }

    #[test]
    fn links_use_stable_keys_and_resolve_locally() {
        let s = store();
        s.ensure_local_collections().unwrap();
        let cal = s.collections(CollectionKind::Calendar).unwrap().remove(0);
        let ev = s
            .create_event(&EventInput {
                calendar_id: cal.id.clone(),
                title: "Design crit".into(),
                location: None,
                notes: None,
                start: "2026-11-02T09:00".into(),
                end: "2026-11-02T10:00".into(),
                all_day: false,
                time_zone: "UTC".into(),
                repeat: Repeat::None,
                reminders: None,
                attendees: None,
                travel: None,
            })
            .unwrap();
        let target = NoteTarget { kind: NoteLinkKind::Event, id: ev.occurrence.event_id.clone() };
        let link = s.note_link_for(&target).unwrap().unwrap();
        assert!(link.key.ends_with("@mailbird"));
        assert_eq!(link.label, "Design crit");
        let n = s.create_note(&NoteInput { markdown: "Crit notes".into(), links: vec![link.clone(), link], ..Default::default() }).unwrap();
        assert_eq!(n.summary.links.len(), 1, "duplicate links collapse");
        assert_eq!(n.summary.links[0].target.as_deref(), Some(ev.occurrence.event_id.as_str()));
        note(&s, "Unrelated");
        let linked = s.notes(&NoteQuery { linked: Some(target), ..Default::default() }).unwrap();
        assert_eq!(linked.len(), 1);
        assert_eq!(linked[0].title, "Crit notes");
        // Another device's link to an event that isn't here yet still shows its label.
        let rec = NoteRecord {
            id: "remote-1".into(),
            pinned: false,
            archived: false,
            deleted: false,
            tags: vec![],
            links: vec![NoteLink { kind: NoteLinkKind::Contact, key: "nobody".into(), label: "Ada".into(), target: Some("bogus".into()) }],
            created: 1,
            updated: 2,
        };
        s.apply_note_record(&rec).unwrap();
        let r = s.note("remote-1").unwrap();
        assert_eq!(r.summary.links[0].target, None);
        assert_eq!(r.summary.links[0].label, "Ada");
    }

    #[test]
    fn records_merge_newest_wins() {
        let s = store();
        let a = note(&s, "Shared");
        let mut rec = s.note_records().unwrap().remove(0);
        rec.pinned = true;
        rec.updated -= 10;
        assert!(!s.apply_note_record(&rec).unwrap(), "older records lose");
        rec.updated += 20;
        rec.tags = vec!["work".into()];
        assert!(s.apply_note_record(&rec).unwrap());
        let n = s.note(&a.summary.id).unwrap();
        assert!(n.summary.pinned);
        assert_eq!(n.summary.tags, ["work"]);
        assert_eq!(n.markdown, "Shared", "records never touch the text");
        rec.deleted = true;
        rec.updated += 1;
        s.apply_note_record(&rec).unwrap();
        assert!(s.notes(&NoteQuery::default()).unwrap().is_empty());
        // New from elsewhere: arrives empty, then its text is stored without bumping it.
        let fresh = NoteRecord { id: "n2".into(), deleted: false, updated: 50, created: 40, ..rec };
        s.apply_note_record(&fresh).unwrap();
        s.save_note_body("n2", "From the laptop", Some("AAE="), false).unwrap();
        let n2 = s.note("n2").unwrap();
        assert_eq!((n2.summary.title.as_str(), n2.summary.updated), ("From the laptop", 50));
    }

    #[test]
    fn import_twice_adds_nothing() {
        let s = store();
        let files = vec![ImportFile { path: "Vault/Ideas/one.md".into(), contents: "# One\n\nBody #idea".into(), modified: Some(100) }];
        let r = s.import_notes(&files).unwrap();
        assert_eq!(r.imported, 1);
        let r = s.import_notes(&files).unwrap();
        assert_eq!((r.imported, r.duplicates), (0, 1));
        let n = &s.notes(&NoteQuery::default()).unwrap()[0];
        assert_eq!(n.title, "One");
        assert_eq!(n.tags, ["Ideas", "idea"]);
        assert_eq!(n.updated, 100);
    }
}
