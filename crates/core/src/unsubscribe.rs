//! Reading a message's unsubscribe options (RFC 2369 `List-Unsubscribe`,
//! RFC 8058 one-click).
//!
//! `List-Unsubscribe` lists addresses in angle brackets, in the sender's order
//! of preference: `<mailto:leave@list.example?subject=unsubscribe>,
//! <https://list.example/u/abc>`. When the message also says
//! `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, its https address
//! unsubscribes with a single POST, with no page to visit. Only that case is
//! safe to do without the browser, so only https qualifies (RFC 8058 §3.1).

use crate::Unsubscribe;

/// The unsubscribe options in a raw message's headers, if it has any.
pub fn from_raw(raw: &[u8]) -> Option<Unsubscribe> {
    let headers = header_block(raw);
    let list = header(&headers, "list-unsubscribe")?;
    let one_click = header(&headers, "list-unsubscribe-post").is_some_and(|v| v.replace(' ', "").eq_ignore_ascii_case("List-Unsubscribe=One-Click"));
    let mut found = Unsubscribe::default();
    for uri in bracketed(&list) {
        let lower = uri.to_ascii_lowercase();
        if lower.starts_with("mailto:") {
            found.mailto.get_or_insert(uri);
        } else if lower.starts_with("https://") {
            if one_click && found.one_click.is_none() {
                found.one_click = Some(uri.clone());
            }
            found.web.get_or_insert(uri);
        } else if lower.starts_with("http://") {
            found.web.get_or_insert(uri);
        }
    }
    (found.one_click.is_some() || found.mailto.is_some() || found.web.is_some()).then_some(found)
}

/// A `mailto:` unsubscribe address, split into recipient, subject, and body.
pub fn parse_mailto(uri: &str) -> Option<(String, String, String)> {
    let rest = uri.get(7..).filter(|_| uri[..7].eq_ignore_ascii_case("mailto:"))?;
    let (to, query) = rest.split_once('?').unwrap_or((rest, ""));
    let to = percent_decode(to);
    if !to.contains('@') || to.contains(',') {
        return None;
    }
    let (mut subject, mut body) = ("unsubscribe".to_string(), "unsubscribe".to_string());
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        match k.to_ascii_lowercase().as_str() {
            "subject" if !v.is_empty() => subject = percent_decode(v),
            "body" if !v.is_empty() => body = percent_decode(v),
            _ => {}
        }
    }
    Some((to, subject, body))
}

/// The header block, unfolded: continuation lines join the line above.
fn header_block(raw: &[u8]) -> Vec<(String, String)> {
    let text = String::from_utf8_lossy(raw);
    let mut out: Vec<(String, String)> = Vec::new();
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.is_empty() {
            break;
        }
        if line.starts_with([' ', '\t']) {
            if let Some((_, v)) = out.last_mut() {
                v.push(' ');
                v.push_str(line.trim());
            }
        } else if let Some((k, v)) = line.split_once(':') {
            out.push((k.trim().to_ascii_lowercase(), v.trim().to_string()));
        }
    }
    out
}

fn header(headers: &[(String, String)], name: &str) -> Option<String> {
    headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone())
}

/// The `<…>` entries of a header value, in order.
fn bracketed(value: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = value;
    while let Some(start) = rest.find('<') {
        let Some(len) = rest[start + 1..].find('>') else { break };
        let uri: String = rest[start + 1..start + 1 + len].chars().filter(|c| !c.is_whitespace()).collect();
        if !uri.is_empty() {
            out.push(uri);
        }
        rest = &rest[start + 1 + len + 1..];
    }
    out
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let Some(b) = s.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            out.push(b);
            i += 3;
            continue;
        }
        out.push(if bytes[i] == b'+' { b' ' } else { bytes[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(headers: &str) -> Vec<u8> {
        format!("From: news@list.example\r\n{headers}Subject: Hi\r\n\r\nList-Unsubscribe: <https://not-a-header.example>\r\n").into_bytes()
    }

    #[test]
    fn one_click_needs_the_post_header_and_https() {
        let u =
            from_raw(&raw("List-Unsubscribe: <mailto:leave@list.example?subject=bye>,\r\n <https://list.example/u/abc>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n"))
                .unwrap();
        assert_eq!(u.one_click.as_deref(), Some("https://list.example/u/abc"));
        assert_eq!(u.mailto.as_deref(), Some("mailto:leave@list.example?subject=bye"));
        assert_eq!(u.web.as_deref(), Some("https://list.example/u/abc"));

        let no_post = from_raw(&raw("List-Unsubscribe: <https://list.example/u/abc>\r\n")).unwrap();
        assert_eq!(no_post.one_click, None, "without List-Unsubscribe-Post it's a page to visit");
        assert_eq!(no_post.web.as_deref(), Some("https://list.example/u/abc"));

        let http = from_raw(&raw("List-Unsubscribe: <http://list.example/u>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n")).unwrap();
        assert_eq!(http.one_click, None, "one-click is https only");
    }

    #[test]
    fn only_the_header_block_counts() {
        assert_eq!(from_raw(&raw("")), None, "a body line that looks like a header is ignored");
        assert_eq!(from_raw(&raw("List-Unsubscribe: <ftp://x>\r\n")), None);
    }

    #[test]
    fn mailto_parts() {
        assert_eq!(
            parse_mailto("mailto:leave%2Bme@list.example?subject=Please%20remove&body=id+42"),
            Some(("leave+me@list.example".into(), "Please remove".into(), "id 42".into()))
        );
        assert_eq!(parse_mailto("MAILTO:a@b.example"), Some(("a@b.example".into(), "unsubscribe".into(), "unsubscribe".into())));
        assert_eq!(parse_mailto("mailto:a@b.example,c@d.example"), None, "one recipient only");
        assert_eq!(parse_mailto("https://x"), None);
    }
}
