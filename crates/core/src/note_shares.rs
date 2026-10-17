//! Notes shared by link (ADR-0056). A shared note's text is its own Yjs
//! document on the owner's relay, `mailbird/shared/<id>`. The owner's devices
//! list their shares in the sync index, which is how the relay knows a link
//! is still good; the link's token is derived from the relay's own token, so
//! nothing secret is stored for it.

use rusqlite::params;

use crate::store::{Store, json};
use crate::{Error, NoteShare, NoteSummary, Result, ShareMode, ShareRole, now};

/// Version 19: a note's share, as JSON (`NULL` when it isn't shared).
pub(crate) const MIGRATE_V19: &str = "ALTER TABLE notes ADD COLUMN share TEXT;";

/// The relay serves `mailbird/shared/<id>` only for ids like these.
fn valid_id(id: &str) -> bool {
    (16..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// A share from someone's link, checked: a guest's, with somewhere to sync.
pub(crate) fn guest_share(s: &NoteShare) -> Result<NoteShare> {
    let relay = s.relay.as_deref().map(str::trim).filter(|r| r.starts_with("ws://") || r.starts_with("wss://"));
    let token = s.token.as_deref().map(str::trim).filter(|t| !t.is_empty());
    match (valid_id(&s.id), relay, token) {
        (true, Some(relay), Some(token)) => Ok(NoteShare {
            id: s.id.clone(),
            role: ShareRole::Guest,
            mode: s.mode,
            revoked: false,
            relay: Some(relay.into()),
            token: Some(token.into()),
            from: s.from.as_deref().map(str::trim).filter(|f| !f.is_empty()).map(Into::into),
        }),
        _ => Err(Error::Invalid("that share link isn't complete".into())),
    }
}

impl Store {
    /// Shares a note by link, or changes what its link allows. A link that
    /// was stopped never comes back: sharing again makes a new one.
    pub fn share_note(&self, id: &str, mode: ShareMode) -> Result<NoteSummary> {
        let n = self.note(id)?.summary;
        if n.locked {
            return Err(Error::Invalid("a locked note can't be shared; remove its lock first".into()));
        }
        let share = match n.share {
            Some(s) if s.role == ShareRole::Guest => return Err(Error::Invalid("only the person who shared this note can change its link".into())),
            Some(s) if !s.revoked => NoteShare { mode, ..s },
            _ => NoteShare { id: uuid::Uuid::new_v4().simple().to_string(), role: ShareRole::Owner, mode, revoked: false, relay: None, token: None, from: None },
        };
        self.write_share(id, Some(&share))
    }

    /// Stops sharing. The owner's link stops working (the record stays, so
    /// the relay keeps refusing it); a guest keeps the note as their own copy.
    pub fn unshare_note(&self, id: &str) -> Result<NoteSummary> {
        let n = self.note(id)?.summary;
        match n.share {
            Some(s) if s.role == ShareRole::Owner && !s.revoked => self.write_share(id, Some(&NoteShare { revoked: true, ..s })),
            Some(s) if s.role == ShareRole::Guest => self.write_share(id, None),
            _ => Ok(n),
        }
    }

    fn write_share(&self, id: &str, share: Option<&NoteShare>) -> Result<NoteSummary> {
        self.db.execute("UPDATE notes SET share = ?2, updated = MAX(?3, updated + 1) WHERE id = ?1", params![id, share.map(json), now()])?;
        Ok(self.note(id)?.summary)
    }

    /// Takes another device's share along with its record.
    pub(crate) fn apply_share(&self, rec: &crate::NoteRecord) -> Result<()> {
        self.db.execute("UPDATE notes SET share = ?2 WHERE id = ?1", params![rec.id, rec.share.as_ref().map(json)])?;
        Ok(())
    }

    /// Whether the note is shared right now, so it can't be locked.
    pub(crate) fn note_is_shared(&self, id: &str) -> Result<bool> {
        Ok(self.note(id)?.summary.share.is_some_and(|s| !s.revoked))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::NoteInput;

    fn note(s: &Store, md: &str) -> String {
        s.create_note(&NoteInput { markdown: md.into(), ..Default::default() }).unwrap().summary.id
    }

    fn guest() -> NoteShare {
        NoteShare {
            id: "0123456789abcdef0123".into(),
            role: ShareRole::Guest,
            mode: ShareMode::View,
            revoked: false,
            relay: Some(" wss://notes.example.com ".into()),
            token: Some("s1.abc".into()),
            from: Some("Ada".into()),
        }
    }

    #[test]
    fn sharing_makes_a_link_and_changing_it_keeps_the_link() {
        let s = Store::open_in_memory().unwrap();
        let n = note(&s, "Trip plan");
        let a = s.share_note(&n, ShareMode::Edit).unwrap().share.unwrap();
        assert_eq!((a.role, a.mode, a.revoked), (ShareRole::Owner, ShareMode::Edit, false));
        assert!(valid_id(&a.id));
        let b = s.share_note(&n, ShareMode::View).unwrap().share.unwrap();
        assert_eq!((b.id.as_str(), b.mode), (a.id.as_str(), ShareMode::View), "the same link, now view-only");
    }

    #[test]
    fn a_stopped_link_stays_stopped() {
        let s = Store::open_in_memory().unwrap();
        let n = note(&s, "Trip plan");
        let a = s.share_note(&n, ShareMode::Edit).unwrap().share.unwrap();
        let stopped = s.unshare_note(&n).unwrap().share.unwrap();
        assert!(stopped.revoked);
        assert_eq!(stopped.id, a.id, "kept, so the relay refuses the old link");
        let again = s.share_note(&n, ShareMode::Edit).unwrap().share.unwrap();
        assert_ne!(again.id, a.id, "sharing again makes a new link");
        assert!(!again.revoked);
    }

    #[test]
    fn a_guest_note_comes_from_a_link_and_becomes_a_copy() {
        let s = Store::open_in_memory().unwrap();
        let g = s.create_note(&NoteInput { markdown: "Trip plan".into(), share: Some(guest()), ..Default::default() }).unwrap().summary;
        let share = g.share.clone().unwrap();
        assert_eq!((share.role, share.relay.as_deref(), share.from.as_deref()), (ShareRole::Guest, Some("wss://notes.example.com"), Some("Ada")));
        assert!(s.share_note(&g.id, ShareMode::Edit).is_err(), "only the owner changes the link");
        assert_eq!(s.unshare_note(&g.id).unwrap().share, None, "a guest's note becomes their own copy");
        assert_eq!(s.note(&g.id).unwrap().markdown, "Trip plan");
    }

    #[test]
    fn incomplete_links_are_refused() {
        let s = Store::open_in_memory().unwrap();
        for bad in [NoteShare { id: "short".into(), ..guest() }, NoteShare { relay: Some("https://x".into()), ..guest() }, NoteShare { token: None, ..guest() }] {
            assert!(s.create_note(&NoteInput { markdown: "x".into(), share: Some(bad), ..Default::default() }).is_err());
        }
    }

    #[test]
    fn shared_and_locked_dont_mix() {
        let s = Store::open_in_memory().unwrap();
        let n = note(&s, "Secret");
        let key = s.set_notes_passphrase(None, "correct horse", None).unwrap();
        s.lock_note(&n, &key).unwrap();
        assert!(s.share_note(&n, ShareMode::Edit).is_err(), "a locked note can't be shared");
        let m = note(&s, "Shared");
        s.share_note(&m, ShareMode::Edit).unwrap();
        assert!(s.lock_note(&m, &key).is_err(), "a shared note can't be locked");
        s.unshare_note(&m).unwrap();
        s.lock_note(&m, &key).unwrap();
    }

    #[test]
    fn shares_sync_with_the_record() {
        let a = Store::open_in_memory().unwrap();
        let n = note(&a, "Trip plan");
        a.share_note(&n, ShareMode::View).unwrap();
        let b = Store::open_in_memory().unwrap();
        for rec in a.note_records().unwrap() {
            b.apply_note_record(&rec).unwrap();
        }
        assert_eq!(b.note(&n).unwrap().summary.share, a.note(&n).unwrap().summary.share);
    }
}
