//! Finding the video-call link in an event: Zoom, Google Meet, Microsoft
//! Teams, Webex, Jitsi, Whereby, FaceTime. Invitations put it in the
//! location, the URL, or the description, often among other links (maps,
//! dial-in help), so only known meeting hosts count.

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

#[cfg(test)]
mod tests {
    use super::meeting_link;

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
}
