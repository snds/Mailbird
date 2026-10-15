//! Finding the video-call link in an event: Zoom, Google Meet, Microsoft
//! Teams, Webex, Jitsi, Whereby, FaceTime, GoTo, Chime. Invitations put it
//! in the location, the URL, the description, or a conference property,
//! often among other links (maps, dial-in help), so only known meeting
//! hosts count.
//!
//! [`meeting_info`] reads the rest of what an invitation says about the call
//! (ADR-0030): the service, a link that opens its app, the meeting ID and
//! passcode, dial-in numbers, and the reschedule and cancel links that
//! booking tools (Calendly, Cal.com, …) put in their invitations.

use serde::{Deserialize, Serialize};

use crate::store::{Store, from_json, json};
use crate::{Error, Result};

/// How Join opens calls (ADR-0030).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingPrefs {
    /// Open calls in the service's app (Zoom, Teams) when it has a link for one; else the browser.
    pub open_in_apps: bool,
}

impl Default for MeetingPrefs {
    fn default() -> Self {
        Self { open_in_apps: true }
    }
}

const PREFS: &str = "meetings.prefs";

impl Store {
    pub fn meeting_prefs(&self) -> Result<MeetingPrefs> {
        Ok(self.setting(PREFS)?.map(from_json::<MeetingPrefs>).unwrap_or_default())
    }

    pub fn set_meeting_prefs(&self, prefs: &MeetingPrefs) -> Result<MeetingPrefs> {
        self.set_setting(PREFS, Some(&json(prefs)))?;
        Ok(prefs.clone())
    }
}

/// Whether a link is safe to hand to the system to open as a call: a known
/// meeting page, or one of the app schemes [`app_link`] makes. Nothing else
/// (no `file:`, no other app's scheme) gets through.
pub fn openable(url: &str) -> Result<()> {
    if (url.starts_with("https://") && service_of(url).is_some()) || url.starts_with("zoommtg://") || url.starts_with("msteams:/") || manage_links([url]).first().is_some_and(|m| m.url == url) {
        Ok(())
    } else {
        Err(Error::Invalid("that isn't a meeting link".into()))
    }
}

/// Hosts that serve meetings, and the path a meeting link must start with
/// (so a Zoom marketing page or a Teams settings link doesn't count).
const HOSTS: &[(&str, &[&str])] = &[
    ("zoom.us", &["/j/", "/my/", "/w/", "/s/"]),
    ("zoomgov.com", &["/j/"]),
    ("meet.google.com", &["/"]),
    ("teams.microsoft.com", &["/l/meetup-join/", "/meet/"]),
    ("teams.live.com", &["/meet/"]),
    ("webex.com", &["/meet/", "/join/", "/wbxmjs/"]),
    ("meet.jit.si", &["/"]),
    ("whereby.com", &["/"]),
    ("facetime.apple.com", &["/join"]),
    ("meet.goto.com", &["/"]),
    ("global.gotomeeting.com", &["/join/"]),
    ("chime.aws", &["/"]),
];

/// The first meeting link in these texts, in order.
pub fn meeting_link<'a>(texts: impl IntoIterator<Item = &'a str>) -> Option<String> {
    texts.into_iter().find_map(|t| {
        t.split(|c: char| c.is_whitespace() || "<>\"'()[]{}|".contains(c)).find_map(|token| {
            let url = token.trim_end_matches(['.', ',', ';', ':', '!', '?']);
            is_meeting(url).then(|| url.to_string())
        })
    })
}

fn is_meeting(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else { return false };
    let (host, path) = rest.split_at(rest.find(['/', '?', '#']).unwrap_or(rest.len()));
    let host = host.to_ascii_lowercase();
    HOSTS.iter().any(|(h, paths)| (host == *h || host.ends_with(&format!(".{h}"))) && path.len() > 1 && paths.iter().any(|p| path.starts_with(p) || (*p == "/" && path.len() > 3)))
}


/// What an event's invitation says about its call.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingInfo {
    /// "zoom", "meet", "teams", "webex", "jitsi", "whereby", "facetime", "goto", "chime".
    pub service: String,
    /// The join link, in the browser.
    pub url: String,
    /// The same meeting in the service's own app, when it has a link scheme for it.
    pub app_url: Option<String>,
    /// The meeting ID people read out ("850 1234 5678").
    pub meeting_id: Option<String>,
    pub passcode: Option<String>,
    /// Phone numbers to join by, with the PIN dialed for you.
    pub dial_in: Vec<DialIn>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DialIn {
    /// As written: "+1 669 900 6833".
    pub number: String,
    /// "US (San Jose)", when the invitation says.
    pub label: Option<String>,
    /// A `tel:` link that dials the number, waits, then the meeting ID and PIN.
    pub tel: String,
}

/// A link a booking tool gives you to change the booking.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManageLink {
    /// "reschedule", "cancel", or "manage" (one page for both).
    pub action: String,
    /// "Calendly", "Cal.com", "SavvyCal", "Acuity", "Doodle".
    pub tool: String,
    pub url: String,
}

/// The service a meeting link belongs to.
pub fn service_of(url: &str) -> Option<&'static str> {
    let host = url.strip_prefix("https://")?.split(['/', '?', '#']).next()?.to_ascii_lowercase();
    let is = |h: &str| host == h || host.ends_with(&format!(".{h}"));
    Some(if is("zoom.us") || is("zoomgov.com") {
        "zoom"
    } else if is("meet.google.com") {
        "meet"
    } else if is("teams.microsoft.com") || is("teams.live.com") {
        "teams"
    } else if is("webex.com") {
        "webex"
    } else if is("meet.jit.si") {
        "jitsi"
    } else if is("whereby.com") {
        "whereby"
    } else if is("facetime.apple.com") {
        "facetime"
    } else if is("meet.goto.com") || is("gotomeeting.com") {
        "goto"
    } else if is("chime.aws") {
        "chime"
    } else {
        return None;
    })
}

fn query<'a>(url: &'a str, key: &str) -> Option<&'a str> {
    let q = url.split_once('?')?.1.split('#').next()?;
    q.split('&').find_map(|kv| kv.split_once('=').filter(|(k, _)| *k == key).map(|(_, v)| v))
}

/// Opens the meeting in the service's app. Only services whose apps register
/// a scheme for joining get one; the others' links already open their app.
pub fn app_link(url: &str) -> Option<String> {
    match service_of(url)? {
        "zoom" => {
            let rest = url.strip_prefix("https://")?;
            let host = rest.split('/').next()?;
            let id: String = rest.split_once("/j/")?.1.chars().take_while(char::is_ascii_digit).collect();
            if id.is_empty() {
                return None;
            }
            let pwd = query(url, "pwd").map(|p| format!("&pwd={p}")).unwrap_or_default();
            Some(format!("zoommtg://{host}/join?action=join&confno={id}{pwd}"))
        }
        // Teams' app takes its own path after the scheme.
        "teams" => url.strip_prefix("https://teams.microsoft.com").or_else(|| url.strip_prefix("https://teams.live.com")).map(|p| format!("msteams:{p}")),
        _ => None,
    }
}

/// The digits after a label like "Meeting ID:" on the same line.
fn after_label(text: &str, labels: &[&str]) -> Option<String> {
    for line in text.lines() {
        let lower = line.to_ascii_lowercase();
        for l in labels {
            if let Some(i) = lower.find(l) {
                // A label, not a word in a link: "Passcode: 123", never "?pwd=…".
                let after = line[i + l.len()..].trim_start();
                let Some(rest) = after.strip_prefix(':') else { continue };
                let rest = rest.trim_start_matches([' ', '\t', '#']);
                let value: String = rest.chars().take_while(|c| !c.is_whitespace() || c == &' ').collect::<String>().trim().to_string();
                let value = value.split("  ").next().unwrap_or("").trim().to_string();
                if !value.is_empty() && value.len() <= 40 {
                    return Some(value);
                }
            }
        }
    }
    None
}

/// "One tap" lines (`+16699006833,,85012345678#,,,,*123456# US (San Jose)`) and
/// "Join by phone +1 252-555-0142 PIN: 123 456 789#" lines.
fn dial_ins(text: &str) -> Vec<DialIn> {
    let mut out: Vec<DialIn> = Vec::new();
    // Under a heading like "Dial by your location", bare numbers count too.
    let mut phones = false;
    for line in text.lines() {
        let l = line.to_ascii_lowercase();
        if ["dial", "phone", "call in", "tap", "tel"].iter().any(|w| l.contains(w)) {
            phones = true;
        } else if l.trim().is_empty() || l.contains("://") {
            phones = phones && l.trim().is_empty();
        }
        let Some(plus) = line.find('+') else { continue };
        let tail = &line[plus..];
        let number: String = tail.chars().take_while(|c| c.is_ascii_digit() || " -().+".contains(*c)).collect::<String>().trim_end_matches([' ', '-', '(']).to_string();
        let digits: String = number.chars().filter(char::is_ascii_digit).collect();
        if !(8..=15).contains(&digits.len()) {
            continue;
        }
        let after = &tail[number.len()..];
        // The codes to dial after it: ",,123#,,,,*456#" right after the number, or a PIN/ID on the line.
        let codes = if after.starts_with(",,") {
            after.chars().take_while(|c| c.is_ascii_digit() || ",#*".contains(*c)).collect::<String>()
        } else if let Some(pin) = after_label(line, &["pin", "conference id", "meeting id", "access code"]) {
            let d: String = pin.chars().filter(|c| c.is_ascii_digit()).collect();
            if d.is_empty() { String::new() } else { format!(",,{d}#") }
        } else if phones {
            String::new()
        } else {
            continue;
        };
        let label = {
            let rest = after.trim_start_matches(|c: char| c.is_ascii_digit() || ",#*".contains(c)).trim();
            let rest = rest.trim_start_matches(['-', '–']).trim();
            (!rest.is_empty() && rest.len() <= 40 && !rest.to_ascii_lowercase().starts_with("pin") && rest.chars().any(char::is_alphabetic)).then(|| rest.to_string())
        };
        let tel = format!("tel:+{digits}{}", codes.replace('#', "%23"));
        if !out.iter().any(|d| d.tel == tel) {
            out.push(DialIn { number: number.trim().to_string(), label, tel });
        }
        if out.len() == 3 {
            break;
        }
    }
    out
}

/// Everything an event's texts say about its call, if it has one.
pub fn meeting_info<'a>(texts: impl IntoIterator<Item = &'a str> + Clone) -> Option<MeetingInfo> {
    let url = meeting_link(texts.clone())?;
    let service = service_of(&url)?.to_string();
    let all: String = texts.into_iter().collect::<Vec<_>>().join("\n");
    let meeting_id = after_label(&all, &["meeting id", "conference id", "meeting number", "access code"])
        .or_else(|| (service == "zoom").then(|| url.split_once("/j/").map(|(_, r)| r.chars().take_while(char::is_ascii_digit).collect::<String>())).flatten().filter(|d| d.len() >= 9).map(|d| group(&d)))
        .filter(|v| v.chars().any(|c| c.is_ascii_digit()));
    let passcode = after_label(&all, &["passcode", "password"]).filter(|p| !p.contains("://"));
    Some(MeetingInfo { app_url: app_link(&url), service, url, meeting_id, passcode, dial_in: dial_ins(&all) })
}

/// "85012345678" → "850 1234 5678", as Zoom prints it.
fn group(d: &str) -> String {
    match d.len() {
        9 => format!("{} {} {}", &d[..3], &d[3..6], &d[6..]),
        10 => format!("{} {} {}", &d[..3], &d[3..6], &d[6..]),
        11 => format!("{} {} {}", &d[..3], &d[3..7], &d[7..]),
        _ => d.to_string(),
    }
}

/// Reschedule and cancel links from booking tools, in the order they appear.
pub fn manage_links<'a>(texts: impl IntoIterator<Item = &'a str>) -> Vec<ManageLink> {
    let mut out: Vec<ManageLink> = Vec::new();
    for t in texts {
        for token in t.split(|c: char| c.is_whitespace() || "<>\"'()[]{}|".contains(c)) {
            let url = token.trim_end_matches(['.', ',', ';', ':', '!', '?']);
            let Some(rest) = url.strip_prefix("https://") else { continue };
            let (host, path) = rest.split_at(rest.find(['/', '?', '#']).unwrap_or(rest.len()));
            let host = host.to_ascii_lowercase();
            let path = path.to_ascii_lowercase();
            let is = |h: &str| host == h || host.ends_with(&format!(".{h}"));
            let found = if is("calendly.com") && path.starts_with("/reschedulings/") {
                Some(("reschedule", "Calendly"))
            } else if is("calendly.com") && path.starts_with("/cancellations/") {
                Some(("cancel", "Calendly"))
            } else if is("cal.com") && path.starts_with("/reschedule/") {
                Some(("reschedule", "Cal.com"))
            } else if is("cal.com") && path.starts_with("/booking/") {
                Some((if path.contains("cancel=true") { "cancel" } else { "manage" }, "Cal.com"))
            } else if is("savvycal.com") && (path.contains("/reschedule") || path.contains("/cancel") || path.contains("/manage")) {
                Some((if path.contains("cancel") { "cancel" } else if path.contains("reschedule") { "reschedule" } else { "manage" }, "SavvyCal"))
            } else if is("acuityscheduling.com") && (path.contains("action=") || path.contains("/appointments/")) {
                Some(("manage", "Acuity"))
            } else if is("doodle.com") && path.starts_with("/meeting/") {
                Some(("manage", "Doodle"))
            } else {
                None
            };
            if let Some((action, tool)) = found
                && !out.iter().any(|m| m.url == url)
            {
                out.push(ManageLink { action: action.into(), tool: tool.into(), url: url.into() });
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_meeting_links() {
        let one = |s: &str| meeting_link([s]);
        assert_eq!(one("https://us02web.zoom.us/j/123456789?pwd=abc"), Some("https://us02web.zoom.us/j/123456789?pwd=abc".into()));
        assert_eq!(one("Join: https://meet.google.com/abc-defg-hij."), Some("https://meet.google.com/abc-defg-hij".into()), "trailing period dropped");
        assert_eq!(
            one("Click <https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=%7b%7d> to join"),
            Some("https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=%7b%7d".into())
        );
        assert_eq!(one("https://acme.webex.com/meet/pat"), Some("https://acme.webex.com/meet/pat".into()));
        assert_eq!(one("Room 2, Studio"), None);
        assert_eq!(one("https://zoom.us/pricing"), None, "not a meeting page");
        assert_eq!(one("http://zoom.us/j/1"), None, "https only");
        assert_eq!(one("https://evil-zoom.us/j/1"), None, "look-alike host");
        assert_eq!(one("https://meet.google.com/"), None);
        assert_eq!(
            meeting_link(["Studio, room 2", "Maps: https://maps.example.com/x then https://meet.jit.si/design-crit"]),
            Some("https://meet.jit.si/design-crit".into()),
            "the first meeting link, after other links"
        );
    }

    const ZOOM: &str = "Priya is inviting you to a scheduled Zoom meeting.\n\nJoin Zoom Meeting\nhttps://us02web.zoom.us/j/85012345678?pwd=Ab12Cd\n\nMeeting ID: 850 1234 5678\nPasscode: 123456\n\n---\n\nOne tap mobile\n+16699006833,,85012345678#,,,,*123456# US (San Jose)\n+12532158782,,85012345678#,,,,*123456# US (Tacoma)\n\nDial by your location\n• +1 669 900 6833 US (San Jose)";

    #[test]
    fn reads_a_zoom_invitation() {
        let m = meeting_info(["Zoom", ZOOM]).unwrap();
        assert_eq!(m.service, "zoom");
        assert_eq!(m.url, "https://us02web.zoom.us/j/85012345678?pwd=Ab12Cd");
        assert_eq!(m.app_url.as_deref(), Some("zoommtg://us02web.zoom.us/join?action=join&confno=85012345678&pwd=Ab12Cd"));
        assert_eq!(m.meeting_id.as_deref(), Some("850 1234 5678"));
        assert_eq!(m.passcode.as_deref(), Some("123456"));
        assert_eq!(m.dial_in.len(), 3);
        assert_eq!(m.dial_in[0].tel, "tel:+16699006833,,85012345678%23,,,,*123456%23", "dials the meeting and passcode for you");
        assert_eq!(m.dial_in[0].label.as_deref(), Some("US (San Jose)"));
        assert_eq!(m.dial_in[2].number, "+1 669 900 6833", "a plain number, as written");
        // A link alone: the ID comes from the link.
        let bare = meeting_info(["https://zoom.us/j/987654321"]).unwrap();
        assert_eq!(bare.meeting_id.as_deref(), Some("987 654 321"));
        assert_eq!(bare.passcode, None);
        assert!(bare.dial_in.is_empty());
    }

    #[test]
    fn reads_teams_and_meet_invitations() {
        let teams = "Microsoft Teams meeting\nJoin on your computer, mobile app or room device\nClick here to join the meeting <https://teams.microsoft.com/l/meetup-join/19%3ameeting_Y2Fs%40thread.v2/0?context=%7b%22Tid%22%3a%22x%22%7d>\nMeeting ID: 245 123 456 789\nPasscode: aB3cD4\nOr call in (audio only)\n+1 323-555-0100,,123456789#   United States, Los Angeles\nPhone Conference ID: 123 456 789#";
        let m = meeting_info([teams]).unwrap();
        assert_eq!(m.service, "teams");
        assert_eq!(m.app_url.as_deref(), Some("msteams:/l/meetup-join/19%3ameeting_Y2Fs%40thread.v2/0?context=%7b%22Tid%22%3a%22x%22%7d"));
        assert_eq!(m.meeting_id.as_deref(), Some("245 123 456 789"));
        assert_eq!(m.passcode.as_deref(), Some("aB3cD4"));
        assert_eq!(m.dial_in[0].tel, "tel:+13235550100,,123456789%23");
        assert_eq!(m.dial_in[0].label.as_deref(), Some("United States, Los Angeles"));

        let meet = "Join with Google Meet\nhttps://meet.google.com/abc-defg-hij\nJoin by phone\n(US) +1 252-555-0142 PIN: 123 456 789#\nMore phone numbers: https://tel.meet/abc-defg-hij?pin=123";
        let g = meeting_info([meet]).unwrap();
        assert_eq!((g.service.as_str(), g.app_url.as_deref()), ("meet", None), "Meet has no app link: the browser it is");
        assert_eq!(g.dial_in[0].tel, "tel:+12525550142,,123456789%23", "the PIN is dialed after a pause");
        assert_eq!(meeting_info(["Lunch at the café"]), None);
        assert_eq!(service_of("https://meet.goto.com/123456789"), Some("goto"));
        assert_eq!(app_link("https://meet.jit.si/design-crit"), None);
    }

    #[test]
    fn booking_tools_give_reschedule_and_cancel_links() {
        let calendly = "Event Name: 30 Minute Meeting\n\nNeed to make changes to this event?\nCancel: https://calendly.com/cancellations/AAAA-1111\nReschedule: https://calendly.com/reschedulings/AAAA-1111\n\nPowered by Calendly.com";
        let links = manage_links([calendly]);
        assert_eq!(
            links.iter().map(|l| (l.action.as_str(), l.tool.as_str())).collect::<Vec<_>>(),
            [("cancel", "Calendly"), ("reschedule", "Calendly")]
        );
        assert_eq!(links[1].url, "https://calendly.com/reschedulings/AAAA-1111");
        let cal = manage_links(["Need to reschedule or cancel? https://app.cal.com/booking/uid123?changes=true", "https://cal.com/reschedule/uid123"]);
        assert_eq!(cal.iter().map(|l| l.action.as_str()).collect::<Vec<_>>(), ["manage", "reschedule"]);
        assert!(manage_links(["https://calendly.com/priya/30min", "https://evilcalendly.com/cancellations/x"]).is_empty(), "a booking page or a look-alike isn't a manage link");

        // Only call links (and booking tools' manage links) may be opened by the system.
        assert!(openable("zoommtg://us02web.zoom.us/join?action=join&confno=1").is_ok());
        assert!(openable("https://calendly.com/reschedulings/AAAA").is_ok());
        assert!(openable("https://meet.google.com/abc-defg-hij").is_ok());
        for bad in ["file:///etc/passwd", "javascript:alert(1)", "https://example.com/j/1", "slack://open", "msteams:"] {
            assert!(openable(bad).is_err(), "{bad}");
        }

        let s = Store::open_in_memory().unwrap();
        assert!(s.meeting_prefs().unwrap().open_in_apps, "apps by default");
        s.set_meeting_prefs(&MeetingPrefs { open_in_apps: false }).unwrap();
        assert!(!s.meeting_prefs().unwrap().open_in_apps);
    }
}
