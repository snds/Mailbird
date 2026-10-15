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
    /// The region you picked, for its regional days (ADR-0033).
    pub region: Option<String>,
    /// Regions you can pick, when the country has any.
    pub regions: Vec<RegionChoice>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegionChoice {
    pub code: String,
    pub name: String,
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

/// A region with its own public holidays (ADR-0033).
pub struct Region {
    pub country: &'static str,
    pub code: &'static str,
    pub name: &'static str,
}

/// Only regions whose days follow fixed rules. Spain's, Italy's, Brazil's,
/// and the US states' are set by decree or vary too much to compute.
pub const REGIONS: &[Region] = &[
    Region { country: "AU", code: "ACT", name: "the Australian Capital Territory" },
    Region { country: "AU", code: "NSW", name: "New South Wales" },
    Region { country: "AU", code: "NT", name: "the Northern Territory" },
    Region { country: "AU", code: "QLD", name: "Queensland" },
    Region { country: "AU", code: "SA", name: "South Australia" },
    Region { country: "AU", code: "TAS", name: "Tasmania" },
    Region { country: "AU", code: "VIC", name: "Victoria" },
    Region { country: "AU", code: "WA", name: "Western Australia" },
    Region { country: "CA", code: "AB", name: "Alberta" },
    Region { country: "CA", code: "BC", name: "British Columbia" },
    Region { country: "CA", code: "MB", name: "Manitoba" },
    Region { country: "CA", code: "NB", name: "New Brunswick" },
    Region { country: "CA", code: "NS", name: "Nova Scotia" },
    Region { country: "CA", code: "ON", name: "Ontario" },
    Region { country: "CA", code: "PE", name: "Prince Edward Island" },
    Region { country: "CA", code: "QC", name: "Quebec" },
    Region { country: "CA", code: "SK", name: "Saskatchewan" },
    Region { country: "FR", code: "ALS", name: "Alsace and Moselle" },
    Region { country: "DE", code: "BW", name: "Baden-Württemberg" },
    Region { country: "DE", code: "BY", name: "Bavaria" },
    Region { country: "DE", code: "BE", name: "Berlin" },
    Region { country: "DE", code: "BB", name: "Brandenburg" },
    Region { country: "DE", code: "HB", name: "Bremen" },
    Region { country: "DE", code: "HH", name: "Hamburg" },
    Region { country: "DE", code: "HE", name: "Hesse" },
    Region { country: "DE", code: "NI", name: "Lower Saxony" },
    Region { country: "DE", code: "MV", name: "Mecklenburg-Western Pomerania" },
    Region { country: "DE", code: "NW", name: "North Rhine-Westphalia" },
    Region { country: "DE", code: "RP", name: "Rhineland-Palatinate" },
    Region { country: "DE", code: "SL", name: "Saarland" },
    Region { country: "DE", code: "SN", name: "Saxony" },
    Region { country: "DE", code: "ST", name: "Saxony-Anhalt" },
    Region { country: "DE", code: "SH", name: "Schleswig-Holstein" },
    Region { country: "DE", code: "TH", name: "Thuringia" },
    Region { country: "PT", code: "AC", name: "the Azores" },
    Region { country: "PT", code: "MA", name: "Madeira" },
    Region { country: "GB", code: "ENG", name: "England" },
    Region { country: "GB", code: "NIR", name: "Northern Ireland" },
    Region { country: "GB", code: "SCT", name: "Scotland" },
    Region { country: "GB", code: "WLS", name: "Wales" },
];

/// How a regional day falls in a year.
enum Rule {
    Fixed(u32, u32),
    /// Days from Easter Sunday.
    Easter(i64),
    /// The nth weekday of a month; -1 is the last.
    Nth(u32, Weekday, i32),
    /// The first weekday on or after a date.
    OnOrAfter(u32, u32, Weekday),
    /// The last weekday before a date.
    Before(u32, u32, Weekday),
}

impl Rule {
    fn on(&self, y: i32, easter: NaiveDate) -> NaiveDate {
        match *self {
            Rule::Fixed(m, d) => date(y, m, d),
            Rule::Easter(n) => easter + Duration::days(n),
            Rule::Nth(m, wd, n) => nth(y, m, wd, n),
            Rule::OnOrAfter(m, d, wd) => (0..7).map(|i| date(y, m, d) + Duration::days(i)).find(|x| x.weekday() == wd).expect("a week has every weekday"),
            Rule::Before(m, d, wd) => (1..=7).map(|i| date(y, m, d) - Duration::days(i)).find(|x| x.weekday() == wd).expect("a week has every weekday"),
        }
    }
}

/// A regional public holiday: the country, the regions that keep it, when, and its name.
struct Extra(&'static str, &'static [&'static str], Rule, &'static str);

const EXTRAS: &[Extra] = {
    use Rule::*;
    use Weekday::*;
    &[
        // Australia: each state sets its own Labour Day and a few more.
        Extra("AU", &["NSW", "VIC", "QLD", "SA", "ACT", "NT"], Easter(-1), "Easter Saturday"),
        Extra("AU", &["NSW", "VIC", "QLD", "ACT", "WA"], Easter(0), "Easter Sunday"),
        Extra("AU", &["NSW", "SA", "ACT"], Nth(10, Mon, 1), "Labour Day"),
        Extra("AU", &["VIC"], Nth(3, Mon, 2), "Labour Day"),
        Extra("AU", &["QLD"], Nth(5, Mon, 1), "Labour Day"),
        Extra("AU", &["WA"], Nth(3, Mon, 1), "Labour Day"),
        Extra("AU", &["TAS"], Nth(3, Mon, 2), "Eight Hours Day"),
        Extra("AU", &["NT"], Nth(5, Mon, 1), "May Day"),
        Extra("AU", &["QLD"], Nth(10, Mon, 1), "King’s Birthday"),
        Extra("AU", &["VIC"], Nth(11, Tue, 1), "Melbourne Cup"),
        Extra("AU", &["ACT"], Nth(3, Mon, 2), "Canberra Day"),
        Extra("AU", &["ACT"], OnOrAfter(5, 27, Mon), "Reconciliation Day"),
        Extra("AU", &["SA"], Nth(3, Mon, 2), "Adelaide Cup"),
        Extra("AU", &["WA"], Nth(6, Mon, 1), "Western Australia Day"),
        Extra("AU", &["NT"], Nth(8, Mon, 1), "Picnic Day"),
        // Canada: the February long weekend goes by four names.
        Extra("CA", &["AB", "BC", "NB", "ON", "SK"], Nth(2, Mon, 3), "Family Day"),
        Extra("CA", &["MB"], Nth(2, Mon, 3), "Louis Riel Day"),
        Extra("CA", &["PE"], Nth(2, Mon, 3), "Islander Day"),
        Extra("CA", &["NS"], Nth(2, Mon, 3), "Heritage Day"),
        Extra("CA", &["QC"], Fixed(6, 24), "Saint-Jean-Baptiste Day"),
        Extra("CA", &["BC"], Nth(8, Mon, 1), "British Columbia Day"),
        Extra("CA", &["NB"], Nth(8, Mon, 1), "New Brunswick Day"),
        Extra("CA", &["SK"], Nth(8, Mon, 1), "Saskatchewan Day"),
        Extra("CA", &["MB"], Nth(8, Mon, 1), "Terry Fox Day"),
        // France: Alsace and Moselle keep two days from German law.
        Extra("FR", &["ALS"], Easter(-2), "Good Friday"),
        Extra("FR", &["ALS"], Fixed(12, 26), "St Stephen’s Day"),
        // Germany: each Land adds its own.
        Extra("DE", &["BW", "BY", "ST"], Fixed(1, 6), "Epiphany"),
        Extra("DE", &["BE", "MV"], Fixed(3, 8), "International Women’s Day"),
        Extra("DE", &["BB"], Easter(0), "Easter Sunday"),
        Extra("DE", &["BB"], Easter(49), "Whit Sunday"),
        Extra("DE", &["BW", "BY", "HE", "NW", "RP", "SL"], Easter(60), "Corpus Christi"),
        Extra("DE", &["SL"], Fixed(8, 15), "Assumption Day"),
        Extra("DE", &["TH"], Fixed(9, 20), "World Children’s Day"),
        Extra("DE", &["BB", "HB", "HH", "MV", "NI", "SN", "ST", "SH", "TH"], Fixed(10, 31), "Reformation Day"),
        Extra("DE", &["BW", "BY", "NW", "RP", "SL"], Fixed(11, 1), "All Saints’ Day"),
        Extra("DE", &["SN"], Before(11, 23, Wed), "Day of Repentance and Prayer"),
        // Portugal: the autonomous regions.
        Extra("PT", &["AC"], Easter(50), "Azores Day"),
        Extra("PT", &["MA"], Fixed(7, 1), "Madeira Day"),
        Extra("PT", &["MA"], Fixed(12, 26), "Primeira Oitava"),
        // The United Kingdom: Scotland and Northern Ireland differ.
        Extra("GB", &["SCT"], Fixed(1, 2), "2 January"),
        Extra("GB", &["SCT"], Nth(8, Mon, 1), "Summer bank holiday"),
        Extra("GB", &["SCT"], Fixed(11, 30), "St Andrew’s Day"),
        Extra("GB", &["NIR"], Fixed(3, 17), "St Patrick’s Day"),
        Extra("GB", &["NIR"], Fixed(7, 12), "Battle of the Boyne"),
    ]
};

/// National days a region doesn't keep: (country, regions, name).
const DROPS: &[(&str, &[&str], &str)] = &[
    // Scotland has no Easter Monday, and its summer holiday is in early August.
    ("GB", &["SCT"], "Easter Monday"),
    ("GB", &["SCT"], "Summer bank holiday"),
    // Queensland's is in October; Western Australia's is proclaimed each year.
    ("AU", &["QLD", "WA"], "King’s Birthday"),
];

/// The regions of a country, if it has any with their own days.
pub fn regions_of(code: &str) -> impl Iterator<Item = &'static Region> + '_ {
    REGIONS.iter().filter(move |r| r.country == code)
}

fn region_name(code: &str, region: &str) -> Option<&'static str> {
    regions_of(code).find(|r| r.code == region).map(|r| r.name)
}

/// Settings key: country code → region code.
const HOLIDAY_REGIONS: &str = "holiday_regions";

fn holiday_id(code: &str) -> String {
    format!("{INTERESTING_PREFIX}holidays-{}", code.to_lowercase())
}

fn calendar_name(id: &str, region: Option<&str>) -> Option<(String, &'static str)> {
    if id == MOON {
        return Some(("Moon phases".into(), "#64748b"));
    }
    let e = HOLIDAYS.iter().find(|e| holiday_id(e.code) == id)?;
    let place = region.and_then(|r| region_name(e.code, r)).unwrap_or(e.country);
    Some((format!("Holidays in {place}"), e.color))
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

/// Public holidays for a country in a year, nationwide only.
pub fn holidays(code: &str, y: i32) -> Vec<(NaiveDate, String)> {
    holidays_in(code, None, y)
}

/// Public holidays for a country, or one of its regions (ADR-0033), in a
/// year, sorted by date. Where a holiday on a weekend moves the day off,
/// the moved day is listed too.
pub fn holidays_in(code: &str, region: Option<&str>, y: i32) -> Vec<(NaiveDate, String)> {
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
    if let Some(r) = region {
        out.retain(|(_, n)| !DROPS.iter().any(|(c, rs, name)| *c == code && rs.contains(&r) && name == n));
        for Extra(_, _, rule, name) in EXTRAS.iter().filter(|Extra(c, rs, ..)| *c == code && rs.contains(&r)) {
            out.push((rule.on(y, e), name));
        }
    }
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
            let movable = [
                "New Year’s Day",
                "Christmas Day",
                "Boxing Day",
                "St Stephen’s Day",
                "St Patrick’s Day",
                "Australia Day",
                "Canada Day",
                "2 January",
                "St Andrew’s Day",
                "Battle of the Boyne",
                "Saint-Jean-Baptiste Day",
            ];
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
    fn holiday_regions(&self) -> Result<std::collections::BTreeMap<String, String>> {
        Ok(self.setting(HOLIDAY_REGIONS)?.map(crate::store::from_json).unwrap_or_default())
    }

    fn region_for(&self, code: &str) -> Result<Option<String>> {
        Ok(self.holiday_regions()?.remove(code).filter(|r| region_name(code, r).is_some()))
    }

    /// Picks the region whose days a holiday calendar shows, or none for
    /// nationwide only (ADR-0033). An added calendar is renamed to match.
    pub fn set_holiday_region(&self, id: &str, region: Option<&str>) -> Result<()> {
        let e = HOLIDAYS.iter().find(|e| holiday_id(e.code) == id).ok_or_else(|| Error::NotFound("there's no such holiday calendar".into()))?;
        if let Some(r) = region
            && region_name(e.code, r).is_none()
        {
            return Err(Error::Invalid(format!("“{r}” isn't a region of {} with its own holidays", e.country)));
        }
        let mut all = self.holiday_regions()?;
        match region {
            Some(r) => all.insert(e.code.into(), r.into()),
            None => all.remove(e.code),
        };
        let stored = (!all.is_empty()).then(|| crate::store::json(&all));
        self.set_setting(HOLIDAY_REGIONS, stored.as_deref())?;
        let (name, _) = calendar_name(id, region).expect("a listed country has a name");
        self.db.execute("UPDATE collections SET name = ?2 WHERE id = ?1", params![id, name])?;
        Ok(())
    }

    /// Every interesting calendar, and which ones you've added.
    pub fn interesting_calendars(&self) -> Result<Vec<InterestingCalendar>> {
        let have: Vec<String> = {
            let mut st = self.db.prepare("SELECT id FROM collections WHERE id LIKE 'interesting:%'")?;
            st.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?
        };
        let regions = self.holiday_regions()?;
        let mut out: Vec<InterestingCalendar> = HOLIDAYS
            .iter()
            .map(|e| {
                let id = holiday_id(e.code);
                let region = regions.get(e.code).filter(|r| region_name(e.code, r).is_some()).cloned();
                InterestingCalendar {
                    subscribed: have.contains(&id),
                    name: calendar_name(&id, region.as_deref()).expect("a listed country has a name").0,
                    id,
                    group: "holidays".into(),
                    country: Some(e.code.into()),
                    region,
                    regions: regions_of(e.code).map(|r| RegionChoice { code: r.code.into(), name: r.name.into() }).collect(),
                }
            })
            .collect();
        out.push(InterestingCalendar { id: MOON.into(), name: "Moon phases".into(), group: "sky".into(), country: None, subscribed: have.iter().any(|h| h == MOON), region: None, regions: vec![] });
        Ok(out)
    }

    /// Adds an interesting calendar: a read-only calendar on this device.
    pub fn add_interesting_calendar(&self, id: &str) -> Result<()> {
        let code = HOLIDAYS.iter().find(|e| holiday_id(e.code) == id).map(|e| e.code);
        let region = code.map(|c| self.region_for(c)).transpose()?.flatten();
        let (name, color) = calendar_name(id, region.as_deref()).ok_or_else(|| Error::NotFound("there's no such calendar to add".into()))?;
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
                    travel: None,
                    meeting_app_url: None,
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
            let region = self.region_for(e.code).ok().flatten();
            let (y0, y1) = (ical::local_date(from - 86400, tz).year(), ical::local_date(to + 86400, tz).year());
            for y in y0..=y1 {
                for (day, title) in holidays_in(e.code, region.as_deref(), y) {
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
            let e = HOLIDAYS.iter().find(|e| holiday_id(e.code) == cal).ok_or_else(gone)?;
            let region = self.region_for(e.code)?;
            let place = region.as_deref().and_then(|r| region_name(e.code, r));
            let nationwide = holidays(e.code, day.year()).iter().any(|(d, t)| *d == day && *t == title);
            Some(if title.ends_with("(observed)") || title.ends_with("(substitute day)") {
                format!("The day off for a holiday that falls on a weekend, in {}. From {name}.", place.unwrap_or(e.country))
            } else if let (Some(place), false) = (place, nationwide) {
                format!("A public holiday in {place}, not across {}. From {name}.", e.country)
            } else if place.is_none() && regions_of(e.code).next().is_some() {
                format!("A public holiday in {}. To see your region's days too, pick it in Add holidays and more. From {name}.", e.country)
            } else {
                format!("A public holiday in {}. From {name}.", e.country)
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
            travel: None,
            meeting_app_url: None,
        };
        Ok(EventDetail { occurrence, notes, repeat: Repeat::None, time_zone: None, organizer: None, attendees: vec![], url: None, writable: false, reminders: vec![], meeting: None, manage: vec![] })
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

    #[test]
    fn regional_rules() {
        let find = |l: &[(NaiveDate, String)], n: &str| l.iter().find(|(_, t)| t == n).map(|(d, _)| *d);
        // Bavaria 2026: Corpus Christi 4 June, All Saints' 1 November, Epiphany.
        let by = holidays_in("DE", Some("BY"), 2026);
        assert_eq!(find(&by, "Corpus Christi"), Some(date(2026, 6, 4)));
        assert_eq!(find(&by, "Epiphany"), Some(date(2026, 1, 6)));
        assert_eq!(find(&by, "Whit Monday"), Some(date(2026, 5, 25)), "national days stay");
        assert_eq!(find(&holidays("DE", 2026), "Corpus Christi"), None, "not nationwide");
        // Saxony's Day of Repentance and Prayer: the Wednesday before 23 November.
        for (y, d) in [(2024, 20), (2025, 19), (2026, 18), (2028, 22)] {
            assert_eq!(find(&holidays_in("DE", Some("SN"), y), "Day of Repentance and Prayer"), Some(date(y, 11, d)), "{y}");
        }
        assert_eq!(find(&holidays_in("DE", Some("TH"), 2026), "World Children’s Day"), Some(date(2026, 9, 20)));
        // Scotland: 2 January, early-August summer holiday, no Easter Monday.
        let sct = holidays_in("GB", Some("SCT"), 2026);
        assert_eq!(find(&sct, "2 January"), Some(date(2026, 1, 2)));
        assert_eq!(find(&sct, "Summer bank holiday"), Some(date(2026, 8, 3)));
        assert_eq!(find(&sct, "Easter Monday"), None);
        assert_eq!(find(&sct, "St Andrew’s Day"), Some(date(2026, 11, 30)));
        // 2022: 1 Jan Saturday, 2 Jan Sunday → Mon 3 and Tue 4 off in Scotland.
        let sct22 = holidays_in("GB", Some("SCT"), 2022);
        assert_eq!(find(&sct22, "New Year’s Day (substitute day)"), Some(date(2022, 1, 3)));
        assert_eq!(find(&sct22, "2 January (substitute day)"), Some(date(2022, 1, 4)));
        // Northern Ireland: the Boyne on 12 July (Sunday in 2026 → Monday 13).
        let nir = holidays_in("GB", Some("NIR"), 2026);
        assert_eq!(find(&nir, "Battle of the Boyne (substitute day)"), Some(date(2026, 7, 13)));
        assert_eq!(find(&nir, "Easter Monday"), Some(date(2026, 4, 6)));
        // Australia: Victoria's Melbourne Cup and Labour Day; Queensland's King's Birthday.
        let vic = holidays_in("AU", Some("VIC"), 2026);
        assert_eq!(find(&vic, "Melbourne Cup"), Some(date(2026, 11, 3)));
        assert_eq!(find(&vic, "Labour Day"), Some(date(2026, 3, 9)));
        let qld = holidays_in("AU", Some("QLD"), 2026);
        assert_eq!(find(&qld, "King’s Birthday"), Some(date(2026, 10, 5)));
        assert_eq!(qld.iter().filter(|(_, t)| t == "King’s Birthday").count(), 1, "the June one is dropped");
        assert_eq!(find(&holidays_in("AU", Some("ACT"), 2026), "Reconciliation Day"), Some(date(2026, 6, 1)));
        // Canada: Family Day in Ontario, Saint-Jean-Baptiste in Quebec.
        assert_eq!(find(&holidays_in("CA", Some("ON"), 2026), "Family Day"), Some(date(2026, 2, 16)));
        assert_eq!(find(&holidays_in("CA", Some("QC"), 2026), "Saint-Jean-Baptiste Day"), Some(date(2026, 6, 24)));
        assert_eq!(find(&holidays_in("FR", Some("ALS"), 2026), "Good Friday"), Some(date(2026, 4, 3)));
        assert_eq!(find(&holidays_in("PT", Some("AC"), 2026), "Azores Day"), Some(date(2026, 5, 25)));
        // Every region's list stays sorted, and an unknown region is just the nation.
        for r in REGIONS {
            let l = holidays_in(r.country, Some(r.code), 2026);
            assert!(l.windows(2).all(|w| w[0].0 <= w[1].0), "{}-{}", r.country, r.code);
        }
        assert_eq!(holidays_in("DE", Some("XX"), 2026), holidays("DE", 2026));
    }

    #[test]
    fn picking_a_region_adds_its_days() {
        let s = Store::open_in_memory().unwrap();
        s.ensure_local_collections().unwrap();
        s.set_time_zone("Europe/Berlin").unwrap();
        let de = "interesting:holidays-de";
        // Picked before adding: the calendar is named for the region.
        s.set_holiday_region(de, Some("BY")).unwrap();
        s.add_interesting_calendar(de).unwrap();
        let cat = s.interesting_calendars().unwrap().into_iter().find(|c| c.id == de).unwrap();
        assert_eq!((cat.name.as_str(), cat.region.as_deref(), cat.regions.len()), ("Holidays in Bavaria", Some("BY"), 16));
        let cal = s.collections(crate::CollectionKind::Calendar).unwrap().into_iter().find(|c| c.id == de).unwrap();
        assert_eq!(cal.name, "Holidays in Bavaria");
        let june = s.occurrences(utc(2026, 6, 1, 0, 0), utc(2026, 6, 30, 0, 0)).unwrap();
        let cc = june.iter().find(|o| o.title == "Corpus Christi").unwrap();
        assert!(s.event(&cc.event_id, None).unwrap().notes.unwrap().contains("in Bavaria, not across Germany"));
        let may = s.occurrences(utc(2026, 5, 20, 0, 0), utc(2026, 5, 31, 0, 0)).unwrap();
        let whit = may.iter().find(|o| o.title == "Whit Monday").unwrap();
        assert!(s.event(&whit.event_id, None).unwrap().notes.unwrap().starts_with("A public holiday in Germany."));

        // Back to nationwide: the regional day goes, and the name follows.
        s.set_holiday_region(de, None).unwrap();
        assert!(!s.occurrences(utc(2026, 6, 1, 0, 0), utc(2026, 6, 30, 0, 0)).unwrap().iter().any(|o| o.title == "Corpus Christi"));
        assert_eq!(s.collections(crate::CollectionKind::Calendar).unwrap().into_iter().find(|c| c.id == de).unwrap().name, "Holidays in Germany");
        let whit = s.event(&whit.event_id, None).unwrap();
        assert!(whit.notes.unwrap().contains("pick it in Add holidays and more"));

        // Refusals change nothing.
        assert!(s.set_holiday_region(de, Some("SCT")).unwrap_err().to_string().contains("isn't a region of Germany"));
        assert!(s.set_holiday_region("interesting:moon", None).is_err());
        assert_eq!(s.interesting_calendars().unwrap().into_iter().find(|c| c.id == de).unwrap().region, None);
        let us = s.interesting_calendars().unwrap().into_iter().find(|c| c.id == "interesting:holidays-us").unwrap();
        assert!(us.regions.is_empty(), "no computable regions");
    }
}
