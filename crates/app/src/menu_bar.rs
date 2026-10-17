//! The menu-bar mini calendar (ADR-0054): what the menu bar or tray says
//! about your next event, and whether it's there at all. The desktop shell
//! draws it; this decides what it says, so the logic is the same everywhere
//! and testable without a desktop.

use pim_core::{Occurrence, now};
use serde::{Deserialize, Serialize};

use crate::commands::{Res, with_store};
use crate::{AppHandle, Shared};

const PREFS: &str = "menubar.prefs";
/// How far ahead the menu bar looks for the next event.
const AHEAD: i64 = 12 * 3600;
/// The longest title the menu bar shows before it shortens it.
const MAX_TITLE: usize = 24;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuBarPrefs {
    /// The mini calendar in the menu bar (macOS) or tray (Windows, Linux).
    /// While it's on, closing the window keeps Mailbird running there.
    #[serde(default = "yes")]
    pub enabled: bool,
    /// The next event's name beside the icon: in the macOS menu bar, and on
    /// Linux panels that show a label. Windows trays have no room for text,
    /// so it's the tooltip there.
    #[serde(default = "yes")]
    pub show_next: bool,
}

fn yes() -> bool {
    true
}

impl Default for MenuBarPrefs {
    fn default() -> Self {
        Self { enabled: true, show_next: true }
    }
}

/// What the shell draws: nothing when it's off, else the icon with an
/// optional title, and a tooltip.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuBarState {
    pub enabled: bool,
    /// Beside the icon, when `show_next` is on and something is coming up.
    pub title: Option<String>,
    /// Always says what's next, or that the day is clear.
    pub tooltip: String,
}

/// The event the menu bar talks about: the one happening now, or else the
/// next one to start in the next 12 hours. All-day events and birthdays
/// don't count; they'd crowd out the meeting you're about to miss.
pub fn next_up(occurrences: &[Occurrence], at: i64) -> Option<&Occurrence> {
    let timed = occurrences.iter().filter(|o| !o.all_day && o.contact_id.is_none() && o.end > at && o.start < at + AHEAD);
    // Something on now wins, unless the next one starts within 5 minutes:
    // then the next one is what you need to know about.
    let now_on = timed.clone().filter(|o| o.start <= at).min_by_key(|o| o.end);
    let next = timed.filter(|o| o.start > at).min_by_key(|o| (o.start, o.end));
    match (now_on, next) {
        (Some(_), Some(n)) if n.start - at <= 5 * 60 => Some(n),
        (Some(c), _) => Some(c),
        (None, n) => n,
    }
}

/// "in 25 min", "in 2 h 5 min", or "now": relative, so it needs no clock
/// format or time zone, and it reads the same in every locale's menu bar.
pub fn when(o: &Occurrence, at: i64) -> String {
    if o.start <= at {
        return "now".into();
    }
    let mins = (o.start - at + 59) / 60;
    match (mins / 60, mins % 60) {
        (0, m) => format!("in {m} min"),
        (h, 0) => format!("in {h} h"),
        (h, m) => format!("in {h} h {m} min"),
    }
}

fn shorten(s: &str) -> String {
    let s = s.trim();
    let s = if s.is_empty() { "Untitled event" } else { s };
    if s.chars().count() <= MAX_TITLE {
        return s.to_string();
    }
    let cut: String = s.chars().take(MAX_TITLE - 1).collect();
    format!("{}…", cut.trim_end())
}

/// What the menu bar shows for these prefs, events, and moment.
pub fn state_for(prefs: MenuBarPrefs, occurrences: &[Occurrence], at: i64) -> MenuBarState {
    let next = next_up(occurrences, at);
    let tooltip = match next {
        Some(o) if o.start <= at => format!("Now: {}", o.title.trim()),
        Some(o) => format!("Next: {}, {}", o.title.trim(), when(o, at)),
        None => "Nothing else in the next 12 hours".into(),
    };
    let title = next.filter(|_| prefs.enabled && prefs.show_next).map(|o| format!("{} {}", shorten(&o.title), when(o, at)));
    MenuBarState { enabled: prefs.enabled, title, tooltip }
}

pub fn prefs(state: &Shared) -> Res<MenuBarPrefs> {
    with_store(state, |s| s.setting(PREFS)).map(|v| v.and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default())
}

pub fn set_prefs(app: &AppHandle, state: &Shared, prefs: MenuBarPrefs) -> Res<MenuBarPrefs> {
    let v = serde_json::to_string(&prefs).map_err(|e| e.to_string())?;
    with_store(state, |s| s.set_setting(PREFS, Some(&v)))?;
    refresh(app, state);
    Ok(prefs)
}

/// The menu bar's state now. Cheap: one look at the next 12 hours.
pub fn current(state: &Shared) -> Res<MenuBarState> {
    let at = now();
    let prefs = prefs(state)?;
    let occ = with_store(state, |s| s.occurrences(at - AHEAD, at + AHEAD))?;
    Ok(state_for(prefs, &occ, at))
}

/// Tells the host what to draw. Called on a timer and after changes.
pub fn refresh(app: &AppHandle, state: &Shared) {
    match current(state) {
        Ok(s) => app.menu_bar(&s),
        Err(e) => log::info!("couldn't work out the menu bar: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn occ(title: &str, start: i64, end: i64) -> Occurrence {
        Occurrence {
            event_id: title.into(),
            calendar_id: "c".into(),
            title: title.into(),
            location: None,
            start,
            end,
            original_start: start,
            all_day: false,
            recurring: false,
            meeting_url: None,
            contact_id: None,
            travel: None,
            meeting_app_url: None,
        }
    }

    #[test]
    fn the_next_event_is_the_one_coming_up() {
        let at = 10_000_000;
        let mut all_day = occ("Holiday", at - 3600, at + 20 * 3600);
        all_day.all_day = true;
        let mut birthday = occ("Ana's birthday", at + 60, at + 3600);
        birthday.contact_id = Some("ana".into());
        let list = vec![all_day, birthday, occ("Lunch", at + 2 * 3600, at + 3 * 3600), occ("Review", at + 25 * 60, at + 3600), occ("Done", at - 3600, at)];
        assert_eq!(next_up(&list, at).unwrap().title, "Review", "all-day events, birthdays, and finished events don't count");
        assert_eq!(when(next_up(&list, at).unwrap(), at), "in 25 min");
        assert!(next_up(&[occ("Tomorrow", at + 13 * 3600, at + 14 * 3600)], at).is_none(), "only the next 12 hours");
    }

    #[test]
    fn something_on_now_wins_until_the_next_is_close() {
        let at = 10_000_000;
        let on = occ("Standup", at - 600, at + 1200);
        assert_eq!(next_up(&[on.clone(), occ("Review", at + 600, at + 3600)], at).unwrap().title, "Standup");
        assert_eq!(next_up(&[on.clone(), occ("Review", at + 240, at + 3600)], at).unwrap().title, "Review", "within 5 minutes, the next one");
        assert_eq!(when(&on, at), "now");
    }

    #[test]
    fn times_read_relatively() {
        let at = 0;
        assert_eq!(when(&occ("a", 30, 60), at), "in 1 min", "rounds up: never says 0");
        assert_eq!(when(&occ("a", 3600, 7200), at), "in 1 h");
        assert_eq!(when(&occ("a", 2 * 3600 + 5 * 60, 3 * 3600), at), "in 2 h 5 min");
    }

    #[test]
    fn the_state_follows_the_prefs() {
        let at = 10_000_000;
        let list = vec![occ("Quarterly planning with the whole design team", at + 600, at + 3600)];
        let on = state_for(MenuBarPrefs::default(), &list, at);
        assert_eq!(on.title.as_deref(), Some("Quarterly planning with… in 10 min"), "long names are shortened");
        assert_eq!(on.tooltip, "Next: Quarterly planning with the whole design team, in 10 min");
        let quiet = state_for(MenuBarPrefs { enabled: true, show_next: false }, &list, at);
        assert_eq!((quiet.enabled, quiet.title), (true, None), "icon only");
        let off = state_for(MenuBarPrefs { enabled: false, show_next: true }, &list, at);
        assert!(!off.enabled && off.title.is_none());
        assert_eq!(state_for(MenuBarPrefs::default(), &[], at).tooltip, "Nothing else in the next 12 hours");
    }
}
