//! Scheduling links (ADR-0026): a page where someone picks one of your free
//! times, and it lands in your calendar, with an invitation when the calendar
//! is on a mail account. The page is public, so everything it can reach is
//! here and narrow: the link's own free times, and one booking at a time.

use chrono::Datelike;
use serde::{Deserialize, Serialize};

use crate::store::{Store, from_json, json};
use crate::{Address, Error, EventInput, Repeat, Result, TimeSlot, ical, now};

const KEY: &str = "booking_links";
const GRID: i64 = 30 * 60;
/// Bookings a link takes per rolling day before it pauses itself.
const MAX_PER_DAY: usize = 10;
/// How soon someone can book: not in the next two hours.
const LEAD: i64 = 2 * 3600;

/// What a link offers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookingLinkInput {
    /// "Intro call", "Studio visit".
    pub title: String,
    pub minutes: u32,
    /// Where booked events go; it must be one you can edit.
    pub calendar_id: String,
    /// Minutes after midnight, local time.
    pub day_start: u32,
    pub day_end: u32,
    pub weekdays_only: bool,
    /// How far ahead people can book (1–14 days).
    pub days_ahead: u32,
    /// Shown on the page: what the meeting is, where it happens.
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookingLink {
    pub id: String,
    /// The unguessable part of the page's address.
    pub token: String,
    #[serde(flatten)]
    pub input: BookingLinkInput,
    /// When bookings came in (Unix seconds), for the daily limit.
    #[serde(default)]
    pub booked_at: Vec<i64>,
}

/// What the public page shows. Nothing about your calendar beyond free times.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicBooking {
    pub title: String,
    pub minutes: u32,
    pub host: String,
    pub time_zone: String,
    pub note: Option<String>,
    pub slots: Vec<TimeSlot>,
}

/// Someone's booking.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookingRequest {
    pub start: i64,
    pub name: String,
    pub email: String,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Booked {
    pub start: i64,
    pub end: i64,
    pub title: String,
    pub host: String,
    /// An invitation was emailed (the calendar is on a mail account).
    pub invited: bool,
}

impl Store {
    pub fn booking_links(&self) -> Result<Vec<BookingLink>> {
        Ok(self.setting(KEY)?.map(from_json::<Vec<BookingLink>>).unwrap_or_default())
    }

    fn save_links(&self, links: &[BookingLink]) -> Result<()> {
        self.set_setting(KEY, Some(&json(&links)))
    }

    /// Adds (`id` None) or edits a link. Editing keeps its address.
    pub fn save_booking_link(&self, id: Option<&str>, input: &BookingLinkInput) -> Result<BookingLink> {
        let input = self.check_link(input)?;
        let mut links = self.booking_links()?;
        let link = match id {
            Some(id) => {
                let l = links.iter_mut().find(|l| l.id == id).ok_or_else(|| Error::NotFound("that booking link was deleted".into()))?;
                l.input = input;
                l.clone()
            }
            None => {
                let l = BookingLink { id: uuid::Uuid::new_v4().to_string(), token: uuid::Uuid::new_v4().simple().to_string(), input, booked_at: vec![] };
                links.push(l.clone());
                l
            }
        };
        self.save_links(&links)?;
        Ok(link)
    }

    /// Deletes a link; its page stops working at once.
    pub fn delete_booking_link(&self, id: &str) -> Result<()> {
        let mut links = self.booking_links()?;
        links.retain(|l| l.id != id);
        self.save_links(&links)
    }

    fn check_link(&self, i: &BookingLinkInput) -> Result<BookingLinkInput> {
        let title = i.title.trim().to_string();
        if title.is_empty() {
            return Err(Error::Invalid("give the link a title, like “Intro call”".into()));
        }
        if !(10..=240).contains(&i.minutes) {
            return Err(Error::Invalid("meetings can be 10 minutes to 4 hours".into()));
        }
        if i.day_end <= i.day_start || i.day_end > 24 * 60 || i64::from(i.day_end - i.day_start) < i64::from(i.minutes) {
            return Err(Error::Invalid("the hours you offer need to fit one meeting".into()));
        }
        if !(1..=14).contains(&i.days_ahead) {
            return Err(Error::Invalid("people can book 1 to 14 days ahead".into()));
        }
        self.writable(&i.calendar_id).map_err(|_| Error::Invalid("pick a calendar you can add events to".into()))?;
        Ok(BookingLinkInput { title, note: i.note.as_deref().map(str::trim).filter(|n| !n.is_empty()).map(String::from), ..i.clone() })
    }

    fn link_by_token(&self, token: &str) -> Result<BookingLink> {
        // Tokens are compared whole; a wrong one learns nothing.
        self.booking_links()?.into_iter().find(|l| l.token == token).ok_or_else(|| Error::NotFound("this booking link isn't active".into()))
    }

    /// Who the page says you are: the calendar's account, or your first one.
    fn host_name(&self, calendar_id: &str) -> Result<String> {
        let accounts = self.accounts()?;
        let c = self.collection(calendar_id)?;
        let pick = c.account_id.and_then(|id| accounts.iter().find(|a| a.id == id).cloned()).or_else(|| accounts.first().cloned());
        Ok(pick.map(|a| a.config.display_name).filter(|n| !n.trim().is_empty()).unwrap_or_else(|| "your host".into()))
    }

    /// Every free start on the half hour, inside the link's hours, from two
    /// hours from now through `days_ahead` days.
    fn free_slots(&self, l: &BookingLink) -> Result<Vec<TimeSlot>> {
        let i = &l.input;
        let len = i64::from(i.minutes) * 60;
        let tz = self.time_zone()?;
        let from = (now() + LEAD).div_euclid(GRID) * GRID + GRID;
        let until = from + i64::from(i.days_ahead) * 86_400;
        let mut busy: Vec<(i64, i64)> = self.occurrences(from - 86_400, until + 86_400)?.into_iter().filter(|o| !o.all_day).map(|o| (o.start - o.travel.unwrap_or(0) * 60, o.end)).collect();
        busy.sort_unstable();
        let mut out = Vec::new();
        for day in ical::local_date(from, &tz).iter_days().take(i.days_ahead as usize + 1) {
            if i.weekdays_only && day.weekday().number_from_monday() > 5 {
                continue;
            }
            // 24:00 is midnight at the start of the next day.
            let end = if i.day_end >= 24 * 60 { ical::local_to_utc(day + chrono::Duration::days(1), 0, &tz) } else { ical::local_to_utc(day, i.day_end, &tz) };
            let (Some(open), Some(close)) = (ical::local_to_utc(day, i.day_start, &tz), end) else { continue };
            let mut at = open.max(from).div_euclid(GRID) * GRID;
            if at < open.max(from) {
                at += GRID;
            }
            while at + len <= close && at < until {
                if !busy.iter().any(|(s, e)| *s < at + len && *e > at) {
                    out.push(TimeSlot { start: at, end: at + len });
                }
                at += GRID;
            }
        }
        Ok(out)
    }

    /// The public page's data.
    pub fn public_booking(&self, token: &str) -> Result<PublicBooking> {
        let l = self.link_by_token(token)?;
        Ok(PublicBooking {
            title: l.input.title.clone(),
            minutes: l.input.minutes,
            host: self.host_name(&l.input.calendar_id)?,
            time_zone: self.time_zone()?,
            note: l.input.note.clone(),
            slots: self.free_slots(&l)?,
        })
    }

    /// Books one of the link's free times: an event in your calendar with
    /// the booker as guest (emailed an invitation when the calendar is on a
    /// mail account). The time must still be free.
    pub fn book(&self, token: &str, req: &BookingRequest) -> Result<Booked> {
        let mut links = self.booking_links()?;
        let l = links.iter_mut().find(|l| l.token == token).ok_or_else(|| Error::NotFound("this booking link isn't active".into()))?;
        let name = req.name.trim();
        let email = req.email.trim().to_lowercase();
        if name.is_empty() || name.len() > 120 {
            return Err(Error::Invalid("add your name".into()));
        }
        let at = email.find('@').unwrap_or(0);
        if at == 0 || !email[at + 1..].contains('.') || email.contains(char::is_whitespace) || email.len() > 254 {
            return Err(Error::Invalid("that email address doesn't look right".into()));
        }
        l.booked_at.retain(|t| *t > now() - 86_400);
        if l.booked_at.len() >= MAX_PER_DAY {
            return Err(Error::Invalid("this link has taken all the bookings it can today; try again tomorrow".into()));
        }
        let link = l.clone();
        let slot = self.free_slots(&link)?.into_iter().find(|s| s.start == req.start).ok_or_else(|| Error::Invalid("that time was just taken; pick another".into()))?;
        let tz = self.time_zone()?;
        let invited = self.collection(&link.input.calendar_id)?.account_id.is_some();
        let note = req.note.as_deref().map(str::trim).filter(|n| !n.is_empty()).map(|n| n.chars().take(2000).collect::<String>());
        let notes = format!("Booked by {name} <{email}> through “{}”.{}", link.input.title, note.map(|n| format!("\n\n{n}")).unwrap_or_default());
        let title = format!("{} with {name}", link.input.title);
        self.create_event(&EventInput {
            calendar_id: link.input.calendar_id.clone(),
            title: title.clone(),
            location: None,
            notes: Some(notes),
            start: ical::local_input(slot.start, &tz),
            end: ical::local_input(slot.end, &tz),
            all_day: false,
            time_zone: tz,
            repeat: Repeat::None,
            reminders: None,
            attendees: invited.then(|| vec![Address { name: Some(name.to_string()), email: email.clone() }]),
            travel: None,
        })?;
        l.booked_at.push(now());
        self.save_links(&links)?;
        Ok(Booked { start: slot.start, end: slot.end, title: link.input.title, host: self.host_name(&link.input.calendar_id)?, invited })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CollectionKind;

    fn store() -> (Store, String) {
        let s = Store::open_in_memory().unwrap();
        s.ensure_local_collections().unwrap();
        s.set_time_zone("Europe/Lisbon").unwrap();
        let cal = s.collections(CollectionKind::Calendar).unwrap().into_iter().find(|c| c.writable && c.account_id.is_none()).unwrap().id;
        (s, cal)
    }

    fn input(cal: &str) -> BookingLinkInput {
        BookingLinkInput {
            title: "Intro call".into(),
            minutes: 30,
            calendar_id: cal.into(),
            day_start: 9 * 60,
            day_end: 17 * 60,
            weekdays_only: false,
            days_ahead: 7,
            note: Some(" On video ".into()),
        }
    }

    #[test]
    fn links_need_sensible_settings() {
        let (s, cal) = store();
        assert!(s.save_booking_link(None, &BookingLinkInput { title: " ".into(), ..input(&cal) }).is_err());
        assert!(s.save_booking_link(None, &BookingLinkInput { minutes: 5, ..input(&cal) }).is_err());
        assert!(s.save_booking_link(None, &BookingLinkInput { day_start: 17 * 60, day_end: 9 * 60, ..input(&cal) }).is_err());
        assert!(s.save_booking_link(None, &BookingLinkInput { days_ahead: 30, ..input(&cal) }).is_err());
        assert!(s.save_booking_link(None, &BookingLinkInput { calendar_id: "birthdays".into(), ..input(&cal) }).is_err(), "a read-only calendar");
        let l = s.save_booking_link(None, &input(&cal)).unwrap();
        assert_eq!((l.input.note.as_deref(), l.token.len()), (Some("On video"), 32));
        let edited = s.save_booking_link(Some(&l.id), &BookingLinkInput { minutes: 45, ..input(&cal) }).unwrap();
        assert_eq!((edited.token, edited.input.minutes), (l.token.clone(), 45), "editing keeps the address");
        s.delete_booking_link(&l.id).unwrap();
        assert!(s.public_booking(&l.token).is_err(), "a deleted link's page stops working");
    }

    #[test]
    fn the_page_shows_free_times_only_and_booking_takes_one() {
        let (s, cal) = store();
        let l = s.save_booking_link(None, &input(&cal)).unwrap();
        let page = s.public_booking(&l.token).unwrap();
        assert_eq!((page.title.as_str(), page.minutes, page.note.as_deref(), page.time_zone.as_str()), ("Intro call", 30, Some("On video"), "Europe/Lisbon"));
        assert!(!page.slots.is_empty());
        assert!(page.slots.iter().all(|t| t.start >= now() + LEAD && t.end - t.start == 1800 && t.start % GRID == 0));
        // Every slot sits inside 9–5 local time.
        assert!(page.slots.iter().all(|t| {
            let h = &ical::local_input(t.start, "Europe/Lisbon")[11..];
            let e = &ical::local_input(t.end, "Europe/Lisbon")[11..];
            h >= "09:00" && e <= "17:00" && e > h
        }));

        // A busy hour disappears from the page.
        let first = page.slots[0];
        let busy = EventInput {
            calendar_id: cal.clone(),
            title: "Kiln firing".into(),
            location: None,
            notes: None,
            start: ical::local_input(first.start, "Europe/Lisbon"),
            end: ical::local_input(first.start + 3600, "Europe/Lisbon"),
            all_day: false,
            time_zone: "Europe/Lisbon".into(),
            repeat: Repeat::None,
            reminders: None,
            attendees: None,
            travel: None,
        };
        s.create_event(&busy).unwrap();
        let after = s.public_booking(&l.token).unwrap().slots;
        assert!(after.iter().all(|t| t.end <= first.start || t.start >= first.start + 3600), "busy time is never offered");

        // Booking: validation, then the event, then the slot is gone.
        let pick = after[0];
        let req = |name: &str, email: &str, start: i64| BookingRequest { start, name: name.into(), email: email.into(), note: Some("About the glaze".into()) };
        assert!(s.book(&l.token, &req("", "ana@example.com", pick.start)).is_err());
        assert!(s.book(&l.token, &req("Ana", "not-an-email", pick.start)).is_err());
        assert!(s.book(&l.token, &req("Ana", "ana@example.com", pick.start + 60)).unwrap_err().to_string().contains("just taken"));
        assert!(s.book("wrong-token", &req("Ana", "ana@example.com", pick.start)).is_err());
        let done = s.book(&l.token, &req("Ana Duarte", "Ana@Example.com", pick.start)).unwrap();
        assert_eq!((done.start, done.invited), (pick.start, false), "a device calendar can't send invitations");
        let ev = s.occurrences(pick.start - 1, pick.end + 1).unwrap().into_iter().find(|o| o.title == "Intro call with Ana Duarte").unwrap();
        let detail = s.event(&ev.event_id, None).unwrap();
        assert!(detail.notes.unwrap().contains("Booked by Ana Duarte <ana@example.com>"));
        assert!(!s.public_booking(&l.token).unwrap().slots.iter().any(|t| t.start == pick.start), "the booked time leaves the page");
        assert!(s.book(&l.token, &req("Sam", "sam@example.com", pick.start)).unwrap_err().to_string().contains("just taken"), "no double booking");
    }

    #[test]
    fn a_whole_day_runs_to_midnight() {
        let (s, cal) = store();
        let l = s.save_booking_link(None, &BookingLinkInput { day_start: 0, day_end: 24 * 60, days_ahead: 2, ..input(&cal) }).unwrap();
        let slots = s.public_booking(&l.token).unwrap().slots;
        assert!(slots.iter().any(|t| &ical::local_input(t.start, "Europe/Lisbon")[11..] == "23:30"), "the last half hour of the day is offered");
    }

    #[test]
    fn weekdays_only_and_a_daily_limit() {
        let (s, cal) = store();
        let l = s.save_booking_link(None, &BookingLinkInput { weekdays_only: true, days_ahead: 14, ..input(&cal) }).unwrap();
        let slots = s.public_booking(&l.token).unwrap().slots;
        assert!(slots.iter().all(|t| ical::local_date(t.start, "Europe/Lisbon").weekday().number_from_monday() <= 5));
        for (n, t) in slots.iter().step_by(3).take(MAX_PER_DAY).enumerate() {
            s.book(&l.token, &BookingRequest { start: t.start, name: format!("Guest {n}"), email: format!("g{n}@example.com"), note: None }).unwrap();
        }
        let next = s.public_booking(&l.token).unwrap().slots[0].start;
        let err = s.book(&l.token, &BookingRequest { start: next, name: "One more".into(), email: "x@example.com".into(), note: None }).unwrap_err();
        assert!(err.to_string().contains("all the bookings it can today"));
    }
}
