//! Calendars and contacts in the local store.
//!
//! Each event or contact row keeps the server's resource verbatim (`ics` /
//! `vcf`) plus a few indexed fields for lists. Edits rewrite the resource
//! (see `ical` and `vcard`) and mark the row `changed`; deletes mark it
//! `deleted`. The DAV sync pushes those first, then pulls. A conflict (the
//! server copy changed since we read it) resolves to the server's version.
//!
//! Collections with no account live only on this device and never sync.

use std::collections::{HashMap, HashSet};

use rusqlite::{OptionalExtension, Row, params};

use crate::store::{Store, from_json, json};
use crate::{
    Collection, CollectionKind, ContactDetail, ContactInput, ContactSummary, DavBatch, DavChange, DavCursor, DavOutcome,
    EditScope, Error, EventDetail, EventInput, Occurrence, RemoteCollection, Result, ical, vcard,
};

/// Version 4: calendars and address books, events, contacts, settings.
pub(crate) const MIGRATE_V4: &str = r#"
CREATE TABLE collections (
  id          TEXT PRIMARY KEY,
  account_id  TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  href        TEXT,
  name        TEXT NOT NULL,
  color       TEXT,
  sync_token  TEXT,
  writable    INTEGER NOT NULL DEFAULT 1,
  hidden      INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX collections_href ON collections (account_id, href) WHERE href IS NOT NULL;

CREATE TABLE events (
  id            TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  href          TEXT,
  etag          TEXT,
  uid           TEXT NOT NULL,
  ics           TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'synced',
  title         TEXT NOT NULL,
  location      TEXT,
  all_day       INTEGER NOT NULL,
  recurring     INTEGER NOT NULL,
  first_start   INTEGER NOT NULL,
  last_end      INTEGER
);
CREATE INDEX events_window ON events (first_start, last_end);
CREATE UNIQUE INDEX events_href ON events (collection_id, href) WHERE href IS NOT NULL;

CREATE TABLE contacts (
  id            TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  href          TEXT,
  etag          TEXT,
  uid           TEXT NOT NULL,
  vcf           TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'synced',
  full_name     TEXT NOT NULL,
  sort_key      TEXT NOT NULL,
  org           TEXT,
  emails        TEXT NOT NULL DEFAULT '[]',
  phones        TEXT NOT NULL DEFAULT '[]',
  photo         TEXT
);
CREATE INDEX contacts_sort ON contacts (sort_key);
CREATE UNIQUE INDEX contacts_href ON contacts (collection_id, href) WHERE href IS NOT NULL;

ALTER TABLE accounts ADD COLUMN dav_last_sync INTEGER;
ALTER TABLE accounts ADD COLUMN dav_error TEXT;

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"#;

/// Version 5: each event's reminder lead times (minutes), for due checks.
pub(crate) const MIGRATE_V5: &str = r#"
ALTER TABLE events ADD COLUMN alarms TEXT NOT NULL DEFAULT '[]';
ALTER TABLE collections ADD COLUMN scheduling INTEGER NOT NULL DEFAULT 0;
"#;

/// Whether any occurrence of an event has travel time (indexed so reminder
/// checks only parse events that can fire).
fn series_travel(ics: &str, m: &ical::EventMeta) -> Option<i64> {
    m.travel.or_else(|| ics.to_ascii_uppercase().contains("X-APPLE-TRAVEL-DURATION").then_some(0))
}

/// Version 12: each event's travel time (minutes), for "time to leave" checks.
pub(crate) const MIGRATE_V12: &str = "ALTER TABLE events ADD COLUMN travel INTEGER;";

/// Reminders are looked up this far ahead of an occurrence at most.
const MAX_LEAD_MINUTES: i64 = 14 * 24 * 60;

/// All-day and floating events are indexed on the device clock; widen
/// window queries by a day so a time-zone change can't hide them.
const SLACK: i64 = 86_400;

const SYNCED: &str = "synced";
pub(crate) const CHANGED: &str = "changed";
const DELETED: &str = "deleted";

fn table(kind: CollectionKind) -> &'static str {
    match kind {
        CollectionKind::Calendar => "events",
        CollectionKind::Contacts => "contacts",
    }
}

fn body_col(kind: CollectionKind) -> &'static str {
    match kind {
        CollectionKind::Calendar => "ics",
        CollectionKind::Contacts => "vcf",
    }
}

fn parse_kind(s: &str) -> CollectionKind {
    if s == "contacts" { CollectionKind::Contacts } else { CollectionKind::Calendar }
}

fn collection_row(r: &Row) -> rusqlite::Result<Collection> {
    Ok(Collection {
        id: r.get(0)?,
        account_id: r.get(1)?,
        kind: parse_kind(&r.get::<_, String>(2)?),
        name: r.get(3)?,
        color: r.get(4)?,
        writable: r.get(5)?,
        hidden: r.get(6)?,
        scheduling: r.get(7)?,
    })
}

const COLLECTION_COLS: &str = "id, account_id, kind, name, color, writable, hidden, scheduling";

/// Where a new resource goes on the server: the collection URL plus a file name.
pub(crate) fn child_href(collection_href: Option<&str>, uid: &str, ext: &str) -> Option<String> {
    collection_href.map(|h| format!("{}/{uid}.{ext}", h.trim_end_matches('/')))
}

fn sort_key(meta: &vcard::ContactMeta) -> String {
    let lead = meta.family.as_deref().filter(|f| !f.is_empty()).unwrap_or(&meta.full_name);
    format!("{} {}", lead.to_lowercase(), meta.full_name.to_lowercase())
}

pub(crate) fn name_key(name: &str) -> String {
    name.chars().filter(|c| c.is_alphanumeric() || c.is_whitespace()).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

impl Store {
    // ── Settings ──────────────────────────────────────────────────────────

    /// The device's IANA time zone, which places all-day and floating events.
    pub fn time_zone(&self) -> Result<String> {
        Ok(self
            .db
            .query_row("SELECT value FROM settings WHERE key = 'time_zone'", [], |r| r.get(0))
            .optional()?
            .unwrap_or_else(|| "UTC".to_string()))
    }

    /// Updates the zone, re-indexing all-day and floating events when it changes.
    pub fn set_time_zone(&self, tz: &str) -> Result<()> {
        if self.time_zone()? == tz {
            return Ok(());
        }
        self.db.execute("INSERT INTO settings (key, value) VALUES ('time_zone', ?1) ON CONFLICT (key) DO UPDATE SET value = ?1", [tz])?;
        let rows: Vec<(String, String)> =
            self.db.prepare("SELECT id, ics FROM events WHERE all_day = 1")?.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
        for (id, ics) in rows {
            if let Ok(m) = ical::read_event(&ics, tz) {
                self.db.execute("UPDATE events SET first_start = ?2, last_end = ?3 WHERE id = ?1", params![id, m.first_start, m.last_end])?;
            }
        }
        Ok(())
    }

    // ── Collections ───────────────────────────────────────────────────────

    /// Makes sure there is somewhere to save without any account: one
    /// on-device calendar and one on-device address book.
    pub fn ensure_local_collections(&self) -> Result<()> {
        for (kind, name) in [(CollectionKind::Calendar, "On this device"), (CollectionKind::Contacts, "On this device")] {
            let exists: bool = self.db.query_row(
                "SELECT EXISTS (SELECT 1 FROM collections WHERE account_id IS NULL AND kind = ?1 AND id <> 'birthdays' AND id NOT LIKE 'interesting:%')",
                [kind.as_str()],
                |r| r.get(0),
            )?;
            if !exists {
                self.db.execute(
                    "INSERT INTO collections (id, account_id, kind, name) VALUES (?1, NULL, ?2, ?3)",
                    params![uuid::Uuid::new_v4().to_string(), kind.as_str(), name],
                )?;
            }
        }
        Ok(())
    }

    pub fn collections(&self, kind: CollectionKind) -> Result<Vec<Collection>> {
        let mut st = self.db.prepare(&format!(
            "SELECT {COLLECTION_COLS} FROM collections WHERE kind = ?1 ORDER BY account_id IS NULL, id = 'birthdays' OR id LIKE 'interesting:%', account_id, name COLLATE NOCASE"
        ))?;
        Ok(st.query_map([kind.as_str()], collection_row)?.collect::<rusqlite::Result<_>>()?)
    }

    pub fn collection(&self, id: &str) -> Result<Collection> {
        self.db
            .query_row(&format!("SELECT {COLLECTION_COLS} FROM collections WHERE id = ?1"), [id], collection_row)
            .optional()?
            .ok_or_else(|| Error::NotFound("that calendar or address book is gone".into()))
    }

    pub fn set_collection_hidden(&self, id: &str, hidden: bool) -> Result<()> {
        self.db.execute("UPDATE collections SET hidden = ?2 WHERE id = ?1", params![id, hidden])?;
        Ok(())
    }

    pub(crate) fn collection_href(&self, id: &str) -> Result<Option<String>> {
        Ok(self.db.query_row("SELECT href FROM collections WHERE id = ?1", [id], |r| r.get(0))?)
    }

    pub(crate) fn writable(&self, id: &str) -> Result<Collection> {
        let c = self.collection(id)?;
        if !c.writable {
            return Err(Error::Invalid(format!("“{}” is read-only", c.name)));
        }
        Ok(c)
    }

    /// Mirrors the server's collection list for one account and kind:
    /// new ones are added, renamed ones updated, missing ones removed.
    pub fn sync_collections(&self, account_id: &str, kind: CollectionKind, remote: &[RemoteCollection]) -> Result<()> {
        let tx = self.db.unchecked_transaction()?;
        let hrefs: Vec<&str> = remote.iter().map(|c| c.href.as_str()).collect();
        let existing: Vec<(String, String)> = tx
            .prepare("SELECT id, href FROM collections WHERE account_id = ?1 AND kind = ?2")?
            .query_map(params![account_id, kind.as_str()], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        for (id, href) in &existing {
            if !hrefs.contains(&href.as_str()) {
                tx.execute("DELETE FROM collections WHERE id = ?1", [id])?;
            }
        }
        for c in remote.iter().filter(|c| c.kind == kind) {
            tx.execute(
                "INSERT INTO collections (id, account_id, kind, href, name, color, writable, scheduling) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT (account_id, href) WHERE href IS NOT NULL DO UPDATE SET name = ?5, color = ?6, writable = ?7, scheduling = ?8",
                params![uuid::Uuid::new_v4().to_string(), account_id, kind.as_str(), c.href, c.name, c.color, c.writable, c.scheduling],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    // ── Events ────────────────────────────────────────────────────────────

    /// Occurrences overlapping `[from, to)` in visible calendars, by start.
    pub fn occurrences(&self, from: i64, to: i64) -> Result<Vec<Occurrence>> {
        let tz = self.time_zone()?;
        let mut st = self.db.prepare(
            "SELECT e.id, e.collection_id, e.ics, e.all_day, e.recurring FROM events e
             JOIN collections c ON c.id = e.collection_id
             WHERE c.hidden = 0 AND e.state != 'deleted' AND e.first_start < ?2 AND (e.last_end IS NULL OR e.last_end > ?1)",
        )?;
        let rows = st.query_map(params![from - SLACK, to + SLACK], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, bool>(3)?, r.get::<_, bool>(4)?))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (id, calendar_id, ics, all_day, recurring) = row?;
            for o in ical::occurrences(&ics, &tz, from, to).unwrap_or_default() {
                out.push(Occurrence {
                    event_id: id.clone(),
                    calendar_id: calendar_id.clone(),
                    meeting_url: o.meeting_url.clone(),
                    meeting_app_url: None,
                    contact_id: None,
                    title: o.title,
                    location: o.location,
                    start: o.start,
                    end: o.end,
                    original_start: o.original,
                    all_day,
                    recurring,
                    travel: o.travel,
                });
            }
        }
        for o in &mut out {
            o.meeting_app_url = o.meeting_url.as_deref().and_then(crate::meeting::app_link);
        }
        out.extend(self.birthdays(from, to)?);
        out.extend(self.interesting_occurrences(from, to)?);
        out.sort_by(|a, b| (b.all_day, a.start, &a.title).cmp(&(a.all_day, b.start, &b.title)));
        Ok(out)
    }

    /// One event, at the occurrence starting at `start` (or its first one).
    pub fn event(&self, id: &str, start: Option<i64>) -> Result<EventDetail> {
        if let Some(contact) = id.strip_prefix(crate::connected_store::BIRTHDAY_PREFIX) {
            return self.birthday_event(contact, start);
        }
        if id.starts_with(crate::interesting::SPECIAL_PREFIX) {
            return self.special_event(id);
        }
        let (calendar_id, ics): (String, String) = self
            .db
            .query_row("SELECT collection_id, ics FROM events WHERE id = ?1 AND state != 'deleted'", [id], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?
            .ok_or_else(|| Error::NotFound("that event was deleted".into()))?;
        let tz = self.time_zone()?;
        let meta = ical::read_event(&ics, &tz)?;
        let instances = ical::occurrences(&ics, &tz, start.map_or(i64::MIN, |s| s - 1), i64::MAX)?;
        let inst = start
            .and_then(|s| instances.iter().find(|o| o.start == s).or_else(|| instances.iter().find(|o| o.original == s)))
            .or(instances.first())
            .cloned()
            .ok_or_else(|| Error::NotFound("that occurrence is gone".into()))?;
        // Conference properties first: they're the server's own record of the call.
        let texts: Vec<&str> = meta.conference.iter().map(String::as_str).chain([inst.location.as_deref(), meta.url.as_deref(), meta.notes.as_deref()].into_iter().flatten()).collect();
        let meeting = crate::meeting::meeting_info(texts.iter().copied());
        let manage = crate::meeting::manage_links([meta.notes.as_deref(), meta.url.as_deref(), inst.location.as_deref()].into_iter().flatten());
        Ok(EventDetail {
            occurrence: Occurrence {
                event_id: id.to_string(),
                calendar_id: calendar_id.clone(),
                meeting_url: meeting.as_ref().map(|m| m.url.clone()),
                meeting_app_url: meeting.as_ref().and_then(|m| m.app_url.clone()),
                contact_id: None,
                travel: inst.travel,
                title: inst.title,
                location: inst.location,
                start: inst.start,
                end: inst.end,
                original_start: inst.original,
                all_day: meta.all_day,
                recurring: meta.recurring,
            },
            notes: meta.notes,
            repeat: meta.repeat,
            time_zone: meta.time_zone,
            organizer: meta.organizer,
            attendees: meta.attendees,
            url: meta.url,
            writable: self.collection(&calendar_id)?.writable,
            reminders: meta.reminders,
            meeting,
            manage,
        })
    }

    fn index_event(&self, ics: &str) -> ical::EventMeta {
        let tz = self.time_zone().unwrap_or_else(|_| "UTC".into());
        // An event we can't read still gets a row, so sync knows it has it;
        // the zero window keeps it out of every view.
        ical::read_event(ics, &tz).unwrap_or(ical::EventMeta {
            uid: String::new(),
            title: "(unreadable event)".into(),
            location: None,
            notes: None,
            all_day: false,
            recurring: false,
            repeat: crate::Repeat::None,
            time_zone: None,
            first_start: 0,
            last_end: Some(0),
            organizer: None,
            attendees: vec![],
            url: None,
            reminders: vec![],
            travel: None,
            conference: vec![],
        })
    }

    pub(crate) fn insert_event(&self, collection_id: &str, href: Option<&str>, etag: Option<&str>, ics: &str, state: &str) -> Result<String> {
        let m = self.index_event(ics);
        let id = uuid::Uuid::new_v4().to_string();
        self.db.execute(
            "INSERT INTO events (id, collection_id, href, etag, uid, ics, state, title, location, all_day, recurring, first_start, last_end, alarms, travel)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            params![id, collection_id, href, etag, m.uid, ics, state, m.title, m.location, m.all_day, m.recurring, m.first_start, m.last_end, json(&m.reminders), series_travel(ics, &m)],
        )?;
        Ok(id)
    }

    pub(crate) fn rewrite_event(&self, id: &str, ics: &str, state: &str) -> Result<()> {
        let m = self.index_event(ics);
        self.db.execute(
            "UPDATE events SET ics = ?2, state = ?3, title = ?4, location = ?5, all_day = ?6, recurring = ?7, first_start = ?8, last_end = ?9, alarms = ?10, travel = ?11 WHERE id = ?1",
            params![id, ics, state, m.title, m.location, m.all_day, m.recurring, m.first_start, m.last_end, json(&m.reminders), series_travel(ics, &m)],
        )?;
        Ok(())
    }

    /// Local edits on a synced collection wait for the next push; on-device
    /// collections are always "synced".
    pub(crate) fn edit_state(c: &Collection) -> &'static str {
        if c.account_id.is_some() { CHANGED } else { SYNCED }
    }

    pub fn create_event(&self, input: &EventInput) -> Result<EventDetail> {
        let c = self.writable(&input.calendar_id)?;
        Self::guests_allowed(&c, input)?;
        let uid = format!("{}@mailbird", uuid::Uuid::new_v4());
        let ics = ical::new_event(&uid, input)?;
        let href = child_href(self.collection_href(&c.id)?.as_deref(), &uid, "ics");
        let id = self.insert_event(&c.id, href.as_deref(), None, &ics, Self::edit_state(&c))?;
        if let Some(guests) = &input.attendees {
            self.apply_guests(&id, None, guests)?;
        }
        self.event(&id, None)
    }

    /// Guests need an account to send from (or a server that schedules).
    fn guests_allowed(c: &Collection, input: &EventInput) -> Result<()> {
        if c.account_id.is_none() && input.attendees.as_ref().is_some_and(|g| !g.is_empty()) {
            return Err(Error::Invalid("invitations need a calendar on a mail account".into()));
        }
        Ok(())
    }

    /// Edits an event. For a series, `scope` picks the occurrences:
    /// `All` (the series), `This` (one occurrence, as an override), or
    /// `Following` (ends the series there and starts a new one). `occurrence`
    /// is the occurrence's `original_start`.
    ///
    /// Moving the whole series to another calendar deletes the resource
    /// there and recreates it here (CalDAV has no cross-collection move we
    /// can rely on).
    pub fn update_event(&self, id: &str, input: &EventInput, scope: EditScope, occurrence: Option<i64>) -> Result<EventDetail> {
        let (calendar_id, ics, recurring): (String, String, bool) =
            self.db.query_row("SELECT collection_id, ics, recurring FROM events WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        let from = self.writable(&calendar_id)?;
        Self::guests_allowed(&self.collection(&input.calendar_id)?, input)?;
        let tz = self.time_zone()?;
        let at = occurrence.filter(|_| recurring && scope != EditScope::All);
        match (scope, at) {
            (EditScope::This, Some(at)) => {
                if input.calendar_id != calendar_id {
                    return Err(Error::Invalid("one occurrence can't move to another calendar; move the whole series instead".into()));
                }
                let edited = ical::edit_occurrence(&ics, at, input, &tz)?;
                self.rewrite_event(id, &edited, Self::edit_state(&from))?;
                return self.event(id, None);
            }
            (EditScope::Following, Some(at)) if at > ical::read_event(&ics, &tz)?.first_start => {
                let to = self.writable(&input.calendar_id)?;
                let uid = format!("{}@mailbird", uuid::Uuid::new_v4());
                let tail = ical::split_series(&ics, at, &uid, input, &tz)?;
                let head = ical::end_series_before(&ics, at, &tz)?;
                self.rewrite_event(id, &head, Self::edit_state(&from))?;
                let href = child_href(self.collection_href(&to.id)?.as_deref(), &uid, "ics");
                let new_id = self.insert_event(&to.id, href.as_deref(), None, &tail, Self::edit_state(&to))?;
                if let Some(guests) = &input.attendees {
                    self.apply_guests(&new_id, Some(&tail), guests)?;
                }
                return self.event(&new_id, None);
            }
            // "Following" from the first occurrence is the whole series.
            _ => {}
        }
        let edited = ical::edit_event(&ics, input)?;
        if calendar_id == input.calendar_id {
            self.rewrite_event(id, &edited, Self::edit_state(&from))?;
            if let Some(guests) = &input.attendees {
                self.apply_guests(id, Some(&ics), guests)?;
            }
            return self.event(id, None);
        }
        let to = self.writable(&input.calendar_id)?;
        let uid = ical::read_event(&edited, "UTC")?.uid;
        self.remove_item(CollectionKind::Calendar, id, &from)?;
        let href = child_href(self.collection_href(&to.id)?.as_deref(), &uid, "ics");
        let new_id = self.insert_event(&to.id, href.as_deref(), None, &edited, Self::edit_state(&to))?;
        if let Some(guests) = &input.attendees {
            self.apply_guests(&new_id, Some(&ics), guests)?;
        }
        self.event(&new_id, None)
    }

    /// Deletes an event, one occurrence of a series (`This`), or an
    /// occurrence and everything after it (`Following`). `occurrence` is
    /// the occurrence's `original_start`.
    pub fn delete_event(&self, id: &str, occurrence: Option<i64>, scope: EditScope) -> Result<()> {
        let (calendar_id, ics, recurring): (String, String, bool) =
            self.db.query_row("SELECT collection_id, ics, recurring FROM events WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        let c = self.writable(&calendar_id)?;
        let tz = self.time_zone()?;
        match (scope, occurrence.filter(|_| recurring)) {
            (EditScope::This, Some(at)) => self.rewrite_event(id, &ical::skip_occurrence(&ics, at, &tz)?, Self::edit_state(&c)),
            (EditScope::Following, Some(at)) if at > ical::read_event(&ics, &tz)?.first_start => {
                self.rewrite_event(id, &ical::end_series_before(&ics, at, &tz)?, Self::edit_state(&c))
            }
            _ => {
                // Guests hear about it, unless their server tells them.
                self.cancel_for_guests(id)?;
                self.remove_item(CollectionKind::Calendar, id, &c)
            }
        }
    }

    /// Local rows go now; synced rows wait as `deleted` until the server
    /// confirms, unless the server never had them.
    pub(crate) fn remove_item(&self, kind: CollectionKind, id: &str, c: &Collection) -> Result<()> {
        let t = table(kind);
        let etag: Option<String> = self.db.query_row(&format!("SELECT etag FROM {t} WHERE id = ?1"), [id], |r| r.get(0))?;
        if c.account_id.is_none() || etag.is_none() {
            self.db.execute(&format!("DELETE FROM {t} WHERE id = ?1"), [id])?;
        } else {
            self.db.execute(&format!("UPDATE {t} SET state = 'deleted' WHERE id = ?1"), [id])?;
        }
        Ok(())
    }

    /// Re-derives every event's indexed fields (after a schema upgrade).
    pub(crate) fn reindex_events(&self) -> Result<()> {
        let rows: Vec<(String, String)> = self.db.prepare("SELECT id, ics FROM events")?.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
        for (id, ics) in rows {
            let m = self.index_event(&ics);
            self.db.execute(
                "UPDATE events SET title = ?2, location = ?3, all_day = ?4, recurring = ?5, first_start = ?6, last_end = ?7, alarms = ?8, travel = ?9 WHERE id = ?1",
                params![id, m.title, m.location, m.all_day, m.recurring, m.first_start, m.last_end, json(&m.reminders), series_travel(&ics, &m)],
            )?;
        }
        Ok(())
    }

    /// Reminders that fall in `(after, until]`, in visible calendars, by
    /// time. The caller remembers `until` and passes it as the next `after`,
    /// so each fires once.
    pub fn due_reminders(&self, after: i64, until: i64) -> Result<Vec<crate::DueReminder>> {
        let tz = self.time_zone()?;
        let mut st = self.db.prepare(
            "SELECT e.id, e.ics, e.alarms FROM events e JOIN collections c ON c.id = e.collection_id
             WHERE c.hidden = 0 AND e.state != 'deleted' AND (e.alarms != '[]' OR e.travel IS NOT NULL)
               AND e.first_start <= ?2 AND (e.last_end IS NULL OR e.last_end > ?1)",
        )?;
        let rows = st.query_map(params![after - SLACK, until + MAX_LEAD_MINUTES * 60 + SLACK], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?;
        let mut out = Vec::new();
        for row in rows {
            let (id, ics, alarms) = row?;
            let leads: Vec<i64> = from_json(alarms);
            // Travel can reach back up to a day: look that far ahead too.
            let max = leads.iter().copied().max().unwrap_or(0).max(24 * 60);
            let min = leads.iter().copied().min().unwrap_or(0);
            // Occurrences whose reminders could land in the window.
            for o in ical::occurrences(&ics, &tz, after + min.min(0) * 60, until + max * 60 + 1).unwrap_or_default() {
                for lead in &leads {
                    let fire_at = o.start - lead * 60;
                    if fire_at > after && fire_at <= until {
                        out.push(crate::DueReminder { event_id: id.clone(), title: o.title.clone(), location: o.location.clone(), start: o.start, fire_at, leave: false });
                    }
                }
                // Time to leave, unless a reminder already fires right then.
                if let Some(t) = o.travel.filter(|t| !leads.contains(t)) {
                    let fire_at = o.start - t * 60;
                    if fire_at > after && fire_at <= until {
                        out.push(crate::DueReminder { event_id: id.clone(), title: o.title.clone(), location: o.location.clone(), start: o.start, fire_at, leave: true });
                    }
                }
            }
        }
        out.sort_by_key(|r| r.fire_at);
        Ok(out)
    }

    // ── Contacts ──────────────────────────────────────────────────────────

    fn contact_summary(r: &Row) -> rusqlite::Result<ContactSummary> {
        Ok(ContactSummary {
            id: r.get(0)?,
            book_id: r.get(1)?,
            full_name: r.get(2)?,
            org: r.get(3)?,
            emails: from_json(r.get(4)?),
            phones: from_json(r.get(5)?),
            photo: r.get(6)?,
            labels: from_json(r.get(7)?),
        })
    }

    /// Contacts in visible address books, by family name. `search` matches
    /// names, companies, emails, and phone numbers.
    pub fn contacts(&self, search: Option<&str>) -> Result<Vec<ContactSummary>> {
        self.contacts_labeled(search, None)
    }

    /// The same, narrowed to one label (case doesn't matter).
    pub fn contacts_labeled(&self, search: Option<&str>, label: Option<&str>) -> Result<Vec<ContactSummary>> {
        let like = search.map(str::trim).filter(|s| !s.is_empty()).map(|s| format!("%{}%", s.replace(['%', '_'], "")));
        let label = label.map(str::trim).filter(|l| !l.is_empty());
        let mut st = self.db.prepare(
            "SELECT k.id, k.collection_id, k.full_name, k.org, k.emails, k.phones, k.photo, k.labels FROM contacts k
             JOIN collections c ON c.id = k.collection_id
             WHERE c.hidden = 0 AND k.state != 'deleted'
               AND (?1 IS NULL OR k.full_name LIKE ?1 OR k.org LIKE ?1 OR k.emails LIKE ?1 OR k.phones LIKE ?1)
               AND (?2 IS NULL OR EXISTS (SELECT 1 FROM json_each(k.labels) l WHERE lower(l.value) = lower(?2)))
             ORDER BY k.sort_key",
        )?;
        Ok(st.query_map(params![like, label], Self::contact_summary)?.collect::<rusqlite::Result<_>>()?)
    }

    pub fn contact(&self, id: &str) -> Result<ContactDetail> {
        let (summary, vcf): (ContactSummary, String) = self
            .db
            .query_row(
                "SELECT id, collection_id, full_name, org, emails, phones, photo, labels, vcf FROM contacts WHERE id = ?1 AND state != 'deleted'",
                [id],
                |r| Ok((Self::contact_summary(r)?, r.get(8)?)),
            )
            .optional()?
            .ok_or_else(|| Error::NotFound("that contact was deleted".into()))?;
        let meta = vcard::read_contact(&vcf)?;
        let writable = self.collection(&summary.book_id)?.writable;
        Ok(ContactDetail { summary, title: meta.title, note: meta.note, birthday: meta.birthday, writable })
    }

    fn index_contact(vcf: &str) -> vcard::ContactMeta {
        vcard::read_contact(vcf).unwrap_or_else(|_| vcard::ContactMeta { full_name: "(unreadable contact)".into(), ..Default::default() })
    }

    pub(crate) fn insert_contact(&self, book_id: &str, href: Option<&str>, etag: Option<&str>, vcf: &str, state: &str) -> Result<String> {
        let m = Self::index_contact(vcf);
        let id = uuid::Uuid::new_v4().to_string();
        self.db.execute(
            "INSERT INTO contacts (id, collection_id, href, etag, uid, vcf, state, full_name, sort_key, org, emails, phones, photo, birthday, labels)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            params![id, book_id, href, etag, m.uid, vcf, state, m.full_name, sort_key(&m), m.org, json(&m.emails), json(&m.phones), m.photo, m.birthday, json(&m.labels)],
        )?;
        Ok(id)
    }

    pub(crate) fn rewrite_contact(&self, id: &str, vcf: &str, state: &str) -> Result<()> {
        let m = Self::index_contact(vcf);
        self.db.execute(
            "UPDATE contacts SET vcf = ?2, state = ?3, full_name = ?4, sort_key = ?5, org = ?6, emails = ?7, phones = ?8, photo = ?9, birthday = ?10, labels = ?11 WHERE id = ?1",
            params![id, vcf, state, m.full_name, sort_key(&m), m.org, json(&m.emails), json(&m.phones), m.photo, m.birthday, json(&m.labels)],
        )?;
        Ok(())
    }

    pub fn create_contact(&self, input: &ContactInput) -> Result<ContactDetail> {
        let c = self.writable(&input.book_id)?;
        let uid = uuid::Uuid::new_v4().to_string();
        let vcf = vcard::new_contact(&uid, input)?;
        let href = child_href(self.collection_href(&c.id)?.as_deref(), &uid, "vcf");
        let id = self.insert_contact(&c.id, href.as_deref(), None, &vcf, Self::edit_state(&c))?;
        self.contact(&id)
    }

    pub fn update_contact(&self, id: &str, input: &ContactInput) -> Result<ContactDetail> {
        let (book_id, vcf): (String, String) =
            self.db.query_row("SELECT collection_id, vcf FROM contacts WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        let from = self.writable(&book_id)?;
        let edited = vcard::edit_contact(&vcf, input)?;
        if book_id == input.book_id {
            self.rewrite_contact(id, &edited, Self::edit_state(&from))?;
            return self.contact(id);
        }
        let to = self.writable(&input.book_id)?;
        let uid = vcard::read_contact(&edited)?.uid;
        self.remove_item(CollectionKind::Contacts, id, &from)?;
        let href = child_href(self.collection_href(&to.id)?.as_deref(), &uid, "vcf");
        let new_id = self.insert_contact(&to.id, href.as_deref(), None, &edited, Self::edit_state(&to))?;
        self.contact(&new_id)
    }

    /// Deletes a contact, keeping a copy in Recently deleted for 30 days.
    pub fn delete_contact(&self, id: &str) -> Result<()> {
        let book_id: String = self.db.query_row("SELECT collection_id FROM contacts WHERE id = ?1", [id], |r| r.get(0))?;
        let c = self.writable(&book_id)?;
        self.trash_contact(id)?;
        self.remove_item(CollectionKind::Contacts, id, &c)
    }

    /// Groups of contacts that look like the same person: a shared email or
    /// phone number, or the same full name. Each group is listed once.
    pub fn duplicate_contacts(&self) -> Result<Vec<Vec<ContactSummary>>> {
        let all = self.contacts(None)?;
        let mut parent: Vec<usize> = (0..all.len()).collect();
        fn find(p: &mut [usize], i: usize) -> usize {
            let mut r = i;
            while p[r] != r {
                r = p[r];
            }
            p[i] = r;
            r
        }
        let mut seen: HashMap<String, usize> = HashMap::new();
        for (i, c) in all.iter().enumerate() {
            let mut keys: Vec<String> = c.emails.iter().map(|e| format!("e:{}", vcard::normalize_email(&e.value))).collect();
            keys.extend(c.phones.iter().map(|p| vcard::normalize_phone(&p.value)).filter(|p| p.len() >= 7).map(|p| format!("p:{p}")));
            let name = name_key(&c.full_name);
            // Single-word names ("Mom", "Support") collide too easily to count.
            if name.contains(' ') {
                keys.push(format!("n:{name}"));
            }
            for k in keys {
                match seen.get(&k) {
                    Some(&j) => {
                        let (a, b) = (find(&mut parent, i), find(&mut parent, j));
                        parent[a] = b;
                    }
                    None => {
                        seen.insert(k, i);
                    }
                }
            }
        }
        let mut groups: HashMap<usize, Vec<ContactSummary>> = HashMap::new();
        for (i, c) in all.iter().enumerate() {
            groups.entry(find(&mut parent, i)).or_default().push(c.clone());
        }
        let mut out: Vec<_> = groups.into_values().filter(|g| g.len() > 1).collect();
        out.sort_by(|a, b| a[0].full_name.to_lowercase().cmp(&b[0].full_name.to_lowercase()));
        Ok(out)
    }

    /// Folds `others` into `primary` and deletes them.
    pub fn merge_contacts(&self, primary: &str, others: &[String]) -> Result<ContactDetail> {
        let (book_id, mut vcf): (String, String) =
            self.db.query_row("SELECT collection_id, vcf FROM contacts WHERE id = ?1", [primary], |r| Ok((r.get(0)?, r.get(1)?)))?;
        let c = self.writable(&book_id)?;
        let tx = self.db.unchecked_transaction()?;
        for other in others.iter().filter(|o| o.as_str() != primary) {
            let (other_book, other_vcf): (String, String) =
                self.db.query_row("SELECT collection_id, vcf FROM contacts WHERE id = ?1", [other], |r| Ok((r.get(0)?, r.get(1)?)))?;
            vcf = vcard::merge_contacts(&vcf, &other_vcf)?;
            let ob = self.writable(&other_book)?;
            // A merge can be undone from Recently deleted too.
            self.trash_contact(other)?;
            self.remove_item(CollectionKind::Contacts, other, &ob)?;
        }
        self.rewrite_contact(primary, &vcf, Self::edit_state(&c))?;
        tx.commit()?;
        self.contact(primary)
    }

    /// Email suggestions for the composer: names and addresses matching `prefix`.
    pub fn contact_emails(&self, prefix: &str, limit: usize) -> Result<Vec<crate::Address>> {
        let p = prefix.trim().to_lowercase();
        if p.is_empty() {
            return Ok(vec![]);
        }
        let mut out = Vec::new();
        for c in self.contacts(Some(&p))? {
            for e in c.emails {
                if c.full_name.to_lowercase().split_whitespace().any(|w| w.starts_with(&p)) || e.value.to_lowercase().starts_with(&p) {
                    out.push(crate::Address { name: Some(c.full_name.clone()).filter(|n| n != &e.value), email: e.value });
                }
            }
            if out.len() >= limit {
                break;
            }
        }
        out.truncate(limit);
        Ok(out)
    }

    // ── DAV sync ──────────────────────────────────────────────────────────

    /// Synced collections of one account, each with what we hold of it.
    pub fn dav_cursors(&self, account_id: &str) -> Result<Vec<(Collection, DavCursor)>> {
        let mut out = Vec::new();
        let cols: Vec<(Collection, String, Option<String>)> = self
            .db
            .prepare(&format!("SELECT {COLLECTION_COLS}, href, sync_token FROM collections WHERE account_id = ?1 AND href IS NOT NULL"))?
            .query_map([account_id], |r| Ok((collection_row(r)?, r.get(8)?, r.get(9)?)))?
            .collect::<rusqlite::Result<_>>()?;
        for (c, href, sync_token) in cols {
            let t = table(c.kind);
            let etags = self
                .db
                .prepare(&format!("SELECT href, etag FROM {t} WHERE collection_id = ?1 AND href IS NOT NULL AND etag IS NOT NULL"))?
                .query_map([&c.id], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<HashMap<String, String>>>()?;
            out.push((c, DavCursor { href, sync_token, etags }));
        }
        Ok(out)
    }

    /// Local changes for one collection, oldest state first.
    pub fn pending_dav(&self, collection_id: &str) -> Result<Vec<DavChange>> {
        let c = self.collection(collection_id)?;
        let (t, body) = (table(c.kind), body_col(c.kind));
        let mut st = self.db.prepare(&format!("SELECT id, href, etag, state, {body} FROM {t} WHERE collection_id = ?1 AND state != 'synced' AND href IS NOT NULL"))?;
        let rows = st.query_map([collection_id], |r| {
            let state: String = r.get(3)?;
            Ok(DavChange { item_id: r.get(0)?, href: r.get(1)?, etag: r.get(2)?, body: if state == DELETED { None } else { Some(r.get(4)?) } })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Records how the server took one pushed change.
    pub fn dav_result(&self, collection_id: &str, item_id: &str, outcome: &DavOutcome) -> Result<()> {
        let t = table(self.collection(collection_id)?.kind);
        match outcome {
            DavOutcome::Saved(etag) => {
                self.db.execute(&format!("UPDATE {t} SET state = 'synced', etag = ?2 WHERE id = ?1"), params![item_id, etag])?;
            }
            DavOutcome::Created(href, etag) => {
                self.db.execute(&format!("UPDATE {t} SET state = 'synced', href = ?2, etag = ?3 WHERE id = ?1"), params![item_id, href, etag])?;
            }
            DavOutcome::Deleted => {
                self.db.execute(&format!("DELETE FROM {t} WHERE id = ?1"), [item_id])?;
            }
            // Forget our etag so the next pull fetches the server's copy.
            DavOutcome::Conflict => {
                let had_etag: Option<String> = self.db.query_row(&format!("SELECT etag FROM {t} WHERE id = ?1"), [item_id], |r| r.get(0)).optional()?.flatten();
                if had_etag.is_some() {
                    self.db.execute(&format!("UPDATE {t} SET state = 'synced', etag = NULL WHERE id = ?1"), [item_id])?;
                } else {
                    self.db.execute(&format!("DELETE FROM {t} WHERE id = ?1"), [item_id])?;
                }
            }
        }
        Ok(())
    }

    /// Applies server changes. Rows with a local change still pending are
    /// left alone (the push runs first, so these are conflicts in flight).
    pub fn apply_dav(&self, collection_id: &str, batch: &DavBatch) -> Result<usize> {
        let c = self.collection(collection_id)?;
        let t = table(c.kind);
        let tx = self.db.unchecked_transaction()?;
        let mut changed = 0;
        for (href, etag, body) in &batch.upserts {
            let row: Option<(String, String)> = self
                .db
                .query_row(&format!("SELECT id, state FROM {t} WHERE collection_id = ?1 AND href = ?2"), params![collection_id, href], |r| Ok((r.get(0)?, r.get(1)?)))
                .optional()?;
            match row {
                Some((_, state)) if state != SYNCED => continue,
                Some((id, _)) => {
                    match c.kind {
                        CollectionKind::Calendar => self.rewrite_event(&id, body, SYNCED)?,
                        CollectionKind::Contacts => self.rewrite_contact(&id, body, SYNCED)?,
                    }
                    self.db.execute(&format!("UPDATE {t} SET etag = ?2 WHERE id = ?1"), params![id, etag])?;
                }
                None => {
                    match c.kind {
                        CollectionKind::Calendar => self.insert_event(collection_id, Some(href), Some(etag), body, SYNCED)?,
                        CollectionKind::Contacts => self.insert_contact(collection_id, Some(href), Some(etag), body, SYNCED)?,
                    };
                }
            }
            changed += 1;
        }
        let removed: HashSet<&str> = batch.removed.iter().map(String::as_str).collect();
        for href in removed {
            changed += self.db.execute(&format!("DELETE FROM {t} WHERE collection_id = ?1 AND href = ?2 AND state = 'synced'"), params![collection_id, href])?;
        }
        if batch.sync_token.is_some() {
            self.db.execute("UPDATE collections SET sync_token = ?2 WHERE id = ?1", params![collection_id, batch.sync_token])?;
        }
        tx.commit()?;
        Ok(changed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ContactField, Repeat};

    fn store() -> Store {
        let s = Store::open_in_memory().unwrap();
        s.ensure_local_collections().unwrap();
        s
    }

    fn local(s: &Store, kind: CollectionKind) -> String {
        s.collections(kind).unwrap()[0].id.clone()
    }

    fn event(calendar_id: &str, start: &str, end: &str) -> EventInput {
        EventInput {
            calendar_id: calendar_id.into(),
            title: "Ferry".into(),
            location: Some("Pier 3".into()),
            notes: None,
            start: start.into(),
            end: end.into(),
            all_day: false,
            time_zone: "Europe/Lisbon".into(),
            repeat: Repeat::None,
            reminders: None,
            attendees: None,
            travel: None,
        }
    }

    fn person(book: &str, name: &str, email: &str, phone: &str) -> ContactInput {
        ContactInput { photo: None,
            book_id: book.into(),
            full_name: name.into(),
            emails: if email.is_empty() { vec![] } else { vec![ContactField { label: None, value: email.into() }] },
            phones: if phone.is_empty() { vec![] } else { vec![ContactField { label: None, value: phone.into() }] },
            org: None,
            title: None,
            note: None,
            birthday: None,
            labels: None,
        }
    }

    #[test]
    fn local_collections_exist_once() {
        let s = store();
        s.ensure_local_collections().unwrap();
        // One device calendar, plus the read-only Birthdays calendar (ADR-0019).
        let cals = s.collections(CollectionKind::Calendar).unwrap();
        assert_eq!(cals.iter().filter(|c| c.writable).count(), 1);
        assert_eq!(cals.iter().map(|c| c.id.as_str()).collect::<Vec<_>>().last(), Some(&"birthdays"), "listed last");
        assert_eq!(s.collections(CollectionKind::Contacts).unwrap().len(), 1);
    }

    #[test]
    fn events_show_in_windows_and_recurring_ones_expand() {
        let s = store();
        let cal = local(&s, CollectionKind::Calendar);
        let e = s.create_event(&event(&cal, "2026-10-14T08:15", "2026-10-14T09:00")).unwrap();
        assert_eq!(e.occurrence.title, "Ferry");
        let day = |d: i64| (1_791_936_000 + d * 86_400, 1_791_936_000 + (d + 1) * 86_400); // 2026-10-14 UTC
        let (a, b) = day(0);
        assert_eq!(s.occurrences(a, b).unwrap().len(), 1);
        let (a, b) = day(1);
        assert!(s.occurrences(a, b).unwrap().is_empty());

        let mut weekly = event(&cal, "2026-10-14T18:00", "2026-10-14T19:00");
        weekly.title = "Climbing".into();
        weekly.repeat = Repeat::Weekly;
        let w = s.create_event(&weekly).unwrap();
        let (a, _) = day(0);
        let month = s.occurrences(a, a + 28 * 86_400).unwrap();
        assert_eq!(month.iter().filter(|o| o.title == "Climbing").count(), 4);
        assert!(month.iter().all(|o| o.title != "Climbing" || o.recurring));

        // Skip one week, then delete the series.
        let second = month.iter().filter(|o| o.title == "Climbing").nth(1).unwrap().start;
        s.delete_event(&w.occurrence.event_id, Some(second), EditScope::This).unwrap();
        assert_eq!(s.occurrences(a, a + 28 * 86_400).unwrap().iter().filter(|o| o.title == "Climbing").count(), 3);
        s.delete_event(&w.occurrence.event_id, None, EditScope::All).unwrap();
        assert!(s.occurrences(a, a + 28 * 86_400).unwrap().iter().all(|o| o.title != "Climbing"));
    }

    #[test]
    fn scoped_edits_and_deletes_on_a_series() {
        let s = store();
        let cal = local(&s, CollectionKind::Calendar);
        let mut weekly = event(&cal, "2026-10-14T18:00", "2026-10-14T19:00");
        weekly.title = "Climbing".into();
        weekly.repeat = Repeat::Weekly;
        let id = s.create_event(&weekly).unwrap().occurrence.event_id;
        let (a, b) = (1_791_936_000, 1_791_936_000 + 35 * 86_400); // five weeks
        let weeks = || s.occurrences(a, b).unwrap();
        assert_eq!(weeks().len(), 5);

        // This: move week 2 by an hour; the rest stay.
        let w2 = weeks()[1].original_start;
        let moved = EventInput { title: "Climbing (late)".into(), start: "2026-10-21T19:00".into(), end: "2026-10-21T20:00".into(), ..weekly.clone() };
        s.update_event(&id, &moved, EditScope::This, Some(w2)).unwrap();
        let w = weeks();
        assert_eq!(w.len(), 5);
        assert_eq!((w[1].title.as_str(), w[1].original_start), ("Climbing (late)", w2));
        assert_eq!(s.event(&id, Some(w[1].start)).unwrap().occurrence.title, "Climbing (late)", "detail finds the moved one");
        let other_cal = EventInput { calendar_id: "elsewhere".into(), ..moved.clone() };
        assert!(s.update_event(&id, &other_cal, EditScope::This, Some(w2)).is_err(), "one occurrence can't change calendar");

        // Following from week 4: a new series takes over.
        let w4 = w[3].original_start;
        let tail = EventInput { title: "Bouldering".into(), start: "2026-11-04T18:00".into(), end: "2026-11-04T19:00".into(), ..weekly.clone() };
        let new = s.update_event(&id, &tail, EditScope::Following, Some(w4)).unwrap();
        assert_ne!(new.occurrence.event_id, id);
        let titles: Vec<_> = weeks().into_iter().map(|o| o.title).collect();
        assert_eq!(titles, ["Climbing", "Climbing (late)", "Climbing", "Bouldering", "Bouldering"]);

        // Delete following on the new series from week 5; delete week 1 only.
        s.delete_event(&new.occurrence.event_id, Some(weeks()[4].original_start), EditScope::Following).unwrap();
        s.delete_event(&id, Some(weeks()[0].original_start), EditScope::This).unwrap();
        let titles: Vec<_> = weeks().into_iter().map(|o| o.title).collect();
        assert_eq!(titles, ["Climbing (late)", "Climbing", "Bouldering"]);

        // "Following" from the very first occurrence edits the whole series.
        let first = weeks()[2].original_start;
        let renamed = EventInput { title: "Gym".into(), start: "2026-11-04T18:00".into(), end: "2026-11-04T19:00".into(), ..weekly.clone() };
        let same = s.update_event(&new.occurrence.event_id, &renamed, EditScope::Following, Some(first)).unwrap();
        assert_eq!(same.occurrence.event_id, new.occurrence.event_id);
    }

    #[test]
    fn reminders_come_due_once_and_follow_the_series() {
        let s = store();
        let cal = local(&s, CollectionKind::Calendar);
        let mut weekly = event(&cal, "2026-10-14T18:00", "2026-10-14T19:00");
        weekly.title = "Climbing".into();
        weekly.repeat = Repeat::Weekly;
        weekly.reminders = Some(vec![30, 0]);
        let e = s.create_event(&weekly).unwrap();
        assert_eq!(e.reminders, [0, 30]);
        let start = e.occurrence.start; // 17:00Z
        assert!(s.due_reminders(start - 3600, start - 1801).unwrap().is_empty(), "nothing before the 30-minute mark");
        let due = s.due_reminders(start - 1801, start).unwrap();
        assert_eq!(due.iter().map(|r| r.fire_at).collect::<Vec<_>>(), [start - 1800, start], "30 minutes before, and at the start");
        assert!(s.due_reminders(start, start + 600).unwrap().is_empty(), "each fires once");
        let next_week = s.due_reminders(start + 6 * 86_400, start + 8 * 86_400).unwrap();
        assert_eq!(next_week.len(), 2, "the next occurrence reminds too");
        s.set_collection_hidden(&cal, true).unwrap();
        assert!(s.due_reminders(start - 1801, start).unwrap().is_empty(), "hidden calendars stay quiet");
    }

    #[test]
    fn travel_time_says_when_to_leave() {
        let s = store();
        let cal = local(&s, CollectionKind::Calendar);
        let mut dentist = event(&cal, "2026-10-14T18:00", "2026-10-14T19:00");
        dentist.travel = Some(25);
        dentist.reminders = Some(vec![]);
        let e = s.create_event(&dentist).unwrap();
        assert_eq!(e.occurrence.travel, Some(25));
        let start = e.occurrence.start;
        assert_eq!(s.occurrences(start - 60, start + 60).unwrap()[0].travel, Some(25), "views carry it");
        let due = s.due_reminders(start - 3600, start).unwrap();
        assert_eq!(due.iter().map(|r| (r.fire_at, r.leave)).collect::<Vec<_>>(), [(start - 25 * 60, true)], "an event with only travel time still alerts, as time to leave");
        // A reminder at the same moment stands in for it: one alert, not two.
        let mut same = dentist.clone();
        same.reminders = Some(vec![25, 5]);
        s.update_event(&e.occurrence.event_id, &same, crate::EditScope::All, None).unwrap();
        let due = s.due_reminders(start - 3600, start).unwrap();
        assert_eq!(due.iter().map(|r| (r.fire_at, r.leave)).collect::<Vec<_>>(), [(start - 25 * 60, false), (start - 5 * 60, false)]);
        // Travel reaching back over a day boundary is still found.
        let mut far = event(&cal, "2026-10-20T00:30", "2026-10-20T01:00");
        far.travel = Some(120);
        let f = s.create_event(&far).unwrap();
        let fs = f.occurrence.start;
        assert!(s.due_reminders(fs - 7201, fs - 7200).unwrap().iter().any(|r| r.leave && r.event_id == f.occurrence.event_id));
    }

    #[test]
    fn events_describe_their_call_and_booking_links() {
        let s = store();
        let cal = local(&s, CollectionKind::Calendar);
        let mut call = event(&cal, "2026-10-14T18:00", "2026-10-14T18:30");
        call.location = Some("Zoom".into());
        call.notes = Some("Join: https://us02web.zoom.us/j/85012345678?pwd=Ab12\nPasscode: 4242\n\nCancel: https://calendly.com/cancellations/X1\nReschedule: https://calendly.com/reschedulings/X1".into());
        let e = s.create_event(&call).unwrap();
        let m = e.meeting.as_ref().unwrap();
        assert_eq!((m.service.as_str(), m.passcode.as_deref()), ("zoom", Some("4242")));
        assert_eq!(e.occurrence.meeting_app_url.as_deref(), Some("zoommtg://us02web.zoom.us/join?action=join&confno=85012345678&pwd=Ab12"));
        assert_eq!(e.manage.iter().map(|l| l.action.as_str()).collect::<Vec<_>>(), ["cancel", "reschedule"]);
        // Lists find the call too: in the location here, in the description above.
        let mut listed = event(&cal, "2026-10-15T09:00", "2026-10-15T09:30");
        listed.location = Some("https://teams.microsoft.com/l/meetup-join/19%3ax/0".into());
        let l = s.create_event(&listed).unwrap();
        let o = s.occurrences(l.occurrence.start - 1, l.occurrence.start + 1).unwrap().into_iter().find(|o| o.event_id == l.occurrence.event_id).unwrap();
        assert_eq!(o.meeting_app_url.as_deref(), Some("msteams:/l/meetup-join/19%3ax/0"));
        let z = s.occurrences(e.occurrence.start - 1, e.occurrence.start + 1).unwrap().into_iter().find(|o| o.event_id == e.occurrence.event_id).unwrap();
        assert_eq!(z.meeting_url.as_deref(), Some("https://us02web.zoom.us/j/85012345678?pwd=Ab12"), "a link only in the description still gets Join in lists");
    }

    #[test]
    fn hidden_calendars_drop_out_of_views() {
        let s = store();
        let cal = local(&s, CollectionKind::Calendar);
        s.create_event(&event(&cal, "2026-10-14T08:15", "2026-10-14T09:00")).unwrap();
        s.set_collection_hidden(&cal, true).unwrap();
        assert!(s.occurrences(0, i64::MAX / 2).unwrap().is_empty());
    }

    #[test]
    fn time_zone_changes_reindex_all_day_events() {
        let s = store();
        let cal = local(&s, CollectionKind::Calendar);
        let mut holiday = event(&cal, "2026-11-01", "2026-11-02");
        holiday.all_day = true;
        s.create_event(&holiday).unwrap();
        let utc = s.occurrences(0, i64::MAX / 2).unwrap()[0].start;
        s.set_time_zone("America/New_York").unwrap();
        let ny = s.occurrences(0, i64::MAX / 2).unwrap()[0].start;
        assert_eq!(ny - utc, 4 * 3600, "midnight moves with the device clock");
    }

    fn remote(s: &Store, kind: CollectionKind) -> String {
        s.db.execute("INSERT OR IGNORE INTO accounts (id, config, created_at) VALUES ('acct', '{}', 0)", []).unwrap();
        s.sync_collections("acct", kind, &[RemoteCollection { href: "/dav/cal/work/".into(), kind, name: "Work".into(), color: Some("#2563eb".into()), writable: true, scheduling: false }])
            .unwrap();
        s.collections(kind).unwrap().into_iter().find(|c| c.account_id.is_some()).unwrap().id
    }

    #[test]
    fn edits_on_synced_calendars_queue_for_the_server() {
        let s = store();
        let work = remote(&s, CollectionKind::Calendar);
        let e = s.create_event(&event(&work, "2026-10-14T08:15", "2026-10-14T09:00")).unwrap();
        let pending = s.pending_dav(&work).unwrap();
        assert_eq!(pending.len(), 1);
        assert!(pending[0].href.starts_with("/dav/cal/work/") && pending[0].href.ends_with(".ics"));
        assert_eq!(pending[0].etag, None, "new resource");
        s.dav_result(&work, &pending[0].item_id, &DavOutcome::Saved(Some("\"e1\"".into()))).unwrap();
        assert!(s.pending_dav(&work).unwrap().is_empty());
        let cursor = &s.dav_cursors("acct").unwrap()[0].1;
        assert_eq!(cursor.etags.get(&pending[0].href).map(String::as_str), Some("\"e1\""));

        // Delete waits for the server, hidden meanwhile.
        s.delete_event(&e.occurrence.event_id, None, EditScope::All).unwrap();
        assert!(s.occurrences(0, i64::MAX / 2).unwrap().is_empty());
        let del = s.pending_dav(&work).unwrap();
        assert_eq!((del[0].body.is_none(), del[0].etag.as_deref()), (true, Some("\"e1\"")));
        s.dav_result(&work, &del[0].item_id, &DavOutcome::Deleted).unwrap();

        // Servers that choose their own ids (Graph) move the item to the new href.
        s.create_event(&event(&work, "2026-10-21T10:00", "2026-10-21T11:00")).unwrap();
        let made = s.pending_dav(&work).unwrap().remove(0);
        s.dav_result(&work, &made.item_id, &DavOutcome::Created("/events/AAMk1".into(), None)).unwrap();
        assert!(s.pending_dav(&work).unwrap().is_empty());
        let row: (String, Option<String>) = s.db.query_row("SELECT href, etag FROM events WHERE id = ?1", [&made.item_id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(row, ("/events/AAMk1".to_string(), None), "no etag yet: the next pull fetches the server's copy");
        assert!(s.dav_cursors("acct").unwrap()[0].1.etags.is_empty());
    }

    #[test]
    fn pulls_upsert_and_remove_but_never_clobber_pending_edits() {
        let s = store();
        let work = remote(&s, CollectionKind::Calendar);
        let ics = ical::new_event("srv-1", &event(&work, "2026-10-14T08:15", "2026-10-14T09:00")).unwrap();
        let batch = DavBatch { sync_token: Some("t1".into()), upserts: vec![("/dav/cal/work/srv-1.ics".into(), "\"a\"".into(), ics.clone())], removed: vec![] };
        assert_eq!(s.apply_dav(&work, &batch).unwrap(), 1);
        let o = s.occurrences(0, i64::MAX / 2).unwrap();
        assert_eq!(o.len(), 1);
        assert_eq!(s.dav_cursors("acct").unwrap()[0].1.sync_token.as_deref(), Some("t1"));

        // A local edit is pending; the server's version of the same resource waits.
        let mut edit = event(&work, "2026-10-14T10:00", "2026-10-14T11:00");
        edit.title = "Ferry (later)".into();
        s.update_event(&o[0].event_id, &edit, EditScope::All, None).unwrap();
        let theirs = ical::edit_event(&ics, &EventInput { title: "Ferry (theirs)".into(), ..edit.clone() }).unwrap();
        s.apply_dav(&work, &DavBatch { sync_token: None, upserts: vec![("/dav/cal/work/srv-1.ics".into(), "\"b\"".into(), theirs.clone())], removed: vec![] }).unwrap();
        assert_eq!(s.occurrences(0, i64::MAX / 2).unwrap()[0].title, "Ferry (later)");

        // Conflict: the server wins on the next pull.
        let p = s.pending_dav(&work).unwrap();
        s.dav_result(&work, &p[0].item_id, &DavOutcome::Conflict).unwrap();
        s.apply_dav(&work, &DavBatch { sync_token: None, upserts: vec![("/dav/cal/work/srv-1.ics".into(), "\"b\"".into(), theirs)], removed: vec![] }).unwrap();
        assert_eq!(s.occurrences(0, i64::MAX / 2).unwrap()[0].title, "Ferry (theirs)");

        s.apply_dav(&work, &DavBatch { sync_token: None, upserts: vec![], removed: vec!["/dav/cal/work/srv-1.ics".into()] }).unwrap();
        assert!(s.occurrences(0, i64::MAX / 2).unwrap().is_empty());
    }

    #[test]
    fn collections_follow_the_server_list() {
        let s = store();
        let work = remote(&s, CollectionKind::Calendar);
        s.sync_collections("acct", CollectionKind::Calendar, &[RemoteCollection { href: "/dav/cal/work/".into(), kind: CollectionKind::Calendar, name: "Work (renamed)".into(), color: None, writable: false, scheduling: false }]).unwrap();
        let c = s.collection(&work).unwrap();
        assert_eq!((c.name.as_str(), c.writable), ("Work (renamed)", false));
        assert!(s.create_event(&event(&work, "2026-10-14T08:15", "2026-10-14T09:00")).is_err(), "read-only");
        s.sync_collections("acct", CollectionKind::Calendar, &[]).unwrap();
        assert!(s.collection(&work).is_err(), "gone from the server, gone here");
    }

    #[test]
    fn contacts_list_search_and_sort_by_family_name() {
        let s = store();
        let book = local(&s, CollectionKind::Contacts);
        s.create_contact(&person(&book, "Marcus Lee", "marcus@example.com", "")).unwrap();
        s.create_contact(&person(&book, "Ana Duarte", "ana@studio.example", "+1 555 010 2030")).unwrap();
        let all = s.contacts(None).unwrap();
        assert_eq!(all.iter().map(|c| c.full_name.as_str()).collect::<Vec<_>>(), ["Ana Duarte", "Marcus Lee"]);
        assert_eq!(s.contacts(Some("studio")).unwrap().len(), 1);
        assert_eq!(s.contacts(Some("010 2030")).unwrap().len(), 1);
        assert_eq!(s.contact_emails("mar", 5).unwrap()[0].email, "marcus@example.com");
    }

    #[test]
    fn duplicates_group_and_merge() {
        let s = store();
        let book = local(&s, CollectionKind::Contacts);
        let a = s.create_contact(&person(&book, "Ana Duarte", "ana@studio.example", "")).unwrap();
        let b = s.create_contact(&person(&book, "Ana D.", "ANA@studio.example", "555 010 2030")).unwrap();
        let c = s.create_contact(&person(&book, "Ana Duarte", "", "")).unwrap();
        s.create_contact(&person(&book, "Mom", "", "")).unwrap();
        s.create_contact(&person(&book, "Mom", "", "")).unwrap();
        let groups = s.duplicate_contacts().unwrap();
        assert_eq!(groups.len(), 1, "one-word names don't count");
        assert_eq!(groups[0].len(), 3);
        let merged = s.merge_contacts(&a.summary.id, &[b.summary.id.clone(), c.summary.id.clone()]).unwrap();
        assert_eq!(merged.summary.phones.len(), 1);
        assert_eq!(s.contacts(None).unwrap().len(), 3);
        assert!(s.duplicate_contacts().unwrap().is_empty());
    }
}
