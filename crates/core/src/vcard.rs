//! vCard (RFC 6350, and 3.0 for iCloud) contacts: reading, writing, merging.
//!
//! Like events, edits splice the fields we model into the parsed original,
//! so addresses, related people, and unknown X- properties survive.

use calcard::common::IanaString;
use calcard::vcard::{VCard, VCardEntry, VCardParameterName, VCardParameterValue, VCardProperty, VCardValue};

use crate::model::{ContactField, ContactInput};
use crate::{Error, Result};

/// Photos above this stay on the server copy but aren't shown (keeps lists light).
const PHOTO_LIMIT: usize = 150 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ContactMeta {
    pub uid: String,
    pub full_name: String,
    pub given: Option<String>,
    pub family: Option<String>,
    pub emails: Vec<ContactField>,
    pub phones: Vec<ContactField>,
    pub org: Option<String>,
    pub title: Option<String>,
    pub note: Option<String>,
    /// "YYYY-MM-DD", or "--MM-DD" when the year is unknown.
    pub birthday: Option<String>,
    /// A `data:` URL, only for embedded photos.
    pub photo: Option<String>,
    /// CATEGORIES, trimmed and without duplicates.
    pub labels: Vec<String>,
}

fn parse(vcf: &str) -> Result<VCard> {
    VCard::parse(vcf).map_err(|_| Error::Parse("not a valid vCard".into()))
}

fn first_text(e: &VCardEntry) -> Option<String> {
    e.values.iter().find_map(|v| v.as_text()).map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned)
}

fn label(e: &VCardEntry) -> Option<String> {
    e.parameters(&VCardParameterName::Type)
        .filter_map(|v| match v {
            VCardParameterValue::Type(t) => Some(t.as_str().to_ascii_lowercase()),
            VCardParameterValue::Text(s) => Some(s.to_ascii_lowercase()),
            _ => None,
        })
        // Transport and preference markers aren't labels people care about.
        .find(|t| !matches!(t.as_str(), "internet" | "pref" | "voice" | "x400"))
}

fn fields(card: &VCard, prop: VCardProperty) -> Vec<ContactField> {
    card.properties(&prop)
        .filter_map(|e| {
            let value = first_text(e)?;
            let value = value.strip_prefix("tel:").or_else(|| value.strip_prefix("mailto:")).unwrap_or(&value).to_string();
            Some(ContactField { label: label(e), value })
        })
        .collect()
}

fn text(card: &VCard, prop: VCardProperty) -> Option<String> {
    card.property(&prop).and_then(first_text)
}

fn photo(card: &VCard) -> Option<String> {
    let e = card.property(&VCardProperty::Photo)?;
    match e.values.first()? {
        VCardValue::Binary(d) if d.data.len() <= PHOTO_LIMIT => {
            use base64::Engine;
            let mime = d.content_type.clone().unwrap_or_else(|| "image/jpeg".into());
            Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&d.data)))
        }
        // Remote photo URLs are never fetched: they'd tell the host when you look.
        VCardValue::Text(t) if t.starts_with("data:image/") && t.len() <= PHOTO_LIMIT * 4 / 3 + 64 => Some(t.clone()),
        _ => None,
    }
}

fn birthday(card: &VCard) -> Option<String> {
    let e = card.property(&VCardProperty::Bday)?;
    match e.values.first()? {
        VCardValue::PartialDateTime(d) => match (d.year, d.month, d.day) {
            (Some(y), Some(m), Some(day)) => Some(format!("{y:04}-{m:02}-{day:02}")),
            (None, Some(m), Some(day)) => Some(format!("--{m:02}-{day:02}")),
            _ => None,
        },
        VCardValue::Text(t) => Some(t.clone()),
        _ => None,
    }
}

/// `BDAY` read from the raw line, for forms the parser drops: calcard writes
/// a year-less birthday as `--07-02` but doesn't read that back.
fn bday_line(vcf: &str) -> Option<String> {
    let line = vcf.lines().find(|l| l.len() > 4 && l[..4].eq_ignore_ascii_case("BDAY") && l[4..].starts_with([':', ';']))?;
    let value = line.rsplit(':').next()?.trim();
    let digits: String = value.chars().filter(char::is_ascii_digit).collect();
    match (value.starts_with("--"), digits.len()) {
        (true, 4) => Some(format!("--{}-{}", &digits[..2], &digits[2..])),
        (false, 8) => Some(format!("{}-{}-{}", &digits[..4], &digits[4..6], &digits[6..])),
        _ => None,
    }
}

/// CATEGORIES across every such line ("work,clay club"), without repeats.
fn labels(card: &VCard) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for e in card.properties(&VCardProperty::Categories) {
        for v in e.values.iter().filter_map(|v| v.as_text()) {
            for l in v.split(',').map(str::trim).filter(|l| !l.is_empty()) {
                if !out.iter().any(|o| o.eq_ignore_ascii_case(l)) {
                    out.push(l.to_string());
                }
            }
        }
    }
    out
}

/// Labels as the user typed them: trimmed, no empties, no case-insensitive repeats.
pub fn clean_labels(list: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for l in list.iter().map(|l| l.trim().replace(',', " ")).filter(|l| !l.is_empty()) {
        if !out.iter().any(|o| o.eq_ignore_ascii_case(&l)) {
            out.push(l);
        }
    }
    out
}

pub fn read_contact(vcf: &str) -> Result<ContactMeta> {
    let card = parse(vcf)?;
    let n = card.property(&VCardProperty::N);
    let part = |i: usize| -> Option<String> {
        let e = n?;
        // N is structured: Family;Given;Additional;Prefix;Suffix.
        let v = match e.values.first() {
            Some(VCardValue::Component(parts)) => parts.get(i).cloned(),
            _ => e.values.get(i).and_then(|v| v.as_text()).map(str::to_owned),
        };
        v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
    };
    let (given, family) = (part(1), part(0));
    let emails = fields(&card, VCardProperty::Email);
    let org = text(&card, VCardProperty::Org).map(|o| o.trim_end_matches(';').to_string());
    let full_name = text(&card, VCardProperty::Fn)
        .or_else(|| [given.clone(), family.clone()].into_iter().flatten().reduce(|a, b| format!("{a} {b}")))
        .or_else(|| org.clone())
        .or_else(|| emails.first().map(|e| e.value.clone()))
        .unwrap_or_default();
    Ok(ContactMeta {
        uid: card.uid().unwrap_or_default().to_string(),
        full_name,
        given,
        family,
        emails,
        phones: fields(&card, VCardProperty::Tel),
        org,
        title: text(&card, VCardProperty::Title),
        note: text(&card, VCardProperty::Note),
        birthday: birthday(&card).or_else(|| bday_line(vcf)),
        photo: photo(&card),
        labels: labels(&card),
    })
}

// ── Writing ──────────────────────────────────────────────────────────────────

fn esc(s: &str) -> String {
    s.trim().replace('\\', "\\\\").replace(';', "\\;").replace(',', "\\,").replace("\r\n", "\\n").replace('\n', "\\n")
}

/// "Ana María Duarte" → ("Duarte", "Ana María"): good enough for sorting;
/// people who care set N in a full editor.
fn split_name(full: &str) -> (String, String) {
    let full = full.trim();
    match full.rsplit_once(' ') {
        Some((given, family)) => (family.to_string(), given.to_string()),
        None => (String::new(), full.to_string()),
    }
}

fn field_line(prop: &str, f: &ContactField) -> Option<String> {
    let value = f.value.trim();
    if value.is_empty() {
        return None;
    }
    let label = f.label.as_deref().map(str::trim).filter(|l| !l.is_empty() && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
    Some(match label {
        Some(l) => format!("{prop};TYPE={}:{}", l.to_ascii_uppercase(), esc(value)),
        None => format!("{prop}:{}", esc(value)),
    })
}

fn input_lines(input: &ContactInput) -> Result<Vec<String>> {
    let name = input.full_name.trim();
    if name.is_empty() && input.emails.iter().all(|e| e.value.trim().is_empty()) && input.org.as_deref().is_none_or(|o| o.trim().is_empty()) {
        return Err(Error::Invalid("give the contact a name, an email, or a company".into()));
    }
    let (family, given) = split_name(name);
    let mut lines = vec![format!("FN:{}", esc(name)), format!("N:{};{};;;", esc(&family), esc(&given))];
    lines.extend(input.emails.iter().filter_map(|f| field_line("EMAIL", f)));
    lines.extend(input.phones.iter().filter_map(|f| field_line("TEL", f)));
    for (prop, v) in [("ORG", &input.org), ("TITLE", &input.title), ("NOTE", &input.note)] {
        if let Some(v) = v.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
            lines.push(format!("{prop}:{}", esc(v)));
        }
    }
    if let Some(list) = &input.labels {
        let list = clean_labels(list);
        if !list.is_empty() {
            // One CATEGORIES line, commas between (each label's own commas are gone).
            lines.push(format!("CATEGORIES:{}", list.iter().map(|l| esc(l)).collect::<Vec<_>>().join(",")));
        }
    }
    if let Some(b) = input.birthday.as_deref().map(str::trim).filter(|b| !b.is_empty()) {
        let digits: String = b.chars().filter(char::is_ascii_digit).collect();
        match (b.starts_with("--"), digits.len()) {
            (true, 4) => lines.push(format!("BDAY:--{digits}")),
            (false, 8) => lines.push(format!("BDAY:{digits}")),
            _ => return Err(Error::Invalid(format!("“{b}” isn't a date"))),
        }
    }
    Ok(lines)
}

fn card_entries(version: &str, lines: &[String]) -> Result<Vec<VCardEntry>> {
    let body: String = lines.iter().map(|l| format!("{l}\r\n")).collect();
    Ok(parse(&format!("BEGIN:VCARD\r\nVERSION:{version}\r\n{body}END:VCARD\r\n"))?.entries)
}

fn crlf(s: String) -> String {
    s.replace("\r\n", "\n").replace('\n', "\r\n")
}

/// A PHOTO line for a `data:image/…;base64,` URL: inline binary for vCard
/// 3.0 (what most servers and phones read), the data URI itself for 4.0.
/// None for an empty string (no photo). Only JPEG, PNG, and WebP, and only
/// up to the size lists show, so cards stay light to sync.
fn photo_line(version: &str, url: &str) -> Result<Option<String>> {
    let url = url.trim();
    if url.is_empty() {
        return Ok(None);
    }
    let bad = || Error::Invalid("that photo isn't a JPEG, PNG, or WebP image".into());
    let rest = url.strip_prefix("data:").ok_or_else(bad)?;
    let (mime, data) = rest.split_once(";base64,").ok_or_else(bad)?;
    let kind = match mime {
        "image/jpeg" => "JPEG",
        "image/png" => "PNG",
        "image/webp" => "WEBP",
        _ => return Err(bad()),
    };
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|_| bad())?;
    if bytes.len() > PHOTO_LIMIT {
        return Err(Error::Invalid("that photo is too large; pick a smaller one".into()));
    }
    Ok(Some(if version == "4.0" { format!("PHOTO:{url}") } else { format!("PHOTO;ENCODING=b;TYPE={kind}:{data}") }))
}

/// A new vCard 3.0, the version every CardDAV server (iCloud included) accepts.
pub fn new_contact(uid: &str, input: &ContactInput) -> Result<String> {
    let mut lines = vec![format!("UID:{uid}"), "PRODID:-//Mailbird//EN".to_string()];
    lines.extend(input_lines(input)?);
    if let Some(l) = input.photo.as_deref().map(|p| photo_line("3.0", p)).transpose()?.flatten() {
        lines.push(l);
    }
    let body: String = lines.iter().map(|l| format!("{l}\r\n")).collect();
    Ok(crlf(parse(&format!("BEGIN:VCARD\r\nVERSION:3.0\r\n{body}END:VCARD\r\n"))?.to_string()))
}

const OWNED: [VCardProperty; 8] = [
    VCardProperty::Fn,
    VCardProperty::N,
    VCardProperty::Email,
    VCardProperty::Tel,
    VCardProperty::Org,
    VCardProperty::Title,
    VCardProperty::Note,
    VCardProperty::Bday,
];

pub fn edit_contact(vcf: &str, input: &ContactInput) -> Result<String> {
    let mut card = parse(vcf)?;
    let version = if vcf.contains("VERSION:4.0") { "4.0" } else { "3.0" };
    let mut lines = input_lines(input)?;
    if let Some(l) = input.photo.as_deref().map(|p| photo_line(version, p)).transpose()?.flatten() {
        lines.push(l);
    }
    let fresh = card_entries(version, &lines)?;
    // Labels and the photo are ours only when the edit sets them.
    let owned = |p: &VCardProperty| OWNED.contains(p) || (input.labels.is_some() && *p == VCardProperty::Categories) || (input.photo.is_some() && *p == VCardProperty::Photo);
    card.entries.retain(|e| !owned(&e.name) && e.name != VCardProperty::Rev);
    // Keep fields we own ahead of the rest, where clients expect them.
    let at = card.entries.iter().position(|e| !matches!(e.name, VCardProperty::Begin | VCardProperty::Version)).unwrap_or(card.entries.len());
    for (i, e) in fresh.into_iter().filter(|e| owned(&e.name)).enumerate() {
        card.entries.insert(at + i, e);
    }
    Ok(crlf(card.to_string()))
}

pub fn normalize_email(e: &str) -> String {
    e.trim().to_ascii_lowercase()
}

/// Digits only, with any leading international prefix dropped to its last
/// ten digits, so "+1 (555) 010-2030" and "555-010-2030" match.
pub fn normalize_phone(p: &str) -> String {
    let d: String = p.chars().filter(char::is_ascii_digit).collect();
    if d.len() > 10 { d[d.len() - 10..].to_string() } else { d }
}

/// Folds `other` into `primary`: missing emails and phones are added, and
/// single-valued fields `primary` lacks (company, title, note, birthday,
/// photo, addresses, URLs) are copied over. `primary` keeps its UID.
pub fn merge_contacts(primary: &str, other: &str) -> Result<String> {
    let mut a = parse(primary)?;
    let b = parse(other)?;
    let emails: Vec<String> = a.properties(&VCardProperty::Email).filter_map(first_text).map(|e| normalize_email(&e)).collect();
    let phones: Vec<String> = a.properties(&VCardProperty::Tel).filter_map(first_text).map(|p| normalize_phone(&p)).collect();
    let mut add = Vec::new();
    for e in &b.entries {
        let keep = match &e.name {
            VCardProperty::Email => first_text(e).is_some_and(|v| !emails.contains(&normalize_email(&v))),
            VCardProperty::Tel => first_text(e).is_some_and(|v| !phones.contains(&normalize_phone(&v))),
            VCardProperty::Org | VCardProperty::Title | VCardProperty::Note | VCardProperty::Bday | VCardProperty::Photo => a.property(&e.name).is_none(),
            VCardProperty::Adr | VCardProperty::Url | VCardProperty::Categories => !a.entries.iter().any(|x| x.name == e.name && x.values == e.values),
            _ => false,
        };
        if keep {
            add.push(e.clone());
        }
    }
    let end = a.entries.iter().rposition(|e| e.name == VCardProperty::End).unwrap_or(a.entries.len());
    for (i, e) in add.into_iter().enumerate() {
        a.entries.insert(end + i, e);
    }
    Ok(crlf(a.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ANA: &str = "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:ana-1\r\nFN:Ana Duarte\r\nN:Duarte;Ana;;;\r\nEMAIL;TYPE=INTERNET,WORK:ana@studio.example\r\nTEL;TYPE=CELL:+1 (555) 010-2030\r\nADR;TYPE=HOME:;;1 Lighthouse Rd;Porto;;4000;PT\r\nX-CUSTOM:keep me\r\nEND:VCARD\r\n";

    #[test]
    fn photos_are_set_replaced_and_removed() {
        use base64::Engine;
        // A 1×1 PNG.
        let png = base64::engine::general_purpose::STANDARD.encode([0x89, b'P', b'N', b'G', 13, 10, 26, 10, 0, 0, 0, 13]);
        let url = format!("data:image/png;base64,{png}");
        let vcf = new_contact("p-1", &ContactInput { photo: Some(url.clone()), ..input() }).unwrap();
        let line = vcf.lines().find(|l| l.starts_with("PHOTO;")).unwrap_or_default().to_ascii_uppercase();
        assert!(line.contains("ENCODING=B") && line.contains("TYPE=PNG"), "inline binary for 3.0: {vcf}");
        assert_eq!(read_contact(&vcf).unwrap().photo.as_deref(), Some(url.as_str()), "and it reads back as the same image");
        let kept = edit_contact(&vcf, &ContactInput { note: Some("x".into()), ..input() }).unwrap();
        assert!(read_contact(&kept).unwrap().photo.is_some(), "an edit without a photo keeps it");
        let gone = edit_contact(&vcf, &ContactInput { photo: Some(String::new()), ..input() }).unwrap();
        assert!(read_contact(&gone).unwrap().photo.is_none() && !gone.contains("PHOTO"), "an empty photo removes it");
        let v4 = "BEGIN:VCARD\r\nVERSION:4.0\r\nUID:p-2\r\nFN:Ana\r\nEND:VCARD\r\n";
        let set4 = edit_contact(v4, &ContactInput { photo: Some(url.clone()), ..input() }).unwrap();
        assert_eq!(read_contact(&set4).unwrap().photo.as_deref(), Some(url.as_str()), "4.0 keeps a data URI");
        for bad in ["https://tracker.example/me.jpg", "data:image/gif;base64,R0lG", "data:image/png;base64,***"] {
            assert!(new_contact("p-3", &ContactInput { photo: Some(bad.into()), ..input() }).is_err(), "{bad}");
        }
        let huge = format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(vec![0u8; PHOTO_LIMIT + 1]));
        assert!(new_contact("p-4", &ContactInput { photo: Some(huge), ..input() }).unwrap_err().to_string().contains("too large"));
    }

    fn input() -> ContactInput {
        ContactInput { photo: None,
            book_id: "b".into(),
            full_name: "Marcus Lee".into(),
            emails: vec![ContactField { label: Some("home".into()), value: "marcus@example.com".into() }],
            phones: vec![ContactField { label: None, value: "555 0100".into() }],
            org: Some("Ferry Line, Inc.".into()),
            title: None,
            note: Some("Board games\nGood coffee".into()),
            birthday: Some("1990-04-02".into()),
            labels: None,
        }
    }

    #[test]
    fn year_less_birthdays_survive_a_round_trip() {
        let vcf = new_contact("m-1", &ContactInput { photo: None, birthday: Some("--07-02".into()), ..input() }).unwrap();
        assert_eq!(read_contact(&vcf).unwrap().birthday.as_deref(), Some("--07-02"));
        let edited = edit_contact(&vcf, &ContactInput { photo: None, note: Some("x".into()), birthday: Some("--07-02".into()), ..input() }).unwrap();
        assert_eq!(read_contact(&edited).unwrap().birthday.as_deref(), Some("--07-02"), "and an edit");
        assert_eq!(read_contact("BEGIN:VCARD\r\nVERSION:3.0\r\nFN:X\r\nBDAY;VALUE=date:19900402\r\nEND:VCARD\r\n").unwrap().birthday.as_deref(), Some("1990-04-02"));
    }

    #[test]
    fn reads_v3_cards() {
        let c = read_contact(ANA).unwrap();
        assert_eq!(c.uid, "ana-1");
        assert_eq!(c.full_name, "Ana Duarte");
        assert_eq!((c.given.as_deref(), c.family.as_deref()), (Some("Ana"), Some("Duarte")));
        assert_eq!(c.emails, vec![ContactField { label: Some("work".into()), value: "ana@studio.example".into() }]);
        assert_eq!(c.phones[0].label.as_deref(), Some("cell"));
    }

    #[test]
    fn falls_back_to_n_org_or_email_for_the_name() {
        let c = read_contact("BEGIN:VCARD\r\nVERSION:3.0\r\nEMAIL:x@y.example\r\nEND:VCARD\r\n").unwrap();
        assert_eq!(c.full_name, "x@y.example");
        let c = read_contact("BEGIN:VCARD\r\nVERSION:4.0\r\nN:Lee;Marcus;;;\r\nEND:VCARD\r\n").unwrap();
        assert_eq!(c.full_name, "Marcus Lee");
    }

    #[test]
    fn new_cards_round_trip() {
        let vcf = new_contact("m-1", &input()).unwrap();
        assert!(vcf.contains("VERSION:3.0"));
        let c = read_contact(&vcf).unwrap();
        assert_eq!(c.full_name, "Marcus Lee");
        assert_eq!(c.family.as_deref(), Some("Lee"));
        assert_eq!(c.org.as_deref(), Some("Ferry Line, Inc."));
        assert_eq!(c.note.as_deref(), Some("Board games\nGood coffee"));
        assert_eq!(c.birthday.as_deref(), Some("1990-04-02"));
        assert_eq!(c.emails[0].label.as_deref(), Some("home"));
        let empty = ContactInput { photo: None, full_name: " ".into(), emails: vec![], phones: vec![], org: None, ..input() };
        assert!(new_contact("x", &empty).is_err());
    }

    #[test]
    fn edits_keep_unmodeled_fields() {
        let edited = edit_contact(ANA, &input()).unwrap();
        assert!(edited.contains("X-CUSTOM:keep me"));
        assert!(edited.contains("1 Lighthouse Rd"));
        let c = read_contact(&edited).unwrap();
        assert_eq!(c.uid, "ana-1", "same contact");
        assert_eq!(c.full_name, "Marcus Lee");
        assert_eq!(c.emails.len(), 1, "old email replaced");
    }

    #[test]
    fn merging_adds_what_is_missing_only() {
        let other = "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:ana-2\r\nFN:Ana D.\r\nEMAIL:ANA@studio.example\r\nEMAIL:ana@home.example\r\nTEL:555-010-2030\r\nORG:Lighthouse Studio\r\nEND:VCARD\r\n";
        let merged = read_contact(&merge_contacts(ANA, other).unwrap()).unwrap();
        assert_eq!(merged.uid, "ana-1");
        assert_eq!(merged.full_name, "Ana Duarte", "primary's name wins");
        assert_eq!(merged.emails.len(), 2, "case-insensitive email dedupe");
        assert_eq!(merged.phones.len(), 1, "phone formats normalize");
        assert_eq!(merged.org.as_deref(), Some("Lighthouse Studio"));
    }

    #[test]
    fn phone_normalization() {
        assert_eq!(normalize_phone("+1 (555) 010-2030"), normalize_phone("555.010.2030"));
        assert_ne!(normalize_phone("555 0100"), normalize_phone("555 0101"));
    }
}
