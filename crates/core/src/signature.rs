//! Reading a contact out of an email signature (Cardhop-style): a pasted
//! block of text, or the end of a message.
//!
//! Signatures have no format, so this is a heuristic that aims to be right
//! on the common shapes and to leave a field empty rather than guess wrong:
//!
//! ```text
//! Best,
//! Priya Raman
//! Design systems lead | Studio
//! m: +1 555 010 4410 · priya@studio.example
//! ```
//!
//! The result is a suggestion: it always opens in the contact editor first.

use serde::{Deserialize, Serialize};

use crate::model::ContactField;

/// What a signature says about its writer. Empty fields weren't found.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignatureCard {
    pub full_name: String,
    pub org: Option<String>,
    pub title: Option<String>,
    pub emails: Vec<ContactField>,
    pub phones: Vec<ContactField>,
}

impl SignatureCard {
    /// Nothing worth a contact: no way to reach them and no role.
    pub fn is_empty(&self) -> bool {
        self.emails.is_empty() && self.phones.is_empty() && self.org.is_none() && self.title.is_none()
    }
}

/// Words that end a message before the signature.
const SIGN_OFFS: &[&str] = &[
    "best",
    "best regards",
    "best wishes",
    "kind regards",
    "regards",
    "warm regards",
    "warmly",
    "thanks",
    "thank you",
    "many thanks",
    "cheers",
    "sincerely",
    "yours",
    "all the best",
    "talk soon",
    "take care",
    "thx",
];

/// Words that make a lone line a job title rather than a company.
const TITLE_WORDS: &[&str] = &[
    "manager",
    "lead",
    "director",
    "engineer",
    "designer",
    "founder",
    "co-founder",
    "ceo",
    "cto",
    "cfo",
    "coo",
    "head",
    "vp",
    "president",
    "officer",
    "consultant",
    "developer",
    "partner",
    "analyst",
    "specialist",
    "coordinator",
    "owner",
    "associate",
    "principal",
    "architect",
    "producer",
    "editor",
    "writer",
    "researcher",
    "scientist",
    "professor",
    "student",
    "intern",
    "assistant",
    "advisor",
    "strategist",
    "administrator",
    "recruiter",
    "attorney",
    "counsel",
    "nurse",
    "doctor",
];

/// The signature lines at the end of a message body: after a `-- ` line if
/// there is one, else after the sign-off, else the last short paragraph.
/// Quoted replies and forwarded headers are cut off first.
pub fn signature_lines(body: &str) -> Vec<String> {
    block(body).0
}

/// The lines, and whether a delimiter or sign-off marked them (rather than
/// just being the last paragraph).
fn block(body: &str) -> (Vec<String>, bool) {
    let mut lines: Vec<&str> = Vec::new();
    for line in body.lines() {
        let t = line.trim();
        // The reply's own text ends where the quote begins.
        if t.starts_with('>') || t.starts_with("-----Original Message") || (t.starts_with("On ") && t.ends_with("wrote:")) || t.starts_with("---------- Forwarded") {
            break;
        }
        lines.push(line.trim_end());
    }
    while lines.last().is_some_and(|l| l.trim().is_empty()) {
        lines.pop();
    }
    let tail = |from: usize| lines[from..].iter().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).take(10).collect::<Vec<_>>();
    if let Some(i) = lines.iter().rposition(|l| *l == "-- " || l.trim() == "--") {
        return (tail(i + 1), true);
    }
    if let Some(i) = lines.iter().rposition(|l| is_sign_off(l)) {
        return (tail(i + 1), true);
    }
    // The last paragraph, if it's short enough to be a signature.
    let start = lines.iter().rposition(|l| l.trim().is_empty()).map_or(0, |i| i + 1);
    let last = tail(start);
    if !last.is_empty() && last.len() <= 6 && start > 0 { (last, false) } else { (vec![], false) }
}

fn is_sign_off(line: &str) -> bool {
    let t = line.trim().trim_end_matches([',', '!', '.']).trim_start_matches(['—', '–', '-', ' ']).to_lowercase();
    SIGN_OFFS.contains(&t.as_str())
}

/// Parses signature lines. `sender` is the From name, which pins the name
/// line when it appears.
pub fn parse_signature(text: &str, sender: Option<&str>) -> SignatureCard {
    let mut card = SignatureCard::default();
    let mut rest: Vec<String> = Vec::new();
    let sender = sender.map(str::trim).filter(|s| !s.is_empty() && !s.contains('@'));
    for raw in text.lines() {
        let line = raw.trim().trim_start_matches(['—', '–', '-', '*', ' ']).trim();
        if line.is_empty() || is_sign_off(line) {
            continue;
        }
        // "m: +1 555 0100 · priya@studio.example" holds two fields.
        let mut leftover = Vec::new();
        for part in line.split(['|', '·', '•', '\u{2022}']).map(str::trim).filter(|p| !p.is_empty()) {
            if let Some(email) = email_in(part) {
                if !card.emails.iter().any(|e| e.value.eq_ignore_ascii_case(&email)) {
                    card.emails.push(ContactField { label: None, value: email });
                }
            } else if let Some(phone) = phone_in(part) {
                if !card.phones.iter().any(|p| digits(&p.value) == digits(&phone.value)) {
                    card.phones.push(phone);
                }
            } else if !is_link(part) && !part.chars().any(|c| c.is_ascii_digit()) {
                // Lines with digits left over are addresses or legal text.
                leftover.push(part.to_string());
            }
        }
        if !leftover.is_empty() {
            rest.push(leftover.join(" | "));
        }
    }

    // The name: the sender's, if a line says it; otherwise the first line
    // that reads like a person's name.
    // A line with just the sender's first name ("Ana") is them signing off.
    let first = sender.and_then(|s| s.split_whitespace().next());
    let at = rest
        .iter()
        .position(|l| sender.is_some_and(|s| l.eq_ignore_ascii_case(s)) || first.is_some_and(|f| l.eq_ignore_ascii_case(f)))
        .or_else(|| rest.iter().position(|l| looks_like_name(l)))
        .filter(|&i| i < 3);
    match at {
        Some(i) => {
            let line = rest.remove(i);
            card.full_name = if line.contains(' ') { line } else { sender.unwrap_or(&line).to_string() };
            // Role lines come right after the name.
            rest.drain(..i);
        }
        None => card.full_name = sender.unwrap_or_default().to_string(),
    }
    let role: Vec<String> = rest.into_iter().take(2).collect();
    match role.as_slice() {
        [] => {}
        [one] => match split_role(one) {
            Some((t, o)) => (card.title, card.org) = (Some(t), Some(o)),
            None if is_title(one) => card.title = Some(one.clone()),
            None => card.org = Some(one.clone()),
        },
        [a, b, ..] => match split_role(a) {
            Some((t, o)) => (card.title, card.org) = (Some(t), Some(o)),
            None => (card.title, card.org) = (Some(a.clone()), Some(b.clone())),
        },
    }
    card
}

/// A signature from the end of a message, or None if it has nothing useful.
pub fn from_message(body: &str, sender: Option<&str>) -> Option<SignatureCard> {
    let (lines, marked) = block(body);
    if lines.is_empty() {
        return None;
    }
    // An unmarked last paragraph counts only if it has a way to reach them.
    Some(parse_signature(&lines.join("\n"), sender)).filter(|c| !c.is_empty() && (marked || !c.emails.is_empty() || !c.phones.is_empty()))
}

/// "Lead, Studio", "Lead | Studio", "Lead at Studio", "Lead @ Studio", "Lead — Studio".
fn split_role(line: &str) -> Option<(String, String)> {
    for sep in [" | ", " at ", " @ ", " — ", " – ", " - ", ", "] {
        if let Some((a, b)) = line.split_once(sep) {
            let (a, b) = (a.trim(), b.trim());
            if !a.is_empty() && !b.is_empty() {
                return Some((a.to_string(), b.to_string()));
            }
        }
    }
    None
}

fn is_title(line: &str) -> bool {
    line.to_lowercase().split(|c: char| !c.is_alphanumeric() && c != '-').any(|w| TITLE_WORDS.contains(&w))
}

fn looks_like_name(line: &str) -> bool {
    let words: Vec<&str> = line.split_whitespace().collect();
    (2..=4).contains(&words.len())
        && line.len() <= 40
        && !is_title(line)
        && words.iter().all(|w| w.chars().next().is_some_and(char::is_uppercase) && w.chars().all(|c| c.is_alphabetic() || "'’.-".contains(c)))
}

fn is_link(s: &str) -> bool {
    let l = s.to_lowercase();
    l.starts_with("http://") || l.starts_with("https://") || l.starts_with("www.") || l.contains(".com/") || l.starts_with("linkedin.")
}

fn email_in(s: &str) -> Option<String> {
    s.split(|c: char| c.is_whitespace() || "<>()[],;:".contains(c))
        .map(|t| t.trim_matches(['.', '"', '\'']))
        .find(|t| {
            let Some((user, host)) = t.split_once('@') else { return false };
            !user.is_empty() && host.contains('.') && !host.starts_with('.') && !host.ends_with('.') && !t.contains("..")
        })
        .map(str::to_lowercase)
}

fn digits(s: &str) -> String {
    s.chars().filter(char::is_ascii_digit).collect()
}

/// A phone number, with a label from its prefix ("m:", "Mobile", "Office").
/// Fax numbers are left out: nobody calls them.
fn phone_in(s: &str) -> Option<ContactField> {
    let keyed = s.split_once([':', '.']).filter(|(k, _)| k.len() <= 8 && k.chars().all(|c| c.is_alphabetic() || c == ' '));
    let (label, number) = match keyed {
        Some((k, n)) => (k.trim().to_lowercase(), n.trim()),
        None => match s.split_once(' ').filter(|(k, _)| matches!(k.to_lowercase().as_str(), "mobile" | "cell" | "office" | "work" | "tel" | "phone" | "direct" | "fax")) {
            Some((k, n)) => (k.to_lowercase(), n.trim()),
            None => (String::new(), s.trim()),
        },
    };
    if label == "fax" || label == "f" {
        return None;
    }
    let d = digits(number);
    let shape = number.chars().all(|c| c.is_ascii_digit() || " +()-./x".contains(c) || c.is_whitespace()) || number.to_lowercase().contains("ext");
    if !(7..=15).contains(&d.len()) || !shape {
        return None;
    }
    let label = match label.as_str() {
        "m" | "mob" | "mobile" | "cell" | "c" => Some("cell"),
        "o" | "office" | "w" | "work" | "d" | "direct" | "t" | "tel" | "phone" | "p" | "ph" => Some("work"),
        "h" | "home" => Some("home"),
        _ => None,
    };
    Some(ContactField { label: label.map(str::to_string), value: number.to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field(label: Option<&str>, value: &str) -> ContactField {
        ContactField { label: label.map(str::to_string), value: value.into() }
    }

    #[test]
    fn a_typical_signature() {
        let body =
            "Hi!\n\nCan we move the review to Thursday?\n\nBest,\nPriya Raman\nDesign systems lead | Studio\nm: +1 555 010 4410 · priya@studio.example\nwww.studio.example\n";
        let c = from_message(body, Some("Priya Raman")).unwrap();
        assert_eq!(c.full_name, "Priya Raman");
        assert_eq!(c.title.as_deref(), Some("Design systems lead"));
        assert_eq!(c.org.as_deref(), Some("Studio"));
        assert_eq!(c.phones, vec![field(Some("cell"), "+1 555 010 4410")]);
        assert_eq!(c.emails, vec![field(None, "priya@studio.example")]);
    }

    #[test]
    fn the_dash_dash_delimiter_and_two_role_lines() {
        let body = "Thanks for the quick reply.\n\n-- \nSam Okafor\nSenior Engineer\nLighthouse Labs\nOffice: (555) 010-2200\nFax: (555) 010-2201\n1 Harbour St, Porto\n";
        let c = from_message(body, None).unwrap();
        assert_eq!(c.full_name, "Sam Okafor");
        assert_eq!((c.title.as_deref(), c.org.as_deref()), (Some("Senior Engineer"), Some("Lighthouse Labs")));
        assert_eq!(c.phones, vec![field(Some("work"), "(555) 010-2200")], "fax and the street address are left out");
    }

    #[test]
    fn quoted_replies_are_not_the_signature() {
        let body = "Sounds good.\n\nAna\n\nOn Tue, 13 Oct 2026, Priya Raman wrote:\n> Best,\n> Priya Raman\n> m: +1 555 010 4410\n";
        assert_eq!(from_message(body, Some("Ana Duarte")), None, "the quoted signature is Priya's, not Ana's");
    }

    #[test]
    fn pasted_text_and_a_lone_role_line() {
        let c = parse_signature("Lena Fischer\nFounder\n+49 30 1234567\nlena@example.de", None);
        assert_eq!(c.full_name, "Lena Fischer");
        assert_eq!((c.title.as_deref(), c.org), (Some("Founder"), None), "a title word makes it a title");
        assert_eq!(c.phones, vec![field(None, "+49 30 1234567")]);
        let c = parse_signature("Diego Alvarez\nCasa Azul Ceramics\nCell 55 1234 5678", None);
        assert_eq!((c.title, c.org.as_deref()), (None, Some("Casa Azul Ceramics")));
        assert_eq!(c.phones, vec![field(Some("cell"), "55 1234 5678")]);
        let c = parse_signature("Marcus Lee\nProduct Designer at Northwind", None);
        assert_eq!((c.title.as_deref(), c.org.as_deref()), (Some("Product Designer"), Some("Northwind")));
        let c = parse_signature("Product Designer\n+1 555 010 7781", None);
        assert_eq!(c.full_name, "", "no name line: left empty, not guessed");
    }

    #[test]
    fn nothing_useful_is_none() {
        assert_eq!(from_message("See you then!\n\nAna", Some("Ana")), None);
        assert_eq!(from_message("", None), None);
        assert!(parse_signature("Order #4412 shipped on 12 Oct", None).is_empty(), "digits alone aren't a phone");
    }
}
