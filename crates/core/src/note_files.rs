//! Images in notes (ADR-0044). A note's Markdown points at its images as
//! `![alt](note-file:ID)`; the bytes live here, one row per image, so the
//! text stays small, searchable, and mergeable while images sync on their
//! own. A locked note's images are sealed with its text (ADR-0043).
//!
//! The text found in an image (ADR-0045) is kept with it, sealed with it
//! too, and gathered into the note's `image_text` so search finds it.

use base64::Engine;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::notes_lock::{NotesKey, open, seal};
use crate::store::Store;
use crate::{Error, Result, now};

/// Version 17: note images.
pub(crate) const MIGRATE_V17: &str = "CREATE TABLE note_files (
  id       TEXT PRIMARY KEY,
  note_id  TEXT NOT NULL,
  mime     TEXT NOT NULL,
  data     BLOB NOT NULL,          -- the image, or nonce ‖ sealed image ‖ tag
  sealed   INTEGER NOT NULL DEFAULT 0,
  width    INTEGER,
  height   INTEGER,
  created  INTEGER NOT NULL,
  updated  INTEGER NOT NULL
);
CREATE INDEX note_files_note ON note_files (note_id);";

/// Version 18: the text found in images, searchable with the note's own
/// (ADR-0045). Full-text search gains a column, so its index is rebuilt.
pub(crate) const MIGRATE_V18: &str = "ALTER TABLE note_files ADD COLUMN text TEXT;
ALTER TABLE notes ADD COLUMN image_text TEXT NOT NULL DEFAULT '';
DROP TRIGGER notes_ai;
DROP TRIGGER notes_ad;
DROP TRIGGER notes_au;
DROP TABLE notes_fts;
CREATE VIRTUAL TABLE notes_fts USING fts5(
  title, body, tags, image_text,
  content = 'notes', content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts (rowid, title, body, tags, image_text) VALUES (new.rowid, new.title, new.body, new.tags, new.image_text);
END;
CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts (notes_fts, rowid, title, body, tags, image_text) VALUES ('delete', old.rowid, old.title, old.body, old.tags, old.image_text);
END;
CREATE TRIGGER notes_au AFTER UPDATE OF title, body, tags, image_text ON notes BEGIN
  INSERT INTO notes_fts (notes_fts, rowid, title, body, tags, image_text) VALUES ('delete', old.rowid, old.title, old.body, old.tags, old.image_text);
  INSERT INTO notes_fts (rowid, title, body, tags, image_text) VALUES (new.rowid, new.title, new.body, new.tags, new.image_text);
END;
INSERT INTO notes_fts (notes_fts) VALUES ('rebuild');";

/// More text than any page holds; anything longer is cut.
const MAX_TEXT: usize = 20_000;
/// What a sealed image's text is bound to, apart from its bytes.
fn text_aad(id: &str) -> String {
    format!("{id}#text")
}

/// How notes link to their images in Markdown.
pub const NOTE_FILE_SCHEME: &str = "note-file:";
/// Images the editor can show; anything else is refused at the door.
const MIMES: &[&str] = &["image/jpeg", "image/png", "image/webp", "image/gif"];
/// The app resizes photos before they get here; this stops anything huge.
pub const MAX_NOTE_FILE: usize = 10 * 1024 * 1024;
const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// An image's facts, without its bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteFile {
    pub id: String,
    pub note_id: String,
    pub mime: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// Bytes as stored (sealed images are 28 bytes longer).
    pub size: u32,
    /// Sealed with the notes passphrase: its note is locked.
    pub sealed: bool,
    /// The text found in it, as stored: plain, or sealed when the image is.
    /// `None` until something has looked (ADR-0045).
    #[serde(default)]
    pub text: Option<String>,
    pub created: i64,
    pub updated: i64,
}

/// An image to show: its type and its bytes (base64).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteFileData {
    pub id: String,
    pub mime: String,
    pub data_base64: String,
    /// The text found in it, readable; `None` until something has looked.
    #[serde(default)]
    pub text: Option<String>,
}

/// The extension an image gets when it's written out as a file.
pub fn mime_ext(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => "jpg",
    }
}

/// The type a file name says it is, for imports.
pub(crate) fn ext_mime(name: &str) -> Option<&'static str> {
    let ext = name.rsplit('.').next()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => return None,
    })
}

/// The type an image's bytes say it is: the app may have turned a big PNG
/// into a JPEG without renaming it.
pub(crate) fn sniff_mime(data: &[u8]) -> Option<&'static str> {
    Some(match data {
        [0xFF, 0xD8, 0xFF, ..] => "image/jpeg",
        [0x89, b'P', b'N', b'G', ..] => "image/png",
        [b'G', b'I', b'F', b'8', ..] => "image/gif",
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => "image/webp",
        _ => return None,
    })
}

/// Whitespace tidied and the length capped, at a character boundary.
fn clip(text: &str) -> String {
    let t: String = text.lines().map(str::trim_end).collect::<Vec<_>>().join("\n").trim().to_string();
    match t.char_indices().nth(MAX_TEXT) {
        Some((i, _)) => t[..i].to_string(),
        None => t,
    }
}

fn open_text(key: &NotesKey, id: &str, sealed: &str) -> Result<String> {
    String::from_utf8(open(key, &text_aad(id), sealed)?).map_err(|_| Error::Invalid("the image's text is damaged".into()))
}

/// The ids a note's Markdown points at, in order, once each.
pub fn note_file_ids(markdown: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (i, _) in markdown.match_indices(NOTE_FILE_SCHEME) {
        let rest = &markdown[i + NOTE_FILE_SCHEME.len()..];
        let id: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
        if !id.is_empty() && !out.contains(&id) {
            out.push(id);
        }
    }
    out
}

fn row(r: &rusqlite::Row) -> rusqlite::Result<NoteFile> {
    Ok(NoteFile {
        id: r.get(0)?,
        note_id: r.get(1)?,
        mime: r.get(2)?,
        width: r.get(3)?,
        height: r.get(4)?,
        size: r.get(5)?,
        sealed: r.get(6)?,
        created: r.get(7)?,
        updated: r.get(8)?,
        text: r.get(9)?,
    })
}

const COLS: &str = "id, note_id, mime, width, height, length(data), sealed, created, updated, text";

impl Store {
    fn note_locked(&self, note_id: &str) -> Result<bool> {
        self.db
            .query_row("SELECT locked FROM notes WHERE id = ?1 AND deleted = 0", [note_id], |r| r.get(0))
            .optional()?
            .ok_or_else(|| Error::NotFound("that note is gone".into()))
    }

    /// Stores an image for a note. A locked note's image is sealed on the way
    /// in, so it needs the key.
    pub fn add_note_file(&self, note_id: &str, mime: &str, data_base64: &str, width: Option<u32>, height: Option<u32>, key: Option<&NotesKey>) -> Result<NoteFile> {
        let mime = mime.trim().to_ascii_lowercase();
        if !MIMES.contains(&mime.as_str()) {
            return Err(Error::Invalid("notes take JPEG, PNG, WebP, and GIF images".into()));
        }
        let data = B64.decode(data_base64.trim()).map_err(|_| Error::Invalid("that image is damaged".into()))?;
        if data.is_empty() {
            return Err(Error::Invalid("that image is empty".into()));
        }
        if data.len() > MAX_NOTE_FILE {
            return Err(Error::Invalid("that image is over 10 MB".into()));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let locked = self.note_locked(note_id)?;
        let (stored, sealed) = match (locked, key) {
            (false, _) => (data, false),
            (true, Some(k)) => (B64.decode(seal(k, &id, &data)?).map_err(|_| Error::Invalid("couldn't seal the image".into()))?, true),
            (true, None) => return Err(Error::Invalid("Locked notes are locked. Enter your passphrase to add images.".into())),
        };
        let t = now();
        self.db.execute(
            "INSERT INTO note_files (id, note_id, mime, data, sealed, width, height, created, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
            params![id, note_id, mime, stored, sealed, width, height, t],
        )?;
        self.note_file_info(&id)
    }

    /// An imported image, its id already in its note's text.
    pub(crate) fn insert_note_file(&self, id: &str, note_id: &str, mime: &str, data: &[u8], at: i64) -> Result<()> {
        let at = if at > 0 { at } else { now() };
        self.db.execute("INSERT INTO note_files (id, note_id, mime, data, created, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?5)", params![id, note_id, mime, data, at])?;
        Ok(())
    }

    pub fn note_file_info(&self, id: &str) -> Result<NoteFile> {
        self.db.query_row(&format!("SELECT {COLS} FROM note_files WHERE id = ?1"), [id], row).optional()?.ok_or_else(|| Error::NotFound("that image is gone".into()))
    }

    /// A note's images, oldest first.
    pub fn note_files(&self, note_id: &str) -> Result<Vec<NoteFile>> {
        let mut st = self.db.prepare(&format!("SELECT {COLS} FROM note_files WHERE note_id = ?1 ORDER BY created, rowid"))?;
        Ok(st.query_map([note_id], row)?.collect::<rusqlite::Result<_>>()?)
    }

    /// An image's bytes to show. A sealed one opens only with the key.
    pub fn note_file(&self, id: &str, key: Option<&NotesKey>) -> Result<NoteFileData> {
        let (mime, data, sealed, text): (String, Vec<u8>, bool, Option<String>) = self
            .db
            .query_row("SELECT mime, data, sealed, text FROM note_files WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .optional()?
            .ok_or_else(|| Error::NotFound("that image is gone".into()))?;
        let (plain, text) = match (sealed, key) {
            (false, _) => (data, text),
            (true, Some(k)) => (open(k, id, &B64.encode(&data))?, text.map(|t| open_text(k, id, &t)).transpose()?),
            (true, None) => return Err(Error::Invalid("Locked notes are locked. Enter your passphrase to see this image.".into())),
        };
        Ok(NoteFileData { id: id.to_string(), mime, data_base64: B64.encode(plain), text })
    }

    /// Seals (or, with `seal_them` false, opens) every image of a note, with
    /// the note's own lock or unlock (ADR-0043).
    pub(crate) fn reseal_note_files(&self, note_id: &str, from: Option<&NotesKey>, to: Option<&NotesKey>) -> Result<()> {
        let mut st = self.db.prepare("SELECT id, data, sealed, text FROM note_files WHERE note_id = ?1")?;
        let rows: Vec<(String, Vec<u8>, bool, Option<String>)> = st.query_map([note_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?.collect::<rusqlite::Result<_>>()?;
        drop(st);
        for (id, data, sealed, text) in rows {
            let (plain, text) = match (sealed, from) {
                (false, _) => (data, text),
                (true, Some(k)) => (open(k, &id, &B64.encode(&data))?, text.map(|t| open_text(k, &id, &t)).transpose()?),
                (true, None) => continue,
            };
            let (out, text, now_sealed) = match to {
                Some(k) => (
                    B64.decode(seal(k, &id, &plain)?).map_err(|_| Error::Invalid("couldn't seal the image".into()))?,
                    text.map(|t| seal(k, &text_aad(&id), t.as_bytes())).transpose()?,
                    true,
                ),
                None => (plain, text, false),
            };
            self.db.execute("UPDATE note_files SET data = ?2, sealed = ?3, text = ?4, updated = MAX(?5, updated + 1) WHERE id = ?1", params![id, out, now_sealed, text, now()])?;
        }
        self.refresh_image_text(note_id)
    }

    // ── Text in images (ADR-0045) ─────────────────────────────────────────

    /// Keeps the text found in an image. A sealed image's text is sealed
    /// too, so that needs the key. `""` means looked, found nothing.
    pub fn set_note_file_text(&self, id: &str, text: &str, key: Option<&NotesKey>) -> Result<NoteFile> {
        let f = self.note_file_info(id)?;
        let text = clip(text);
        let stored = match (f.sealed, key) {
            (false, _) => text,
            (true, Some(k)) => seal(k, &text_aad(id), text.as_bytes())?,
            (true, None) => return Err(Error::Invalid("Locked notes are locked. Enter your passphrase first.".into())),
        };
        self.db.execute("UPDATE note_files SET text = ?2, updated = MAX(?3, updated + 1) WHERE id = ?1", params![id, stored, now()])?;
        self.refresh_image_text(&f.note_id)?;
        self.note_file_info(id)
    }

    /// Images no one has read the text of yet, oldest first. Sealed ones wait
    /// for an unlock; this doesn't open them.
    pub fn note_files_without_text(&self, limit: u32) -> Result<Vec<NoteFile>> {
        let mut st = self.db.prepare(&format!("SELECT {COLS} FROM note_files WHERE text IS NULL AND sealed = 0 ORDER BY created, rowid LIMIT ?1"))?;
        Ok(st.query_map([limit], row)?.collect::<rusqlite::Result<_>>()?)
    }

    /// Gathers a note's readable image text into the note, for search. A
    /// locked note's images are sealed, so it gathers nothing.
    pub(crate) fn refresh_image_text(&self, note_id: &str) -> Result<()> {
        let mut st = self.db.prepare("SELECT text FROM note_files WHERE note_id = ?1 AND sealed = 0 AND text IS NOT NULL AND text <> '' ORDER BY created, rowid")?;
        let texts: Vec<String> = st.query_map([note_id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        let all = texts.join("\n");
        self.db.execute("UPDATE notes SET image_text = ?2 WHERE id = ?1 AND image_text <> ?2", params![note_id, all])?;
        Ok(())
    }

    // ── Sync (ADR-0044) ───────────────────────────────────────────────────

    /// Every image's facts, for the relay's index.
    pub fn note_file_records(&self) -> Result<Vec<NoteFile>> {
        let mut st = self.db.prepare(&format!("SELECT {COLS} FROM note_files ORDER BY created"))?;
        Ok(st.query_map([], row)?.collect::<rusqlite::Result<_>>()?)
    }

    /// An image's bytes exactly as stored (sealed or not), for the relay.
    pub fn note_file_raw(&self, id: &str) -> Result<String> {
        let data: Vec<u8> = self.db.query_row("SELECT data FROM note_files WHERE id = ?1", [id], |r| r.get(0)).optional()?.ok_or_else(|| Error::NotFound("that image is gone".into()))?;
        Ok(B64.encode(data))
    }

    /// Another device's image, kept when it's new here or newer. Returns whether it was.
    pub fn put_note_file(&self, f: &NoteFile, raw_base64: &str) -> Result<bool> {
        let ours: Option<i64> = self.db.query_row("SELECT updated FROM note_files WHERE id = ?1", [&f.id], |r| r.get(0)).optional()?;
        if ours.is_some_and(|u| u >= f.updated) {
            return Ok(false);
        }
        if !MIMES.contains(&f.mime.as_str()) {
            return Err(Error::Invalid("notes take JPEG, PNG, WebP, and GIF images".into()));
        }
        let data = B64.decode(raw_base64).map_err(|_| Error::Invalid("that image is damaged".into()))?;
        if data.len() > MAX_NOTE_FILE + 64 {
            return Err(Error::Invalid("that image is over 10 MB".into()));
        }
        self.db.execute(
            "INSERT INTO note_files (id, note_id, mime, data, sealed, width, height, created, updated, text) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(id) DO UPDATE SET data = excluded.data, sealed = excluded.sealed, mime = excluded.mime, width = excluded.width, height = excluded.height, updated = excluded.updated, text = excluded.text",
            params![f.id, f.note_id, f.mime, data, f.sealed, f.width, f.height, f.created, f.updated, f.text.as_deref().map(|t| if f.sealed { t.to_string() } else { clip(t) })],
        )?;
        self.refresh_image_text(&f.note_id)?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::NoteInput;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n-not-really-an-image";

    fn note(s: &Store) -> String {
        s.create_note(&NoteInput { markdown: "Moodboard".into(), ..Default::default() }).unwrap().summary.id
    }

    #[test]
    fn ids_come_from_the_markdown() {
        let md = "One ![a](note-file:abc-1) two ![b](note-file:XYZ) and ![a again](note-file:abc-1) ![web](https://x/y.png)";
        assert_eq!(note_file_ids(md), vec!["abc-1", "XYZ"]);
        assert_eq!(ext_mime("Photo.JPEG"), Some("image/jpeg"));
        assert_eq!(ext_mime("notes.pdf"), None);
        assert_eq!(mime_ext("image/webp"), "webp");
    }

    #[test]
    fn add_list_and_show() {
        let s = Store::open_in_memory().unwrap();
        let n = note(&s);
        let f = s.add_note_file(&n, "image/PNG", &B64.encode(PNG), Some(640), Some(480), None).unwrap();
        assert_eq!((f.mime.as_str(), f.width, f.size, f.sealed), ("image/png", Some(640), PNG.len() as u32, false));
        assert_eq!(s.note_files(&n).unwrap(), vec![f.clone()]);
        assert_eq!(B64.decode(s.note_file(&f.id, None).unwrap().data_base64).unwrap(), PNG);
        assert!(s.add_note_file(&n, "application/pdf", &B64.encode(PNG), None, None, None).is_err(), "only images");
        assert!(s.add_note_file(&n, "image/png", "!!", None, None, None).is_err(), "damaged");
        assert!(s.add_note_file("nope", "image/png", &B64.encode(PNG), None, None, None).is_err(), "no note");
    }

    #[test]
    fn locking_a_note_seals_its_images() {
        let s = Store::open_in_memory().unwrap();
        let n = note(&s);
        let f = s.add_note_file(&n, "image/png", &B64.encode(PNG), None, None, None).unwrap();
        let k = s.set_notes_passphrase(None, "correct horse", None).unwrap();
        s.lock_note(&n, &k).unwrap();
        let raw = B64.decode(s.note_file_raw(&f.id).unwrap()).unwrap();
        assert!(s.note_file_info(&f.id).unwrap().sealed);
        assert!(!raw.windows(8).any(|w| w == &PNG[..8]), "no plain bytes left");
        assert!(s.note_file(&f.id, None).is_err(), "locked without the key");
        assert_eq!(B64.decode(s.note_file(&f.id, Some(&k)).unwrap().data_base64).unwrap(), PNG);
        // New images in a locked note need the key and arrive sealed.
        assert!(s.add_note_file(&n, "image/png", &B64.encode(PNG), None, None, None).is_err());
        assert!(s.add_note_file(&n, "image/png", &B64.encode(PNG), None, None, Some(&k)).unwrap().sealed);
        // A new passphrase reseals them; the old key no longer opens them.
        let k2 = s.set_notes_passphrase(Some(&k), "battery staple", None).unwrap();
        assert!(s.note_file(&f.id, Some(&k)).is_err());
        assert_eq!(B64.decode(s.note_file(&f.id, Some(&k2)).unwrap().data_base64).unwrap(), PNG);
        s.remove_note_lock(&n, &k2).unwrap();
        assert!(s.note_files(&n).unwrap().iter().all(|f| !f.sealed));
        assert_eq!(B64.decode(s.note_file(&f.id, None).unwrap().data_base64).unwrap(), PNG);
    }

    #[test]
    fn sync_keeps_the_newer_copy() {
        let a = Store::open_in_memory().unwrap();
        let b = Store::open_in_memory().unwrap();
        let n = note(&a);
        let f = a.add_note_file(&n, "image/png", &B64.encode(PNG), None, None, None).unwrap();
        let raw = a.note_file_raw(&f.id).unwrap();
        assert!(b.put_note_file(&f, &raw).unwrap());
        assert!(!b.put_note_file(&f, &raw).unwrap(), "same age: no change");
        assert_eq!(b.note_file_records().unwrap(), vec![f.clone()]);
        assert_eq!(b.note_file(&f.id, None).unwrap().data_base64, B64.encode(PNG));
    }

    #[test]
    fn export_and_import_carry_images() {
        let s = Store::open_in_memory().unwrap();
        let n = note(&s);
        let f = s.add_note_file(&n, "image/png", &B64.encode(PNG), None, None, None).unwrap();
        s.save_note_body(&n, &format!("Moodboard\n\n![Swatch](note-file:{})", f.id), None, true).unwrap();
        assert_eq!(s.note(&n).unwrap().summary.cover.as_deref(), Some(f.id.as_str()), "the card shows it");
        let files = s.export_notes().unwrap();
        let img = files.iter().find(|e| e.data_base64.is_some()).unwrap();
        assert_eq!(img.path, format!("attachments/{}.png", f.id));
        let md = files.iter().find(|e| e.path.ends_with(".md")).unwrap();
        assert!(md.contents.contains(&format!("![Swatch](attachments/{}.png)", f.id)), "{}", md.contents);

        let other = Store::open_in_memory().unwrap();
        let picked: Vec<crate::ImportFile> =
            files.iter().map(|e| crate::ImportFile { path: format!("Export/{}", e.path), contents: e.contents.clone(), modified: None, data_base64: e.data_base64.clone() }).collect();
        let r = other.import_notes(&picked).unwrap();
        assert_eq!((r.imported, r.attachments_dropped), (1, 0));
        let back = other.notes(&crate::NoteQuery::default()).unwrap();
        let body = other.note(&back[0].id).unwrap().markdown;
        let ids = note_file_ids(&body);
        assert_eq!(ids.len(), 1);
        assert_ne!(ids[0], f.id, "a copy of its own");
        assert_eq!(other.note_files(&back[0].id).unwrap()[0].id, ids[0]);
        assert_eq!(B64.decode(other.note_file(&ids[0], None).unwrap().data_base64).unwrap(), PNG);
    }

    #[test]
    fn text_in_images_is_searchable_and_sealed_with_the_note() {
        let s = Store::open_in_memory().unwrap();
        let n = note(&s);
        let f = s.add_note_file(&n, "image/png", &B64.encode(PNG), None, None, None).unwrap();
        assert_eq!(s.note_files_without_text(10).unwrap().len(), 1, "nothing has read it yet");
        s.set_note_file_text(&f.id, "  INVOICE 4417\n  Lisboa  \n", None).unwrap();
        assert!(s.note_files_without_text(10).unwrap().is_empty());
        assert_eq!(s.note_file(&f.id, None).unwrap().text.as_deref(), Some("INVOICE 4417\n  Lisboa"));
        let found = |q: &str| s.notes(&crate::NoteQuery { search: Some(q.into()), ..Default::default() }).unwrap().len();
        assert_eq!(found("lisboa"), 1, "search finds words in its images");
        assert_eq!(found("4417"), 1);

        // Locked: the text is sealed and search can't see it; unlocking brings both back.
        let k = s.set_notes_passphrase(None, "correct horse", None).unwrap();
        s.lock_note(&n, &k).unwrap();
        assert_eq!(found("lisboa"), 0);
        let stored = s.note_file_info(&f.id).unwrap().text.unwrap();
        assert!(!stored.contains("Lisboa"), "sealed at rest");
        assert_eq!(s.note_file(&f.id, Some(&k)).unwrap().text.as_deref(), Some("INVOICE 4417\n  Lisboa"));
        assert!(s.set_note_file_text(&f.id, "x", None).is_err(), "a sealed image's text needs the key");
        let k2 = s.set_notes_passphrase(Some(&k), "battery staple", None).unwrap();
        assert!(s.note_file(&f.id, Some(&k2)).unwrap().text.is_some(), "a new passphrase reseals the text too");
        s.remove_note_lock(&n, &k2).unwrap();
        assert_eq!(found("lisboa"), 1);

        // Another device's copy brings its text; an empty answer means "looked, found none".
        let other = Store::open_in_memory().unwrap();
        let m = note(&other);
        let mut rec = s.note_file_info(&f.id).unwrap();
        rec.note_id = m.clone();
        other.put_note_file(&rec, &s.note_file_raw(&f.id).unwrap()).unwrap();
        assert_eq!(other.notes(&crate::NoteQuery { search: Some("invoice".into()), ..Default::default() }).unwrap().len(), 1);
        let g = other.add_note_file(&m, "image/png", &B64.encode(PNG), None, None, None).unwrap();
        other.set_note_file_text(&g.id, "", None).unwrap();
        assert!(other.note_files_without_text(10).unwrap().is_empty());
        assert_eq!(clip(&"é".repeat(MAX_TEXT + 5)).chars().count(), MAX_TEXT);
    }
}
