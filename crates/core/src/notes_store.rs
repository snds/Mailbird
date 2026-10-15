//! Notes in the local store.
//!
//! A note is Markdown at rest (`body`), which is what search, export, and
//! lists read. Once an editor has opened a note it also has a Yjs document
//! (`ydoc`), and from then on the Markdown is derived from it: the editor
//! saves both together. Sync merges Yjs documents through a relay (see
//! ADR-0012). The store only keeps the bytes.
//!
//! Everything else about a note (pinned, archived, color, reminder, tags, links, deleted) is
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

/// Version 13: a card color per note (ADR-0038).
pub(crate) const MIGRATE_V13: &str = "ALTER TABLE notes ADD COLUMN color TEXT;";

/// Version 14: a reminder per note (ADR-0039).
pub(crate) const MIGRATE_V14: &str = "ALTER TABLE notes ADD COLUMN remind_at INTEGER;
CREATE INDEX notes_remind ON notes (remind_at) WHERE remind_at IS NOT NULL;";

/// Version 16: locked notes (ADR-0043). `sealed` is the text, encrypted.
pub(crate) const MIGRATE_V16: &str = "ALTER TABLE notes ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notes ADD COLUMN sealed TEXT;";

/// A reminder time, or `None` for none (`0` or less clears one).
fn clean_remind(t: Option<i64>) -> Option<i64> {
    t.filter(|t| *t > 0)
}

/// The colors a note's card can take: Google Keep's palette by name, so
/// Keep imports keep theirs. The app chooses the shades, per theme.
pub const NOTE_COLORS: &[&str] = &["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink", "brown", "gray"];

/// A known color name, or `None`. A color this version doesn't know (from a
/// newer device) shows as the plain card rather than failing.
fn clean_color(c: Option<&str>) -> Option<String> {
    let c = c?.trim().to_ascii_lowercase();
    NOTE_COLORS.contains(&c.as_str()).then_some(c)
}

const SNIPPET_CHARS: usize = 140;

/// The last column is the cover: the first `(note-file:` id in the text. Image
/// ids are UUIDs, so 36 characters; a locked note's text is empty, so it has none.
const NOTE_COLS: &str = "n.id, n.title, n.snippet, n.pinned, n.archived, n.tags, n.links, n.created, n.updated, n.color, n.remind_at, n.locked,
  CASE WHEN instr(n.body, '(note-file:') > 0 THEN substr(n.body, instr(n.body, '(note-file:') + 11, 36) END";
/// The first column a query selects after [`NOTE_COLS`].
const AFTER_COLS: usize = 13;

fn summary_row(r: &Row) -> rusqlite::Result<NoteSummary> {
    Ok(NoteSummary {
        id: r.get(0)?,
        title: r.get(1)?,
        snippet: r.get(2)?,
        pinned: r.get(3)?,
        archived: r.get(4)?,
        color: r.get(9)?,
        remind_at: r.get(10)?,
        locked: r.get(11)?,
        cover: r.get(12)?,
        tags: from_json(r.get(5)?),
        links: from_json(r.get(6)?),
        created: r.get(7)?,
        updated: r.get(8)?,
    })
}

/// A note as a file other apps open (ADR-0034).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ExportedNote {
    /// File name, unique within the export: the title, as Obsidian expects,
    /// so `[[Title]]` links keep working there.
    pub path: String,
    pub contents: String,
    /// An image's bytes (base64), for `attachments/…` files (ADR-0044). Its
    /// `contents` is empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_base64: Option<String>,
}

/// A title as a file name: characters no file system allows become spaces.
fn file_stem(title: &str) -> String {
    let cleaned: String = title.chars().map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '#' | '^' | '[' | ']') || c.is_control() { ' ' } else { c }).collect();
    let stem = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let stem = stem.trim_matches('.').trim().to_string();
    if stem.is_empty() { "Untitled".into() } else { stem.chars().take(120).collect() }
}

fn yaml_text(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

fn iso(t: i64) -> String {
    chrono::DateTime::from_timestamp(t, 0).map(|d| d.format("%Y-%m-%dT%H:%M:%SZ").to_string()).unwrap_or_default()
}

impl Store {
    /// Notes whose text links here with `[[this note's title]]` (ADR-0034),
    /// most recently changed first. Matching ignores case, as Obsidian does.
    pub fn note_backlinks(&self, id: &str) -> Result<Vec<NoteSummary>> {
        let title: Option<String> = self.db.query_row("SELECT title FROM notes WHERE id = ?1 AND deleted = 0", [id], |r| r.get(0)).optional()?;
        let Some(title) = title else { return Ok(Vec::new()) };
        self.notes_linking_to(&title, Some(id))
    }

    /// Notes that link to `title` with `[[title]]`, except `except`. Used for
    /// Linked from, and to find the links a rename should update (ADR-0035).
    pub fn notes_linking_to(&self, title: &str, except: Option<&str>) -> Result<Vec<NoteSummary>> {
        let title = title.trim();
        if title.is_empty() {
            return Ok(Vec::new());
        }
        // A cheap filter in SQL, then the exact parse, so `[[Trip]]` doesn't match `[[Trip plan]]`.
        let mut st = self.db.prepare(&format!("SELECT {NOTE_COLS}, n.body FROM notes n WHERE n.deleted = 0 AND n.id <> ?1 AND instr(n.body, '[[') > 0 ORDER BY n.updated DESC"))?;
        let rows = st.query_map([except.unwrap_or("")], |r| Ok((summary_row(r)?, r.get::<_, String>(AFTER_COLS)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
        let mut out = Vec::new();
        for (mut n, body) in rows {
            if wikilinks(&body).iter().any(|(t, _)| t.to_lowercase() == title.to_lowercase()) {
                self.resolve_links(&mut n.links)?;
                out.push(n);
            }
        }
        Ok(out)
    }

    /// The note a `[[title]]` link opens: the most recently changed one with
    /// that title, archived ones included.
    pub fn find_note(&self, title: &str) -> Result<Option<String>> {
        let title = title.split('#').next().unwrap_or_default().trim();
        if title.is_empty() {
            return Ok(None);
        }
        Ok(self.db.query_row("SELECT id FROM notes WHERE deleted = 0 AND title = ?1 COLLATE NOCASE ORDER BY updated DESC LIMIT 1", [title], |r| r.get(0)).optional()?)
    }

    /// Every note as a Markdown file with front matter, as Obsidian and
    /// this app's own importer read it (ADR-0034).
    pub fn export_notes(&self) -> Result<Vec<ExportedNote>> {
        let mut st = self.db.prepare(&format!("SELECT {NOTE_COLS}, n.body FROM notes n WHERE n.deleted = 0 AND n.locked = 0 ORDER BY n.created, n.rowid"))?;
        let rows = st.query_map([], |r| Ok((summary_row(r)?, r.get::<_, String>(AFTER_COLS)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
        let mut taken = std::collections::HashSet::new();
        let mut out = Vec::new();
        for (n, body) in rows {
            let stem = file_stem(&n.title);
            let mut path = format!("{stem}.md");
            let mut i = 2;
            while !taken.insert(path.to_lowercase()) {
                path = format!("{stem} {i}.md");
                i += 1;
            }
            let mut fm = format!("---\ntitle: {}\n", yaml_text(&n.title));
            if !n.tags.is_empty() {
                fm.push_str("tags:\n");
                for t in &n.tags {
                    fm.push_str(&format!("  - {}\n", yaml_text(t)));
                }
            }
            fm.push_str(&format!("created: {}\nupdated: {}\n", iso(n.created), iso(n.updated)));
            if n.pinned {
                fm.push_str("pinned: true\n");
            }
            if n.archived {
                fm.push_str("archived: true\n");
            }
            if let Some(c) = &n.color {
                fm.push_str(&format!("color: {c}\n"));
            }
            fm.push_str("---\n");
            // Images go in attachments/, and the text points there, as Obsidian and Bear expect.
            let mut body = body.trim_end().to_string();
            for id in crate::note_file_ids(&body) {
                let Ok(f) = self.note_file(&id, None) else { continue };
                let file = format!("attachments/{id}.{}", crate::mime_ext(&f.mime));
                body = body.replace(&format!("{}{id}", crate::NOTE_FILE_SCHEME), &file);
                if taken.insert(file.clone()) {
                    out.push(ExportedNote { path: file, contents: String::new(), data_base64: Some(f.data_base64) });
                }
            }
            out.push(ExportedNote { path, contents: format!("{fm}{body}\n"), data_base64: None });
        }
        Ok(out)
    }

    /// Notes, pinned first, then most recently changed. Search matches the
    /// title, text, and tags by word prefix.
    pub fn notes(&self, q: &NoteQuery) -> Result<Vec<NoteSummary>> {
        let mut sql = format!("SELECT {NOTE_COLS} FROM notes n");
        let mut clauses = vec!["n.deleted = 0".to_string(), "n.archived = ?".to_string()];
        let mut args: Vec<Value> = vec![Value::from(q.archived)];
        let folder = q.folder.as_deref().map(|id| self.note_folder_rule(id)).transpose()?;
        // A folder's words and the search field are one full-text query: FTS
        // takes a single MATCH, and its terms are ANDed.
        let search = [q.search.as_deref(), folder.as_ref().and_then(|f| f.words.as_deref())]
            .into_iter()
            .flatten()
            .map(fts_query)
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        if !search.is_empty() {
            sql.push_str(" JOIN notes_fts f ON f.rowid = n.rowid");
            clauses.push("notes_fts MATCH ?".into());
            args.push(Value::from(search));
        }
        if let Some(f) = &folder {
            if !f.tags.is_empty() {
                let marks = vec!["?"; f.tags.len()].join(", ");
                clauses.push(format!("EXISTS (SELECT 1 FROM json_each(n.tags) t WHERE lower(t.value) IN ({marks}))"));
                args.extend(f.tags.iter().map(|t| Value::from(t.to_lowercase())));
            }
            match f.linked.as_deref() {
                Some("any") => clauses.push("json_array_length(n.links) > 0".into()),
                Some(kind) => {
                    clauses.push("EXISTS (SELECT 1 FROM json_each(n.links) l WHERE l.value ->> 'kind' = ?)".into());
                    args.push(Value::from(kind.to_string()));
                }
                None => {}
            }
            match f.color.as_deref() {
                Some("any") => clauses.push("n.color IS NOT NULL".into()),
                Some(c) => {
                    clauses.push("n.color = ?".into());
                    args.push(Value::from(c.to_string()));
                }
                None => {}
            }
            if f.has_reminder {
                clauses.push("n.remind_at IS NOT NULL".into());
            }
            if f.has_open_tasks {
                // An unchecked Markdown checklist item, as tasks_in reads them.
                clauses.push("(n.body LIKE '%- [ ]%' OR n.body LIKE '%* [ ]%' OR n.body LIKE '%+ [ ]%')".into());
            }
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
                Ok((summary_row(r)?, r.get::<_, String>(AFTER_COLS)?, r.get::<_, Option<Vec<u8>>>(AFTER_COLS + 1)?))
            })
            .optional()?;
        let (mut summary, markdown, ydoc) = row.ok_or_else(|| Error::NotFound("that note is gone".into()))?;
        self.resolve_links(&mut summary.links)?;
        Ok(NoteDetail { summary, markdown, ydoc: ydoc.map(|b| base64::engine::general_purpose::STANDARD.encode(b)) })
    }

    pub fn create_note(&self, input: &NoteInput) -> Result<NoteDetail> {
        let id = uuid::Uuid::new_v4().to_string();
        let t = now();
        self.insert_note(&id, &input.markdown, input.pinned, false, None, &clean_tags(&input.tags), &clean_links(&input.links), None, t, t)?;
        self.note(&id)
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_note(&self, id: &str, markdown: &str, pinned: bool, archived: bool, color: Option<&str>, tags: &[String], links: &[NoteLink], source: Option<&str>, created: i64, updated: i64) -> Result<()> {
        let (title, snippet) = title_and_snippet(markdown);
        self.db.execute(
            "INSERT INTO notes (id, title, snippet, body, pinned, archived, tags, links, source, created, updated, color)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![id, title, snippet, markdown, pinned, archived, json(&tags), json(&links), source, created, updated, clean_color(color)],
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
        let old: Option<(String, bool)> = self.db.query_row("SELECT body, locked FROM notes WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
        let Some((old, locked)) = old else { return Err(Error::NotFound("that note is gone".into())) };
        // A locked note's text only ever goes in sealed (ADR-0043).
        if locked {
            return Err(Error::Invalid("that note is locked".into()));
        }
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
        let color = match &meta.color {
            Some(c) => clean_color(Some(c)),
            None => n.color,
        };
        let remind_at = match meta.remind_at {
            Some(t) => clean_remind(Some(t)),
            None => n.remind_at,
        };
        self.db.execute(
            "UPDATE notes SET pinned = ?2, archived = ?3, tags = ?4, links = ?5, color = ?7, remind_at = ?8, updated = MAX(?6, updated + 1) WHERE id = ?1",
            params![id, meta.pinned.unwrap_or(n.pinned), meta.archived.unwrap_or(n.archived), json(&tags), json(&links), now(), color, remind_at],
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

    /// Note reminders that fall in `(after, until]`, for the same loop that
    /// fires event reminders (ADR-0039). Archived and deleted notes stay quiet.
    pub(crate) fn due_note_reminders(&self, after: i64, until: i64) -> Result<Vec<crate::DueReminder>> {
        let mut st = self.db.prepare("SELECT id, title, remind_at FROM notes WHERE deleted = 0 AND archived = 0 AND remind_at > ?1 AND remind_at <= ?2 ORDER BY remind_at")?;
        Ok(st
            .query_map(params![after, until], |r| {
                let at: i64 = r.get(2)?;
                Ok(crate::DueReminder { event_id: String::new(), title: r.get(1)?, location: None, start: at, fire_at: at, leave: false, note_id: Some(r.get(0)?) })
            })?
            .collect::<rusqlite::Result<_>>()?)
    }

    // ── Sync ──────────────────────────────────────────────────────────────

    /// Every note's record, tombstones included, for the sync index.
    pub fn note_records(&self) -> Result<Vec<NoteRecord>> {
        let mut st = self.db.prepare("SELECT id, pinned, archived, deleted, tags, links, created, updated, color, remind_at, locked, sealed, title FROM notes")?;
        Ok(st
            .query_map([], |r| {
                Ok(NoteRecord {
                    id: r.get(0)?,
                    pinned: r.get(1)?,
                    archived: r.get(2)?,
                    deleted: r.get(3)?,
                    color: r.get(8)?,
                    remind_at: r.get(9)?,
                    tags: from_json(r.get(4)?),
                    links: from_json(r.get(5)?),
                    created: r.get(6)?,
                    updated: r.get(7)?,
                    locked: r.get(10)?,
                    sealed: r.get(11)?,
                    // Only a locked note needs its title carried: others have it in their text.
                    title: if r.get::<_, bool>(10)? { Some(r.get(12)?) } else { None },
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
                self.insert_note(&rec.id, "", rec.pinned, rec.archived, rec.color.as_deref(), &clean_tags(&rec.tags), &links, None, rec.created, rec.updated)?;
                if rec.deleted {
                    self.db.execute("UPDATE notes SET deleted = 1 WHERE id = ?1", [&rec.id])?;
                }
                if let Some(t) = clean_remind(rec.remind_at) {
                    self.db.execute("UPDATE notes SET remind_at = ?2 WHERE id = ?1", params![rec.id, t])?;
                }
                self.apply_lock(rec)?;
                Ok(true)
            }
            Some(u) if u < rec.updated => {
                self.db.execute(
                    "UPDATE notes SET pinned = ?2, archived = ?3, deleted = ?4, tags = ?5, links = ?6, updated = ?7, color = ?8, remind_at = ?9 WHERE id = ?1",
                    params![rec.id, rec.pinned, rec.archived, rec.deleted, json(&clean_tags(&rec.tags)), json(&links), rec.updated, clean_color(rec.color.as_deref()), clean_remind(rec.remind_at)],
                )?;
                self.apply_lock(rec)?;
                Ok(true)
            }
            Some(_) => Ok(false),
        }
    }

    /// Locked on another device: take its sealed text and title, and empty
    /// everything readable. Unlocked there: the text comes back through its
    /// Yjs document; the sealed copy stays, unread, until then.
    fn apply_lock(&self, rec: &NoteRecord) -> Result<()> {
        match (rec.locked, rec.sealed.as_deref()) {
            (true, Some(sealed)) => {
                self.db.execute(
                    "UPDATE notes SET locked = 1, sealed = ?2, title = coalesce(?3, title), body = '', snippet = '', ydoc = NULL WHERE id = ?1",
                    params![rec.id, sealed, rec.title],
                )?;
            }
            (false, _) => {
                self.db.execute("UPDATE notes SET locked = 0 WHERE id = ?1 AND locked = 1", [&rec.id])?;
            }
            (true, None) => {}
        }
        Ok(())
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
            self.insert_note(&id, &n.markdown, n.pinned, n.archived, n.color.as_deref(), &clean_tags(&n.tags), &[], Some(&n.source), n.created, n.updated)?;
            for img in &n.images {
                self.insert_note_file(&img.id, &id, img.mime, &img.data, n.created)?;
            }
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

/// The `[[wikilinks]]` in Markdown: (target note title, shown text).
/// `[[Note#Heading]]` targets the note. Ignores links inside code spans.
pub fn wikilinks(markdown: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for line in markdown.lines() {
        let mut in_code = false;
        let mut rest = line;
        while !rest.is_empty() {
            if rest.starts_with('`') {
                in_code = !in_code;
                rest = &rest[1..];
            } else if !in_code && rest.starts_with("[[") {
                match rest[2..].find("]]") {
                    Some(end) if !rest[2..2 + end].contains('[') => {
                        let inner = &rest[2..2 + end];
                        let (target, shown) = inner.split_once('|').unwrap_or((inner, inner));
                        let target = target.split('#').next().unwrap_or_default().trim();
                        if !target.is_empty() {
                            out.push((target.to_string(), shown.trim().to_string()));
                        }
                        rest = &rest[4 + end..];
                    }
                    _ => rest = &rest[2..],
                }
            } else {
                let next = rest.char_indices().nth(1).map(|(i, _)| i).unwrap_or(rest.len());
                rest = &rest[next..];
            }
        }
    }
    out
}

/// A line with each `[[Note]]` or `[[Note|shown]]` replaced by its shown text.
fn unwiki(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(open) = rest.find("[[") {
        out.push_str(&rest[..open]);
        let after = &rest[open + 2..];
        match after.find("]]") {
            Some(end) if !after[..end].contains('[') => {
                let inner = &after[..end];
                out.push_str(inner.split_once('|').map(|(_, shown)| shown).unwrap_or(inner));
                rest = &after[end + 2..];
            }
            _ => {
                out.push_str("[[");
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
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
    // [[Note]] → Note, [[Note|shown]] → shown (ADR-0034).
    let unlinked = unwiki(l);
    // [text](url) → text, ![alt](src) → alt, then drop emphasis and code marks.
    let mut out = String::with_capacity(l.len());
    let mut rest = unlinked.as_str();
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
    let out = out.replace("**", "").replace("__", "").replace("~~", "").replace(['`', '*'], "");
    // Markdown's escapes (`\[`, `\#`) read as the plain character.
    let mut plain = String::with_capacity(out.len());
    let mut chars = out.chars().peekable();
    while let Some(c) = chars.next() {
        match chars.peek() {
            Some(&n) if c == '\\' && n.is_ascii_punctuation() => {}
            _ => plain.push(c),
        }
    }
    plain.trim().to_string()
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
            color: None,
            remind_at: None,
            locked: false,
            sealed: None,
            title: None,
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
    fn colors_set_clear_sync_and_export() {
        let s = store();
        let a = note(&s, "Packing list");
        let set = |c: &str| s.set_note_meta(&a.summary.id, &NoteMeta { color: Some(c.into()), ..Default::default() }).unwrap();
        assert_eq!(set(" Teal ").color.as_deref(), Some("teal"), "names are forgiving");
        assert_eq!(s.set_note_meta(&a.summary.id, &NoteMeta { pinned: Some(true), ..Default::default() }).unwrap().color.as_deref(), Some("teal"), "other changes leave it");
        assert_eq!(set("chartreuse").color, None, "unknown names are the plain card");
        set("pink");
        assert!(s.export_notes().unwrap()[0].contents.contains("\ncolor: pink\n"));
        // The color rides the record; a record without one (an older device) clears it.
        let mut rec = s.note_records().unwrap().remove(0);
        assert_eq!(rec.color.as_deref(), Some("pink"));
        let old: NoteRecord = serde_json::from_str(r#"{"id":"x","pinned":false,"archived":false,"deleted":false,"tags":[],"links":[],"created":1,"updated":2}"#).unwrap();
        assert_eq!(old.color, None);
        rec.color = Some("blue".into());
        rec.updated += 10;
        s.apply_note_record(&rec).unwrap();
        assert_eq!(s.note(&a.summary.id).unwrap().summary.color.as_deref(), Some("blue"));
        let fresh = NoteRecord { id: "n9".into(), color: Some("green".into()), ..rec };
        s.apply_note_record(&fresh).unwrap();
        assert_eq!(s.note("n9").unwrap().summary.color.as_deref(), Some("green"));
        // Imports carry theirs: Keep's names, and front matter.
        let files = vec![
            ImportFile { path: "Takeout/Keep/a.json".into(), contents: r#"{"color":"CERULEAN","isTrashed":false,"isPinned":false,"isArchived":false,"title":"Sky","textContent":"x","userEditedTimestampUsec":1000000,"createdTimestampUsec":1000000}"#.into(), modified: None, data_base64: None },
            ImportFile { path: "Vault/b.md".into(), contents: "---\ntitle: Sun\ncolor: yellow\n---\nSun".into(), modified: Some(5), data_base64: None },
        ];
        s.import_notes(&files).unwrap();
        let all = s.notes(&NoteQuery::default()).unwrap();
        let color = |t: &str| all.iter().find(|n| n.title == t).and_then(|n| n.color.clone());
        assert_eq!((color("Sky").as_deref(), color("Sun").as_deref()), (Some("blue"), Some("yellow")));
    }

    #[test]
    fn reminders_fire_once_sync_and_clear() {
        let s = store();
        let a = note(&s, "Call the plumber");
        let id = a.summary.id.clone();
        let set = |t: i64| s.set_note_meta(&id, &NoteMeta { remind_at: Some(t), ..Default::default() }).unwrap();
        assert_eq!(set(1_000).remind_at, Some(1_000));
        assert_eq!(s.set_note_meta(&id, &NoteMeta { pinned: Some(true), ..Default::default() }).unwrap().remind_at, Some(1_000), "other changes leave it");
        // It joins the event reminders' window, once.
        let due = s.due_reminders(900, 1_000).unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!((due[0].note_id.as_deref(), due[0].title.as_str(), due[0].fire_at, due[0].event_id.as_str()), (Some(id.as_str()), "Call the plumber", 1_000, ""));
        assert!(s.due_reminders(1_000, 2_000).unwrap().is_empty(), "the next window doesn't fire it again");
        assert_eq!(s.note(&id).unwrap().summary.remind_at, Some(1_000), "it stays set, so the note shows as due");
        // Missed while closed: kept however long ago, unlike an event's.
        s.set_reminders_checked(500).unwrap();
        let missed = s.missed_reminders(100_000).unwrap();
        assert_eq!(missed.iter().filter(|r| r.note_id.is_some()).count(), 1);
        // Archived notes stay quiet; 0 clears.
        s.set_note_meta(&id, &NoteMeta { archived: Some(true), ..Default::default() }).unwrap();
        assert!(s.due_reminders(900, 1_000).unwrap().is_empty());
        s.set_note_meta(&id, &NoteMeta { archived: Some(false), ..Default::default() }).unwrap();
        assert_eq!(set(0).remind_at, None);
        // It rides the sync record, both ways.
        set(5_000);
        let mut rec = s.note_records().unwrap().into_iter().find(|r| r.id == id).unwrap();
        assert_eq!(rec.remind_at, Some(5_000));
        rec.remind_at = Some(6_000);
        rec.updated += 10;
        s.apply_note_record(&rec).unwrap();
        assert_eq!(s.note(&id).unwrap().summary.remind_at, Some(6_000));
        let fresh = NoteRecord { id: "n7".into(), remind_at: Some(7_000), ..rec };
        s.apply_note_record(&fresh).unwrap();
        assert_eq!(s.note("n7").unwrap().summary.remind_at, Some(7_000));
    }

    #[test]
    fn import_twice_adds_nothing() {
        let s = store();
        let files = vec![ImportFile { path: "Vault/Ideas/one.md".into(), contents: "# One\n\nBody #idea".into(), modified: Some(100), data_base64: None }];
        let r = s.import_notes(&files).unwrap();
        assert_eq!(r.imported, 1);
        let r = s.import_notes(&files).unwrap();
        assert_eq!((r.imported, r.duplicates), (0, 1));
        let n = &s.notes(&NoteQuery::default()).unwrap()[0];
        assert_eq!(n.title, "One");
        assert_eq!(n.tags, ["Ideas", "idea"]);
        assert_eq!(n.updated, 100);
    }

    #[test]
    fn wikilinks_parse_and_read_as_text() {
        let md = "# Trip\n\nSee [[Packing list]], [[Budget|money]], and [[Hotels#Lisbon]].\nNot `[[code]]`, not [[ ]], not [[a [b]]].";
        let got = wikilinks(md);
        assert_eq!(
            got,
            vec![("Packing list".into(), "Packing list".into()), ("Budget".into(), "money".into()), ("Hotels".into(), "Hotels#Lisbon".into())]
        );
        let (_, snippet) = title_and_snippet(md);
        assert!(snippet.starts_with("See Packing list, money, and Hotels#Lisbon."), "{snippet}");
        assert_eq!(title_and_snippet("# Trip\n\nBring \\[\\[gift").1, "Bring [[gift", "escapes read as plain text");
    }

    #[test]
    fn backlinks_find_notes_that_link_by_title() {
        let s = Store::open_in_memory().unwrap();
        let mk = |md: &str| s.create_note(&NoteInput { markdown: md.into(), ..Default::default() }).unwrap().summary.id;
        let trip = mk("# Trip\n\nPlans.");
        let a = mk("# Packing\n\nFor the [[trip]].");
        let b = mk("# Budget\n\nSee [[Trip|the trip]] and [[Trip plan]].");
        let _plan = mk("# Trip plan\n\nOnly [[Trip plan]] itself, and `[[Trip]]` in code.");
        let _self = s.save_note_body(&trip, "# Trip\n\nPlans, see [[Trip]].", None, true);
        let back: Vec<String> = s.note_backlinks(&trip).unwrap().into_iter().map(|n| n.id).collect();
        assert_eq!(back.len(), 2, "case-insensitive, exact title, not itself, not code");
        assert!(back.contains(&a) && back.contains(&b));
        s.delete_note(&a).unwrap();
        assert_eq!(s.note_backlinks(&trip).unwrap().len(), 1, "deleted notes don't count");
        assert_eq!(s.notes_linking_to("TRIP", None).unwrap().len(), 2, "by title: the note itself counts when not excluded");
        assert!(s.notes_linking_to(" ", None).unwrap().is_empty());

        assert_eq!(s.find_note("TRIP").unwrap(), Some(trip.clone()));
        assert_eq!(s.find_note("Trip#Day 1").unwrap(), Some(trip));
        assert_eq!(s.find_note("Nowhere").unwrap(), None);
        assert_eq!(s.find_note("  ").unwrap(), None);
    }

    #[test]
    fn export_round_trips_through_the_importer() {
        let s = Store::open_in_memory().unwrap();
        let a = s.create_note(&NoteInput { markdown: "# Trip: Lisbon/Porto\n\nSee [[Budget]].".into(), pinned: true, tags: vec!["travel".into(), "2026".into()], ..Default::default() }).unwrap();
        s.create_note(&NoteInput { markdown: "# Budget\n\nMoney.".into(), ..Default::default() }).unwrap();
        let dup = s.create_note(&NoteInput { markdown: "# budget\n\nAnother.".into(), ..Default::default() }).unwrap();
        s.set_note_meta(&dup.summary.id, &NoteMeta { archived: Some(true), ..Default::default() }).unwrap();
        s.create_note(&NoteInput { markdown: "".into(), ..Default::default() }).unwrap();

        let files = s.export_notes().unwrap();
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["Trip Lisbon Porto.md", "Budget.md", "budget 2.md", "Untitled.md"]);
        let trip = &files[0].contents;
        assert!(trip.starts_with("---\ntitle: \"Trip: Lisbon/Porto\"\ntags:\n  - \"travel\"\n  - \"2026\"\ncreated: "), "{trip}");
        assert!(trip.contains("pinned: true\n---\n# Trip: Lisbon/Porto\n\nSee [[Budget]].\n"));
        assert!(files[2].contents.contains("archived: true"));

        let other = Store::open_in_memory().unwrap();
        let picked: Vec<ImportFile> = files.iter().map(|f| ImportFile { path: format!("Mailbird notes/{}", f.path), contents: f.contents.clone(), modified: None, data_base64: f.data_base64.clone() }).collect();
        assert_eq!(other.import_notes(&picked).unwrap().imported, 4);
        let back = other.notes(&NoteQuery { search: Some("Lisbon".into()), ..Default::default() }).unwrap();
        let n = &back[0];
        assert_eq!((n.title.as_str(), n.pinned, n.created, n.updated), ("Trip: Lisbon/Porto", true, a.summary.created, a.summary.updated));
        assert!(n.tags.contains(&"travel".to_string()) && n.tags.contains(&"2026".to_string()));
        assert_eq!(other.note(&n.id).unwrap().markdown, "# Trip: Lisbon/Porto\n\nSee [[Budget]].");
        assert_eq!(other.notes(&NoteQuery { archived: true, ..Default::default() }).unwrap().len(), 1, "archived stays archived");
    }
}
