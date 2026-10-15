//! Interesting calendars (ADR-0024): public holidays and moon phases,
//! computed on the device from rules, so they need no network, no account,
//! and no feed that can go stale or track you.

use chrono::{Datelike, Duration, NaiveDate, Weekday};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::store::Store;
use crate::{Error, EventDetail, Occurrence, Repeat, Result, ical};

/// Collection ids of interesting calendars start with this.
pub const INTERESTING_PREFIX: &str = "interesting:";
/// Their events are addressed as `special:<collection>|<YYYY-MM-DD>|<n>`.
pub const SPECIAL_PREFIX: &str = "special:";

/// One calendar you can add.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InterestingCalendar {
    pub id: String,
    pub name: String,
    /// "holidays" or "sky".
    pub group: String,
    /// ISO 3166 country code, for holidays.
    pub country: Option<String>,
    pub subscribed: bool,
}

struct Entry {
    code: &'static str,
    country: &'static str,
    color: &'static str,
}

const MOON: &str = "interesting:moon";

const HOLIDAYS: &[Entry] = &[
    Entry { code: "AU", country: "Australia", color: "#0f766e" },
    Entry { code: "BR", country: "Brazil", color: "#15803d" },
    Entry { code: "CA", country: "Canada", color: "#b91c1c" },
    Entry { code: "FR", country: "France", color: "#1d4ed8" },
    Entry { code: "DE", country: "Germany", color: "#a16207" },
    Entry { code: "IE", country: "Ireland", color: "#16a34a" },
    Entry { code: "IT", country: "Italy", color: "#047857" },
    Entry { code: "MX", country: "Mexico", color: "#be123c" },
    Entry { code: "NL", country: "the Netherlands", color: "#ea580c" },
    Entry { code: "PT", country: "Portugal", color: "#b45309" },
    Entry { code: "ES", country: "Spain", color: "#c2410c" },
    Entry { code: "GB", country: "the United Kingdom", color: "#4338ca" },
    Entry { code: "US", country: "the United States", color: "#2563eb" },
];

fn holiday_id(code: &str) -> String {
    format!("{INTERESTING_PREFIX}holidays-{}", code.to_lowercase())
}

fn calendar_name(id: &str) -> Option<(String, &'static str)> {
    if id == MOON {
        return Some(("Moon phases".into(), "#64748b"));
    }
    HOLIDAYS.iter().find(|e| holiday_id(e.code) == id).map(|e| (format!("Holidays in {}", e.country), e.color))
}

// ── Holidays ─────────────────────────────────────────────────────────────

/// Western (Gregorian) Easter Sunday, by the anonymous Gregorian algorithm.
pub fn easter(year: i32) -> NaiveDate {
    let a = year % 19;
    let b = year / 100;
    let c = year % 100;
    let d = b / 4;
    let e = b % 4;
    let f = (b + 8) / 25;
    let g = (b - f + 1) / 3;
    let h = (19 * a + b - d - g + 15) % 30;
    let i = c / 4;
    let k = c % 4;
    let l = (32 + 2 * e + 2 * i - h - k) % 7;
    let m = (a + 11 * h + 22 * l) / 451;
    let month = (h + l - 7 * m + 114) / 31;
    let day = (h + l - 7 * m + 114) % 31 + 1;
    NaiveDate::from_ymd_opt(year, month as u32, day as u32).expect("Easter is a real date")
}

fn date(y: i32, m: u32, d: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(y, m, d).expect("holiday rules name real dates")
}

/// The `n`th `weekday` of a month (1-based); `n = -1` is the last.
fn nth(y: i32, m: u32, weekday: Weekday, n: i32) -> NaiveDate {
    if n > 0 {
        NaiveDate::from_weekday_of_month_opt(y, m, weekday, n as u8).expect("a month has at least four of each weekday")
    } else {
        let mut d = if m == 12 { date(y + 1, 1, 1) } else { date(y, m + 1, 1) } - Duration::days(1);
        while d.weekday() != weekday {
            d -= Duration::days(1);
        }
        d
    }
}

fn weekend(d: NaiveDate) -> bool {
    matches!(d.weekday(), Weekday::Sat | Weekday::Sun)
}

/// Public holidays for a country in a year: national ones only (regional
/// days vary too much to guess), sorted by date. Where a holiday on a
/// weekend moves the day off, the moved day is listed too.
pub fn holidays(code: &str, y: i32) -> Vec<(NaiveDate, String)> {
    let e = easter(y);
    let ed = |days: i64| e + Duration::days(days);
    use Weekday::*;
    let mut out: Vec<(NaiveDate, &str)> = match code {
        "US" => vec![
            (date(y, 1, 1), "New Year’s Day"),
            (nth(y, 1, Mon, 3), "Martin Luther King Jr. Day"),
            (nth(y, 2, Mon, 3), "Presidents’ Day"),
            (nth(y, 5, Mon, -1), "Memorial Day"),
            (date(y, 6, 19), "Juneteenth"),
            (date(y, 7, 4), "Independence Day"),
            (nth(y, 9, Mon, 1), "Labor Day"),
            (nth(y, 10, Mon, 2), "Columbus Day"),
            (date(y, 11, 11), "Veterans Day"),
            (nth(y, 11, Thu, 4), "Thanksgiving"),
            (date(y, 12, 25), "Christmas Day"),
        ],
        "CA" => vec![
            (date(y, 1, 1), "New Year’s Day"),
            (ed(-2), "Good Friday"),
            // The Monday before May 25.
            ((1..=7).map(|i| date(y, 5, 25) - Duration::days(i)).find(|d| d.weekday() == Mon).unwrap(), "Victoria Day"),
            (date(y, 7, 1), "Canada Day"),
            (nth(y, 9, Mon, 1), "Labour Day"),
            (date(y, 9, 30), "National Day for Truth and Reconciliation"),
            (nth(y, 10, Mon, 2), "Thanksgiving"),
            (date(y, 11, 11), "Remembrance Day"),
            (date(y, 12, 25), "Christmas Day"),
            (date(y, 12, 26), "Boxing Day"),
        ],
        "MX" => vec![
            (date(y, 1, 1), "New Year’s Day"),
            (nth(y, 2, Mon, 1), "Constitution Day"),
            (nth(y, 3, Mon, 3), "Benito Juárez’s Birthday"),
            (date(y, 5, 1), "Labour Day"),
            (date(y, 9, 16), "Independence Day"),
            (nth(y, 11, Mon, 3), "Revolution Day"),
            (date(y, 12, 25), "Christmas Day"),
        ],
        "BR" => vec![
            (date(y, 1, 1), "New Year’s Day"),
            (ed(-48), "Carnival"),
            (ed(-47), "Carnival"),
            (ed(-2), "Good Friday"),
            (date(y, 4, 21), "Tiradentes Day"),
            (date(y, 5, 1), "Labour Day"),
            (ed(60), "Corpus Christi"),
            (date(y, 9, 7), "Independence Day"),
            (date(y, 10, 12), "Our Lady of Aparecida"),
            (date(y, 11, 2), "All Souls’ Day"),
            (date(y, 11, 15), "Republic Day"),
            (date(y, 11, 20), "Black Consciousness Day"),
            (date(y, 12, 25), "Christmas Day"),
        ],
        "GB" => vec![
            (date(y, 1, 1), "New Year’s Day"),
            (ed(-2), "Good Friday"),
            (ed(1), "Easter Monday"),
            (nth(y, 5, Mon, 1), "Early May bank holiday"),
            (nth(y, 5, Mon, -1), "Spring bank holiday"),
            (nth(y, 8, Mon, -1), "Summer bank holiday"),
            (date(y, 12, 25), "Christmas Day"),
            (date(y, 12, 26), "Boxing Day"),
        ],
        "IE" => vec![
            (date(y, 1, 1), "New Year’s Day"),
            // The first Monday of February, or 1 February when it's a Friday.
            (if date(y, 2, 1).weekday() == Fri { date(y, 2, 1) } else { nth(y, 2, Mon, 1) }, "St Brigid’s Day"),
            (date(y, 3, 17), "St Patrick’s Day"),
            (ed(1), "Easter Monday"),
            (nth(y, 5, Mon, 1), "May bank holiday"),
            (nth(y, 6, Mon, 1), "June bank holiday"),
            (nth(y, 8, Mon, 1), "August bank holiday"),
            (nth(y, 10, Mon, -1), "October bank holiday"),
            (date(y, 12, 25), "Christmas Day"),
            (date(y, 12, 26), "St Stephen’s Day"),
        ],
        "FR" => vec![
            (date(y, 1, 1), "New Year’s Day"),
            (ed(1), "Easter Monday"),
            (date(y, 5, 1), "Labour Day"),
            (date(y, 5, 8), "Victory in Europe Day"),
            (ed(39), "Ascension Day"),
            (ed(50), "Whit Monday"),
            (date(y, 7, 14), "Bastille Day"),
            (date(y, 8, 15), "Assumption Day"),
            (date(y, 11, 1), "All Saints’ Day"),
            (date(y, 11, 11), "Armistice Day"),
            (date(y, 12, 25), "Christmas Day"),
        ],
        "DE" => vec![
            (date(y, 1, 1), "New Year’s Day"),
            (ed(-2), "Good Friday"),
            (ed(1), "Easter Monday"),
            (date(y, 5, 1), "Labour Day"),
            (ed(39), "Ascension Day"),
            (ed(50), "Whit Monday"),
            (date(y, 10, 3), "German Unity Day"),
            (date(y, 12, 25), "Christmas Day"),
            (date(y, 12, 26), "Second Day of Christmas"),
        ],
        "ES" => vec![
            (date(y, 1, 1), "New Year’s Day"),
            (date(y, 1, 6), "Epiphany"),
            (ed(-2), "Good Friday"),
            (date(y, 5, 1), "Labour Day"),
            (date(y, 8, 15), "Assumption Day"),
            (date(y, 10, 12), "National Day of Spain"),
            (date(y, 11, 1), "All Saints’ Day"),
            (date(y, 12, 6), "Constitution Day"),
            (date(y, 12, 8), "Immaculate Conception"),
            (date(y, 12, 25), "Christmas Day"),
        ],
        "IT" => vec![
            (date(y, 1, 1), "New Year’s Day"),
            (date(y, 1, 6), "Epiphany"),
            (ed(1), "Easter Monday"),
            (date(y, 4, 25), "Liberation Day"),
            (date(y, 5, 1), "Labour Day"),
            (date(y, 6, 2), "Republic Day"),
            (date(y, 8, 15), "Assumption Day"),
            (date(y, 11, 1), "All Saints’ Day"),
            (date(y, 12, 8), "Immaculate Conception"),
            (date(y, 12, 25), "Christmas Day"),
            (date(y, 12, 26), "St Stephen’s Day"),
        ],
        "NL" => vec![
            (date(y, 1, 1), "New Year’s Day"),
            (ed(0), "Easter Sunday"),
            (ed(1), "Easter Monday"),
            // On a Sunday, King's Day is the Saturday before.
            (if date(y, 4, 27).weekday() == Sun { date(y, 4, 26) } else { date(y, 4, 27) }, "King’s Day"),
            (date(y, 5, 5), "Liberation Day"),
            (ed(39), "Ascension Day"),
            (ed(49), "Whit Sunday"),
            (ed(50), "Whit Monday"),
            (date(y, 12, 25), "Christmas Day"),
            (date(y, 12, 26), "Second Day of Christmas"),
        ],
        "PT" => vec![
            (date(y, 1, 1), "New Year’s Day"),
            (ed(-2), "Good Friday"),
            (ed(0), "Easter Sunday"),
            (date(y, 4, 25), "Freedom Day"),
            (date(y, 5, 1), "Labour Day"),
            (ed(60), "Corpus Christi"),
            (date(y, 6, 10), "Portugal Day"),
            (date(y, 8, 15), "Assumption Day"),
            (date(y, 10, 5), "Republic Day"),
            (date(y, 11, 1), "All Saints’ Day"),
            (date(y, 12, 1), "Restoration of Independence"),
            (date(y, 12, 8), "Immaculate Conception"),
            (date(y, 12, 25), "Christmas Day"),
        ],
        "AU" => vec![
            (date(y, 1, 1), "New Year’s Day"),
            (date(y, 1, 26), "Australia Day"),
            (ed(-2), "Good Friday"),
            (ed(1), "Easter Monday"),
            (date(y, 4, 25), "Anzac Day"),
            (nth(y, 6, Mon, 2), "King’s Birthday"),
            (date(y, 12, 25), "Christmas Day"),
            (date(y, 12, 26), "Boxing Day"),
        ],
        _ => vec![],
    };
    out.sort_by_key(|(d, _)| *d);
    let mut list: Vec<(NaiveDate, String)> = out.iter().map(|(d, n)| (*d, n.to_string())).collect();
    // Days off that move when the holiday falls on a weekend.
    match code {
        // Federal rule: Saturday's holiday is observed Friday, Sunday's Monday.
        "US" => {
            for (d, n) in &out {
                let moved = match d.weekday() {
                    Sat => Some(*d - Duration::days(1)),
                    Sun => Some(*d + Duration::days(1)),
                    _ => None,
                };
                if let Some(m) = moved {
                    list.push((m, format!("{n} (observed)")));
                }
            }
        }
        // A substitute weekday, the next one not already a holiday.
        "GB" | "AU" | "CA" | "IE" => {
            let movable = ["New Year’s Day", "Christmas Day", "Boxing Day", "St Stephen’s Day", "St Patrick’s Day", "Australia Day", "Canada Day"];
            let mut taken: Vec<NaiveDate> = out.iter().map(|(d, _)| *d).filter(|d| !weekend(*d)).collect();
            for (d, n) in out.iter().filter(|(d, n)| weekend(*d) && movable.contains(n)) {
                let mut m = *d + Duration::days(1);
                while weekend(m) || taken.contains(&m) {
                    m += Duration::days(1);
                }
                taken.push(m);
                list.push((m, format!("{n} (substitute day)")));
            }
        }
        _ => {}
    }
    list.sort_by_key(|(d, _)| *d);
    list
}

// ── Moon phases ──────────────────────────────────────────────────────────

/// The four principal phases.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    New,
    FirstQuarter,
    Full,
    LastQuarter,
}

impl Phase {
    fn name(self) -> &'static str {
        match self {
            Phase::New => "New moon",
            Phase::FirstQuarter => "First quarter",
            Phase::Full => "Full moon",
            Phase::LastQuarter => "Last quarter",
        }
    }
}

/// The instant (Unix seconds) of a phase in lunation `k`, by Meeus,
/// *Astronomical Algorithms* ch. 49, without the planetary terms: within
/// a couple of minutes, plenty for a calendar day.
fn phase_time(k: f64, phase: Phase) -> i64 {
    let k = k + match phase {
        Phase::New => 0.0,
        Phase::FirstQuarter => 0.25,
        Phase::Full => 0.5,
        Phase::LastQuarter => 0.75,
    };
    let t = k / 1236.85;
    let jde = 2451550.09766 + 29.530588861 * k + 0.00015437 * t * t - 0.000000150 * t.powi(3) + 0.00000000073 * t.powi(4);
    let e = 1.0 - 0.002516 * t - 0.0000074 * t * t;
    let rad = |deg: f64| deg.to_radians();
    let m = rad(2.5534 + 29.10535670 * k - 0.0000014 * t * t - 0.00000011 * t.powi(3));
    let mp = rad(201.5643 + 385.81693528 * k + 0.0107582 * t * t + 0.00001238 * t.powi(3) - 0.000000058 * t.powi(4));
    let f = rad(160.7108 + 390.67050284 * k - 0.0016118 * t * t - 0.00000227 * t.powi(3) + 0.000000011 * t.powi(4));
    let om = rad(124.7746 - 1.56375588 * k + 0.0020672 * t * t + 0.00000215 * t.powi(3));
    let s = f64::sin;
    let correction = match phase {
        Phase::New | Phase::Full => {
            let (a, b, c, d, g) = if phase == Phase::New { (-0.40720, 0.17241, 0.01608, 0.01039, 0.00739) } else { (-0.40614, 0.17302, 0.01614, 0.01043, 0.00734) };
            a * s(mp) + b * e * s(m) + c * s(2.0 * mp) + d * s(2.0 * f) + g * e * s(mp - m) - 0.00515 * e * s(mp + m) + 0.00208 * e * e * s(2.0 * m)
                - 0.00111 * s(mp - 2.0 * f)
                - 0.00057 * s(mp + 2.0 * f)
                + 0.00056 * e * s(2.0 * mp + m)
                - 0.00042 * s(3.0 * mp)
                + 0.00042 * e * s(m + 2.0 * f)
                + 0.00038 * e * s(m - 2.0 * f)
                - 0.00024 * e * s(2.0 * mp - m)
                - 0.00017 * s(om)
        }
        Phase::FirstQuarter | Phase::LastQuarter => {
            let c = -0.62801 * s(mp) + 0.17172 * e * s(m) - 0.01183 * e * s(mp + m)
                + 0.00862 * s(2.0 * mp)
                + 0.00804 * s(2.0 * f)
                + 0.00454 * e * s(mp - m)
                + 0.00204 * e * e * s(2.0 * m)
                - 0.00180 * s(mp - 2.0 * f)
                - 0.00070 * s(mp + 2.0 * f)
                - 0.00040 * s(3.0 * mp)
                - 0.00034 * e * s(2.0 * mp - m)
                + 0.00032 * e * s(m + 2.0 * f)
                + 0.00032 * e * s(m - 2.0 * f)
                - 0.00028 * e * e * s(mp + 2.0 * m)
                + 0.00027 * e * s(2.0 * mp + m)
                - 0.00017 * s(om);
            let w = 0.00306 - 0.00038 * e * m.cos() + 0.00026 * mp.cos() - 0.00002 * (mp - m).cos() + 0.00002 * (mp + m).cos() + 0.00002 * (2.0 * f).cos();
            c + if phase == Phase::FirstQuarter { w } else { -w }
        }
    };
    // JDE is Terrestrial Time; about 69 s ahead of UTC these years.
    ((jde + correction - 2440587.5) * 86400.0).round() as i64 - 69
}

/// Every principal phase whose instant falls in `[from, to)`.
pub fn moon_phases(from: i64, to: i64) -> Vec<(i64, Phase)> {
    const LUNATION: f64 = 29.530588861 * 86400.0;
    // Lunation 0 is the new moon of 6 January 2000.
    let k0 = ((from - 947_182_440) as f64 / LUNATION).floor() - 1.0;
    let mut out = Vec::new();
    let mut k = k0;
    loop {
        for p in [Phase::New, Phase::FirstQuarter, Phase::Full, Phase::LastQuarter] {
            let t = phase_time(k, p);
            if t >= from && t < to {
                out.push((t, p));
            }
        }
        if phase_time(k, Phase::New) >= to {
            break;
        }
        k += 1.0;
    }
    out
}

// ── The calendars ────────────────────────────────────────────────────────

impl Store {
    /// Every interesting calendar, and which ones you've added.
    pub fn interesting_calendars(&self) -> Result<Vec<InterestingCalendar>> {
        let have: Vec<String> = {
            let mut st = self.db.prepare("SELECT id FROM collections WHERE id LIKE 'interesting:%'")?;
            st.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?
        };
        let mut out: Vec<InterestingCalendar> = HOLIDAYS
            .iter()
            .map(|e| {
                let id = holiday_id(e.code);
                InterestingCalendar { subscribed: have.contains(&id), id, name: format!("Holidays in {}", e.country), group: "holidays".into(), country: Some(e.code.into()) }
            })
            .collect();
        out.push(InterestingCalendar { id: MOON.into(), name: "Moon phases".into(), group: "sky".into(), country: None, subscribed: have.iter().any(|h| h == MOON) });
        Ok(out)
    }

    /// Adds an interesting calendar: a read-only calendar on this device.
    pub fn add_interesting_calendar(&self, id: &str) -> Result<()> {
        let (name, color) = calendar_name(id).ok_or_else(|| Error::NotFound("there's no such calendar to add".into()))?;
        self.db.execute("INSERT OR IGNORE INTO collections (id, account_id, kind, name, color, writable) VALUES (?1, NULL, 'calendar', ?2, ?3, 0)", params![id, name, color])?;
        Ok(())
    }

    pub fn remove_interesting_calendar(&self, id: &str) -> Result<()> {
        if !id.starts_with(INTERESTING_PREFIX) {
            return Err(Error::Invalid("only added calendars can be removed here".into()));
        }
        self.db.execute("DELETE FROM collections WHERE id = ?1", [id])?;
        Ok(())
    }

    /// Holidays and moon phases overlapping `[from, to)` in the calendars
    /// you've added and are showing. Each is an all-day event on its local
    /// date.
    pub(crate) fn interesting_occurrences(&self, from: i64, to: i64) -> Result<Vec<Occurrence>> {
        let shown: Vec<String> = {
            let mut st = self.db.prepare("SELECT id FROM collections WHERE id LIKE 'interesting:%' AND hidden = 0")?;
            st.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?
        };
        if shown.is_empty() {
            return Ok(vec![]);
        }
        let tz = self.time_zone()?;
        let mut out = Vec::new();
        for cal in shown {
            for (day, n, title) in self.days_of(&cal, from, to, &tz) {
                let (Some(start), Some(end)) = (ical::local_to_utc(day, 0, &tz), ical::local_to_utc(day + Duration::days(1), 0, &tz)) else { continue };
                if start >= to || end <= from {
                    continue;
                }
                out.push(Occurrence {
                    event_id: format!("{SPECIAL_PREFIX}{cal}|{day}|{n}"),
                    calendar_id: cal.clone(),
                    title,
                    location: None,
                    start,
                    end,
                    original_start: start,
                    all_day: true,
                    recurring: false,
                    meeting_url: None,
                    contact_id: None,
                });
            }
        }
        Ok(out)
    }

    /// (local date, index on that date, title) for one calendar, with a day
    /// of slack each side so local dates at the edges aren't missed.
    fn days_of(&self, cal: &str, from: i64, to: i64, tz: &str) -> Vec<(NaiveDate, usize, String)> {
        let mut out: Vec<(NaiveDate, usize, String)> = Vec::new();
        let push = |out: &mut Vec<(NaiveDate, usize, String)>, day: NaiveDate, title: String| {
            let n = out.iter().filter(|(d, ..)| *d == day).count();
            out.push((day, n, title));
        };
        if cal == MOON {
            for (t, p) in moon_phases(from - 86400, to + 86400) {
                push(&mut out, ical::local_date(t, tz), p.name().into());
            }
        } else if let Some(e) = HOLIDAYS.iter().find(|e| holiday_id(e.code) == cal) {
            let (y0, y1) = (ical::local_date(from - 86400, tz).year(), ical::local_date(to + 86400, tz).year());
            for y in y0..=y1 {
                for (day, title) in holidays(e.code, y) {
                    push(&mut out, day, title);
                }
            }
        }
        out
    }

    /// A holiday or moon phase as a read-only event, for the event view.
    pub(crate) fn special_event(&self, id: &str) -> Result<EventDetail> {
        let gone = || Error::NotFound("that calendar was removed".into());
        let mut parts = id.strip_prefix(SPECIAL_PREFIX).ok_or_else(gone)?.split('|');
        let (Some(cal), Some(day), Some(n)) = (parts.next(), parts.next(), parts.next()) else { return Err(gone()) };
        let day: NaiveDate = day.parse().map_err(|_| gone())?;
        let n: usize = n.parse().map_err(|_| gone())?;
        let name: Option<String> = self.db.query_row("SELECT name FROM collections WHERE id = ?1", [cal], |r| r.get(0)).optional()?;
        let name = name.ok_or_else(gone)?;
        let tz = self.time_zone()?;
        let from = ical::local_to_utc(day, 0, &tz).ok_or_else(gone)?;
        let to = ical::local_to_utc(day + Duration::days(1), 0, &tz).ok_or_else(gone)?;
        let (_, _, title) = self.days_of(cal, from, to, &tz).into_iter().find(|(d, i, _)| *d == day && *i == n).ok_or_else(gone)?;
        let notes = if cal == MOON {
            moon_phases(from, to).into_iter().find(|(_, p)| p.name() == title).map(|(t, _)| format!("{title} at {} ({tz}).", &ical::local_input(t, &tz)[11..]))
        } else {
            let country = HOLIDAYS.iter().find(|e| holiday_id(e.code) == cal).map(|e| e.country).unwrap_or_default();
            Some(if title.ends_with("(observed)") || title.ends_with("(substitute day)") {
                format!("The day off for a holiday that falls on a weekend, in {country}. From {name}.")
            } else {
                format!("A public holiday in {country}. Regional holidays aren't included. From {name}.")
            })
        };
        let occurrence = Occurrence {
            event_id: id.into(),
            calendar_id: cal.into(),
            title,
            location: None,
            start: from,
            end: to,
            original_start: from,
            all_day: true,
            recurring: false,
            meeting_url: None,
            contact_id: None,
        };
        Ok(EventDetail { occurrence, notes, repeat: Repeat::None, time_zone: None, organizer: None, attendees: vec![], url: None, writable: false, reminders: vec![] })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utc(y: i32, m: u32, d: u32, h: u32, min: u32) -> i64 {
        date(y, m, d).and_hms_opt(h, min, 0).unwrap().and_utc().timestamp()
    }

    #[test]
    fn easter_dates() {
        for (y, m, d) in [(2024, 3, 31), (2025, 4, 20), (2026, 4, 5), (2027, 3, 28), (2038, 4, 25), (2285, 3, 22)] {
            assert_eq!(easter(y), date(y, m, d), "{y}");
        }
    }

    #[test]
    fn holiday_rules() {
        let us = holidays("US", 2026);
        let find = |l: &[(NaiveDate, String)], n: &str| l.iter().find(|(_, t)| t == n).map(|(d, _)| *d);
        assert_eq!(find(&us, "Thanksgiving"), Some(date(2026, 11, 26)), "fourth Thursday");
        assert_eq!(find(&us, "Memorial Day"), Some(date(2026, 5, 25)), "last Monday");
        // 4 July 2026 is a Saturday: observed Friday the 3rd.
        assert_eq!(find(&us, "Independence Day (observed)"), Some(date(2026, 7, 3)));
        // UK 2027: Christmas Saturday, Boxing Day Sunday → Mon 27 and Tue 28.
        let gb = holidays("GB", 2027);
        assert_eq!(find(&gb, "Christmas Day (substitute day)"), Some(date(2027, 12, 27)));
        assert_eq!(find(&gb, "Boxing Day (substitute day)"), Some(date(2027, 12, 28)));
        assert_eq!(find(&gb, "Easter Monday"), Some(date(2027, 3, 29)));
        assert_eq!(find(&holidays("CA", 2026), "Victoria Day"), Some(date(2026, 5, 18)), "the Monday before 25 May");
        assert_eq!(find(&holidays("CA", 2026), "Victoria Day").unwrap().weekday(), Weekday::Mon);
        assert_eq!(find(&holidays("IE", 2030), "St Brigid’s Day"), Some(date(2030, 2, 1)), "1 February when it's a Friday");
        assert_eq!(find(&holidays("IE", 2026), "St Brigid’s Day"), Some(date(2026, 2, 2)));
        assert_eq!(find(&holidays("NL", 2025), "King’s Day"), Some(date(2025, 4, 26)), "Saturday when the 27th is a Sunday");
        assert_eq!(find(&holidays("DE", 2026), "Whit Monday"), Some(date(2026, 5, 25)));
        assert_eq!(find(&holidays("PT", 2026), "Corpus Christi"), Some(date(2026, 6, 4)));
        assert_eq!(holidays("BR", 2026).iter().filter(|(_, t)| t == "Carnival").count(), 2);
        assert!(holidays("XX", 2026).is_empty());
        for e in HOLIDAYS {
            let l = holidays(e.code, 2026);
            assert!(l.len() >= 7 && l.windows(2).all(|w| w[0].0 <= w[1].0), "{}: listed and sorted", e.code);
        }
    }

    #[test]
    fn moon_phases_match_published_times() {
        // USNO: new moon 2024-01-11 11:57, full 2024-01-25 17:54, first
        // quarter 2024-01-18 03:53, last quarter 2024-02-02 23:18 (UTC).
        let got = moon_phases(utc(2024, 1, 10, 0, 0), utc(2024, 2, 4, 0, 0));
        let want = [
            (utc(2024, 1, 11, 11, 57), Phase::New),
            (utc(2024, 1, 18, 3, 53), Phase::FirstQuarter),
            (utc(2024, 1, 25, 17, 54), Phase::Full),
            (utc(2024, 2, 2, 23, 18), Phase::LastQuarter),
        ];
        assert_eq!(got.len(), 4);
        for ((t, p), (wt, wp)) in got.iter().zip(want) {
            assert_eq!(*p, wp);
            assert!((t - wt).abs() <= 180, "{p:?} off by {} s", t - wt);
        }
        // A full year has 12 or 13 full moons, in order.
        let year = moon_phases(utc(2026, 1, 1, 0, 0), utc(2027, 1, 1, 0, 0));
        let full = year.iter().filter(|(_, p)| *p == Phase::Full).count();
        assert!((12..=13).contains(&full));
        assert!(year.windows(2).all(|w| w[0].0 < w[1].0));
    }

    #[test]
    fn adding_a_calendar_puts_holidays_on_the_agenda() {
        let s = Store::open_in_memory().unwrap();
        s.ensure_local_collections().unwrap();
        s.set_time_zone("Europe/Lisbon").unwrap();
        let cats = s.interesting_calendars().unwrap();
        assert!(cats.iter().all(|c| !c.subscribed) && cats.iter().any(|c| c.id == "interesting:holidays-pt") && cats.iter().any(|c| c.id == MOON));
        assert!(s.add_interesting_calendar("interesting:holidays-zz").is_err());

        s.add_interesting_calendar("interesting:holidays-pt").unwrap();
        s.add_interesting_calendar(MOON).unwrap();
        s.add_interesting_calendar(MOON).unwrap();
        let cal = s.collections(crate::CollectionKind::Calendar).unwrap().into_iter().find(|c| c.id == "interesting:holidays-pt").unwrap();
        assert!(!cal.writable && cal.account_id.is_none());
        assert_eq!(cal.name, "Holidays in Portugal");

        let dec = s.occurrences(utc(2026, 12, 1, 0, 0), utc(2027, 1, 1, 0, 0)).unwrap();
        let xmas = dec.iter().find(|o| o.title == "Christmas Day").unwrap();
        assert!(xmas.all_day && xmas.calendar_id == "interesting:holidays-pt");
        assert_eq!(xmas.start, utc(2026, 12, 25, 0, 0), "local midnight (Lisbon is UTC in winter)");
        assert!(dec.iter().any(|o| o.title == "Full moon"));
        let d = s.event(&xmas.event_id, None).unwrap();
        assert!(!d.writable && d.notes.unwrap().contains("public holiday in Portugal"));
        let moon = dec.iter().find(|o| o.title == "Full moon").unwrap();
        assert!(s.event(&moon.event_id, None).unwrap().notes.unwrap().starts_with("Full moon at "));

        // Hiding stops them; removing forgets the calendar; a device calendar still exists.
        s.set_collection_hidden(MOON, true).unwrap();
        assert!(!s.occurrences(utc(2026, 12, 1, 0, 0), utc(2027, 1, 1, 0, 0)).unwrap().iter().any(|o| o.title == "Full moon"));
        s.remove_interesting_calendar("interesting:holidays-pt").unwrap();
        assert!(s.event(&xmas.event_id, None).is_err());
        assert!(s.remove_interesting_calendar("birthdays").is_err());
        s.ensure_local_collections().unwrap();
        assert!(s.collections(crate::CollectionKind::Calendar).unwrap().iter().any(|c| c.writable && c.account_id.is_none()));
    }
}
