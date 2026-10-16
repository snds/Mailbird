//! Locked notes (ADR-0043): a passphrase seals a note's text on this device
//! and in sync, the way Apple Notes and Bear lock notes.
//!
//! - One passphrase for every locked note. It's never stored: a PBKDF2 key
//!   is derived from it, and a sealed check value tells right from wrong.
//! - A locked note keeps its title in the clear (as Apple Notes does) and
//!   its text sealed with AES-256-GCM, bound to the note's id. Its body,
//!   snippet, and Yjs state are empty, so search, export, tasks, and links
//!   never see the text.
//! - The key is the caller's to hold while unlocked (the app keeps it in
//!   memory and forgets it after a while); the store never keeps it.

use base64::Engine;
use ring::aead::{AES_256_GCM, Aad, LessSafeKey, NONCE_LEN, Nonce, UnboundKey};
use ring::rand::{SecureRandom, SystemRandom};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::store::{Store, json};
use crate::{Error, NoteDetail, Result, now};

const LOCK_KEY: &str = "notes.lock";
/// What the check value seals, to tell a right passphrase from a wrong one.
const CHECK: &[u8] = b"mailbird notes lock v1";
/// OWASP's 2023 figure for PBKDF2-HMAC-SHA256. Tests use far fewer.
const ITERATIONS: u32 = if cfg!(test) { 1_000 } else { 600_000 };
const MIN_PASSPHRASE: usize = 6;
const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// The key that opens locked notes. Held by the app while unlocked.
#[derive(Clone)]
pub struct NotesKey([u8; 32]);

impl NotesKey {
    /// The key's bytes, to wrap under the shared identity (ADR-0051). The
    /// caller must not store them in the clear.
    pub fn expose_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    /// A key unwrapped from the identity. Check it with
    /// [`Store::verify_notes_key`] before trusting it.
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        NotesKey(bytes)
    }
}

impl std::fmt::Debug for NotesKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("NotesKey(…)")
    }
}

/// Whether a passphrase is set, and its hint.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesLockInfo {
    pub set: bool,
    pub hint: Option<String>,
    /// Filled in by the app: whether the key is in memory right now.
    #[serde(default)]
    pub unlocked: bool,
    /// Filled in by the app: whether this device can try the shared identity
    /// instead of the passphrase (ADR-0051).
    #[serde(default)]
    pub identity: bool,
}

/// The passphrase's salt and check value. It syncs with the notes (in the
/// relay's index), so every device opens the same sealed text with the same
/// words; the newest setting wins, as a changed passphrase should.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesLockSetting {
    salt: String,
    iterations: u32,
    check: String,
    hint: Option<String>,
    #[serde(default)]
    updated: i64,
}

fn derive(passphrase: &str, salt: &[u8], iterations: u32) -> NotesKey {
    let mut out = [0u8; 32];
    let n = std::num::NonZeroU32::new(iterations.max(1)).expect("non-zero");
    ring::pbkdf2::derive(ring::pbkdf2::PBKDF2_HMAC_SHA256, n, salt, passphrase.as_bytes(), &mut out);
    NotesKey(out)
}

fn cipher(key: &NotesKey) -> LessSafeKey {
    LessSafeKey::new(UnboundKey::new(&AES_256_GCM, &key.0).expect("32-byte key"))
}

/// base64(nonce ‖ ciphertext ‖ tag), bound to `aad` (the note's id).
pub(crate) fn seal(key: &NotesKey, aad: &str, plain: &[u8]) -> Result<String> {
    let mut nonce = [0u8; NONCE_LEN];
    SystemRandom::new().fill(&mut nonce).map_err(|_| Error::Invalid("the device couldn't make a random number".into()))?;
    let mut buf = plain.to_vec();
    cipher(key)
        .seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), Aad::from(aad.as_bytes()), &mut buf)
        .map_err(|_| Error::Invalid("couldn't lock the note".into()))?;
    let mut out = nonce.to_vec();
    out.extend(buf);
    Ok(B64.encode(out))
}

pub(crate) fn open(key: &NotesKey, aad: &str, sealed: &str) -> Result<Vec<u8>> {
    let bad = || Error::Invalid("that passphrase doesn't open this note".into());
    let raw = B64.decode(sealed).map_err(|_| bad())?;
    if raw.len() < NONCE_LEN {
        return Err(bad());
    }
    let (nonce, rest) = raw.split_at(NONCE_LEN);
    let mut buf = rest.to_vec();
    let nonce = Nonce::try_assume_unique_for_key(nonce).map_err(|_| bad())?;
    let plain = cipher(key).open_in_place(nonce, Aad::from(aad.as_bytes()), &mut buf).map_err(|_| bad())?;
    Ok(plain.to_vec())
}

fn first_line_title(markdown: &str) -> String {
    crate::notes_store::title_and_snippet(markdown).0
}

impl Store {
    fn lock_setting(&self) -> Result<Option<NotesLockSetting>> {
        // Damaged must not read as "no passphrase": that would offer to set a new one.
        self.setting(LOCK_KEY)?.map(|v| serde_json::from_str(&v).map_err(|_| Error::Invalid("the lock settings are damaged".into()))).transpose()
    }

    /// The setting, for sync.
    pub fn notes_lock_setting(&self) -> Result<Option<NotesLockSetting>> {
        self.lock_setting()
    }

    /// Another device's setting, kept when it's newer. Returns whether it was.
    pub fn apply_notes_lock_setting(&self, remote: &NotesLockSetting) -> Result<bool> {
        if self.lock_setting()?.is_some_and(|l| l.updated >= remote.updated) {
            return Ok(false);
        }
        self.set_setting(LOCK_KEY, Some(&json(remote)))?;
        Ok(true)
    }

    pub fn notes_lock(&self) -> Result<NotesLockInfo> {
        let s = self.lock_setting()?;
        Ok(NotesLockInfo { set: s.is_some(), hint: s.and_then(|s| s.hint), unlocked: false, identity: false })
    }

    /// The key for this passphrase, if it's the right one.
    pub fn unlock_notes(&self, passphrase: &str) -> Result<NotesKey> {
        let Some(s) = self.lock_setting()? else { return Err(Error::Invalid("set a passphrase for locked notes first".into())) };
        let salt = B64.decode(&s.salt).map_err(|_| Error::Invalid("the lock settings are damaged".into()))?;
        let key = derive(passphrase, &salt, s.iterations);
        match open(&key, LOCK_KEY, &s.check) {
            Ok(v) if v == CHECK => Ok(key),
            _ => Err(Error::Invalid("that passphrase isn't right".into())),
        }
    }

    /// Sets the passphrase, or changes it (with the current key), resealing
    /// every locked note. Returns the new key, unlocked.
    pub fn set_notes_passphrase(&self, current: Option<&NotesKey>, passphrase: &str, hint: Option<&str>) -> Result<NotesKey> {
        if passphrase.chars().count() < MIN_PASSPHRASE {
            return Err(Error::Invalid(format!("use at least {MIN_PASSPHRASE} characters")));
        }
        let hint = hint.map(str::trim).filter(|h| !h.is_empty()).map(String::from);
        if hint.as_deref().is_some_and(|h| h.contains(passphrase)) {
            return Err(Error::Invalid("the hint can't contain the passphrase".into()));
        }
        let existing = self.lock_setting()?.is_some();
        if existing && current.is_none() {
            return Err(Error::Invalid("unlock your notes first to change the passphrase".into()));
        }
        let mut salt = [0u8; 16];
        SystemRandom::new().fill(&mut salt).map_err(|_| Error::Invalid("the device couldn't make a random number".into()))?;
        let key = derive(passphrase, &salt, ITERATIONS);
        let tx = self.db.unchecked_transaction()?;
        if let Some(old) = current {
            let mut st = tx.prepare("SELECT id, sealed FROM notes WHERE locked = 1 AND sealed IS NOT NULL")?;
            let rows: Vec<(String, String)> = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
            drop(st);
            for (id, sealed) in rows {
                let plain = open(old, &id, &sealed)?;
                tx.execute("UPDATE notes SET sealed = ?2, updated = MAX(?3, updated + 1) WHERE id = ?1", params![id, seal(&key, &id, &plain)?, now()])?;
                self.reseal_note_files(&id, Some(old), Some(&key))?;
            }
        }
        let setting = NotesLockSetting { salt: B64.encode(salt), iterations: ITERATIONS, check: seal(&key, LOCK_KEY, CHECK)?, hint, updated: now() };
        tx.execute("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![LOCK_KEY, json(&setting)])?;
        tx.commit()?;
        Ok(key)
    }

    /// Seals the note's text. Its title stays readable; everything else empties.
    pub fn lock_note(&self, id: &str, key: &NotesKey) -> Result<()> {
        self.unlock_notes_check(key)?;
        let n = self.note(id)?;
        if n.summary.locked {
            return Ok(());
        }
        let sealed = seal(key, id, n.markdown.as_bytes())?;
        self.db.execute(
            "UPDATE notes SET locked = 1, sealed = ?2, body = '', snippet = '', ydoc = NULL, image_text = '', updated = MAX(?3, updated + 1) WHERE id = ?1",
            params![id, sealed, now()],
        )?;
        self.reseal_note_files(id, None, Some(key))
    }

    /// Takes the lock off: the text goes back to being an ordinary note's.
    pub fn remove_note_lock(&self, id: &str, key: &NotesKey) -> Result<NoteDetail> {
        let markdown = self.locked_markdown(id, key)?;
        let (title, snippet) = crate::notes_store::title_and_snippet(&markdown);
        self.db.execute(
            "UPDATE notes SET locked = 0, sealed = NULL, title = ?2, snippet = ?3, body = ?4, updated = MAX(?5, updated + 1) WHERE id = ?1",
            params![id, title, snippet, markdown, now()],
        )?;
        self.reseal_note_files(id, Some(key), None)?;
        self.note(id)
    }

    fn locked_markdown(&self, id: &str, key: &NotesKey) -> Result<String> {
        let sealed: Option<Option<String>> = self.db.query_row("SELECT sealed FROM notes WHERE id = ?1 AND deleted = 0 AND locked = 1", [id], |r| r.get(0)).optional()?;
        let Some(sealed) = sealed.flatten() else { return Err(Error::NotFound("that locked note is gone".into())) };
        String::from_utf8(open(key, id, &sealed)?).map_err(|_| Error::Invalid("the note's text is damaged".into()))
    }

    /// A locked note with its text, for the editor while unlocked. It has no
    /// Yjs state: locked notes don't merge live (ADR-0043).
    pub fn open_locked_note(&self, id: &str, key: &NotesKey) -> Result<NoteDetail> {
        let mut n = self.note(id)?;
        n.markdown = self.locked_markdown(id, key)?;
        n.ydoc = None;
        Ok(n)
    }

    /// Saves a locked note's text, sealed again. The title follows the first line.
    pub fn save_locked_note(&self, id: &str, markdown: &str, key: &NotesKey, touch: bool) -> Result<()> {
        let old = self.locked_markdown(id, key)?;
        let touch = touch && old != markdown;
        self.db.execute(
            "UPDATE notes SET sealed = ?2, title = ?3, updated = CASE WHEN ?4 THEN MAX(?5, updated + 1) ELSE updated END WHERE id = ?1 AND locked = 1",
            params![id, seal(key, id, markdown.as_bytes())?, first_line_title(markdown), touch, now()],
        )?;
        Ok(())
    }

    /// Whether `key` opens this device's locked notes: a key unwrapped from
    /// the identity may be one an older passphrase made (ADR-0051).
    pub fn verify_notes_key(&self, key: &NotesKey) -> Result<()> {
        self.unlock_notes_check(key)
    }

    /// A key from another session still opens this device's notes.
    fn unlock_notes_check(&self, key: &NotesKey) -> Result<()> {
        let Some(s) = self.lock_setting()? else { return Err(Error::Invalid("set a passphrase for locked notes first".into())) };
        match open(key, LOCK_KEY, &s.check) {
            Ok(v) if v == CHECK => Ok(()),
            _ => Err(Error::Invalid("the passphrase changed: unlock again".into())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{NoteInput, NoteQuery};

    fn store() -> Store {
        Store::open_in_memory().unwrap()
    }

    #[test]
    fn seal_and_open_bind_to_the_note() {
        let k = derive("correct horse", b"salt-salt-salt-1", 1_000);
        let s = seal(&k, "n1", b"secret").unwrap();
        assert_eq!(open(&k, "n1", &s).unwrap(), b"secret");
        assert!(open(&k, "n2", &s).is_err(), "moved to another note, it doesn't open");
        assert!(open(&derive("wrong horse", b"salt-salt-salt-1", 1_000), "n1", &s).is_err());
        assert_ne!(seal(&k, "n1", b"secret").unwrap(), s, "a fresh nonce every time");
    }

    #[test]
    fn a_key_from_its_bytes_opens_only_while_its_passphrase_stands() {
        let s = store();
        let n = s.create_note(&NoteInput { markdown: "PIN\n\n4321".into(), ..Default::default() }).unwrap().summary.id;
        let key = s.set_notes_passphrase(None, "lighthouse", None).unwrap();
        s.lock_note(&n, &key).unwrap();

        // What the identity hands back (ADR-0051) is the same key.
        let back = NotesKey::from_bytes(*key.expose_bytes());
        s.verify_notes_key(&back).unwrap();
        assert!(s.open_locked_note(&n, &back).unwrap().markdown.contains("4321"));
        assert!(s.verify_notes_key(&NotesKey::from_bytes([7; 32])).is_err(), "any other key is refused");

        // A changed passphrase reseals everything: the old wrapped key opens nothing.
        let newer = s.set_notes_passphrase(Some(&key), "harbour light", None).unwrap();
        assert!(s.verify_notes_key(&back).is_err());
        s.verify_notes_key(&newer).unwrap();
        assert!(format!("{back:?}") == "NotesKey(…)", "never printed");
    }

    #[test]
    fn lock_hide_edit_unlock() {
        let s = store();
        let n = s.create_note(&NoteInput { markdown: "Bank details\n\nIBAN PT50 0000 1234".into(), ..Default::default() }).unwrap().summary.id;
        assert!(!s.notes_lock().unwrap().set);
        assert!(s.unlock_notes("whatever").is_err(), "nothing to unlock yet");
        assert!(s.set_notes_passphrase(None, "short", None).unwrap_err().to_string().contains("at least 6"));
        assert!(s.set_notes_passphrase(None, "lighthouse", Some("the lighthouse trip")).is_err(), "the hint can't give it away");
        let key = s.set_notes_passphrase(None, "lighthouse", Some("Where we went in May")).unwrap();
        assert_eq!(s.notes_lock().unwrap().hint.as_deref(), Some("Where we went in May"));
        s.lock_note(&n, &key).unwrap();

        // Locked: the title shows; the text is nowhere readable.
        let d = s.note(&n).unwrap();
        assert!(d.summary.locked);
        assert_eq!((d.summary.title.as_str(), d.summary.snippet.as_str(), d.markdown.as_str(), d.ydoc.as_deref()), ("Bank details", "", "", None));
        assert!(s.notes(&NoteQuery { search: Some("IBAN".into()), ..Default::default() }).unwrap().is_empty(), "search can't see it");
        assert!(s.export_notes().unwrap().iter().all(|f| !f.contents.contains("IBAN")), "export can't either");
        let raw: String = s.db.query_row("SELECT sealed FROM notes WHERE id = ?1", [&n], |r| r.get(0)).unwrap();
        assert!(!raw.contains("IBAN"));
        assert!(s.save_note_body(&n, "leak", None, true).is_err(), "the plain save path refuses a locked note");

        // Unlocked with the right passphrase only.
        assert!(s.unlock_notes("lighthous").unwrap_err().to_string().contains("isn't right"));
        let key = s.unlock_notes("lighthouse").unwrap();
        assert_eq!(s.open_locked_note(&n, &key).unwrap().markdown, "Bank details\n\nIBAN PT50 0000 1234");
        s.save_locked_note(&n, "Bank (old)\n\nIBAN PT50 0000 9999", &key, true).unwrap();
        assert_eq!(s.note(&n).unwrap().summary.title, "Bank (old)", "the title follows the first line");
        assert!(s.open_locked_note(&n, &key).unwrap().markdown.ends_with("9999"));

        // Change the passphrase: the old key stops working, the note still opens.
        assert!(s.set_notes_passphrase(None, "harbour lights", None).is_err(), "changing needs the current key");
        let new = s.set_notes_passphrase(Some(&key), "harbour lights", None).unwrap();
        assert!(s.unlock_notes("lighthouse").is_err());
        assert!(s.lock_note(&n, &key).is_err() || s.open_locked_note(&n, &key).is_err(), "the old key is useless");
        assert!(s.open_locked_note(&n, &new).unwrap().markdown.ends_with("9999"));

        // Remove the lock: an ordinary note again, searchable.
        let back = s.remove_note_lock(&n, &new).unwrap();
        assert!(!back.summary.locked && back.markdown.contains("9999"));
        assert_eq!(s.notes(&NoteQuery { search: Some("IBAN".into()), ..Default::default() }).unwrap().len(), 1);
    }

    #[test]
    fn locked_notes_sync_sealed() {
        let s = store();
        let n = s.create_note(&NoteInput { markdown: "Diary\n\nDear diary".into(), ..Default::default() }).unwrap().summary.id;
        let key = s.set_notes_passphrase(None, "lighthouse", None).unwrap();
        s.lock_note(&n, &key).unwrap();
        let rec = s.note_records().unwrap().remove(0);
        assert!(rec.locked && rec.title.as_deref() == Some("Diary"));
        assert!(!rec.sealed.as_deref().unwrap().contains("Dear"), "the record carries only the sealed text");
        // Another device with the same passphrase opens it.
        let other = store();
        other.apply_note_record(&rec).unwrap();
        let d = other.note(&n).unwrap();
        assert!(d.summary.locked && d.summary.title == "Diary" && d.markdown.is_empty());
        // The passphrase setting travels too, so the same words open it there.
        assert!(other.apply_notes_lock_setting(&s.notes_lock_setting().unwrap().unwrap()).unwrap());
        assert!(!other.apply_notes_lock_setting(&s.notes_lock_setting().unwrap().unwrap()).unwrap(), "once");
        let k2 = other.unlock_notes("lighthouse").unwrap();
        assert_eq!(other.open_locked_note(&n, &k2).unwrap().markdown, "Diary\n\nDear diary");
    }
}
