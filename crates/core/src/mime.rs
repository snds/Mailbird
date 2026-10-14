//! Turning raw RFC 5322 messages into the fields the store keeps.

use mail_parser::{Address as MpAddress, HeaderValue, MessageParser, MimeHeaders};

use crate::{Address, Error, Result};

/// The parts of a message the app stores and shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Parsed {
    pub message_id: Option<String>,
    pub from: Address,
    pub to: Vec<Address>,
    pub cc: Vec<Address>,
    pub subject: String,
    pub date: Option<i64>,
    pub preview: String,
    /// Plain text; derived from HTML when the message has no text part.
    pub body_text: String,
    /// Only set when the message actually has an HTML part.
    pub body_html: Option<String>,
    /// Threading headers, without angle brackets.
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
    pub attachments: Vec<ParsedAttachment>,
}

/// An attachment's metadata. `index` is its position in the message's
/// attachment list, which is how its bytes are found again later.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedAttachment {
    pub index: u32,
    pub filename: String,
    pub mime_type: String,
    pub size: u64,
    pub content_id: Option<String>,
    /// Shown in the body (an embedded image) rather than as a file.
    pub inline: bool,
}

const PREVIEW_CHARS: usize = 160;

pub fn parse(raw: &[u8]) -> Result<Parsed> {
    let msg = MessageParser::default()
        .parse(raw)
        .ok_or_else(|| Error::Parse("not a valid email message".into()))?;

    let from = msg
        .from()
        .and_then(|a| a.first())
        .map(|a| Address {
            name: a.name.as_deref().map(str::to_owned),
            email: a.address.as_deref().unwrap_or_default().to_owned(),
        })
        .unwrap_or(Address { name: None, email: String::new() });

    let body_text = msg.body_text(0).map(|b| b.into_owned()).unwrap_or_default();
    // mail-parser synthesizes HTML from text parts; only keep real HTML.
    let body_html = msg
        .html_part(0)
        .filter(|p| p.is_text_html())
        .and_then(|_| msg.body_html(0))
        .map(|b| b.into_owned());

    Ok(Parsed {
        message_id: msg.message_id().map(str::to_owned),
        from,
        to: addresses(msg.to()),
        cc: addresses(msg.cc()),
        subject: msg.subject().unwrap_or_default().trim().to_owned(),
        date: msg.date().map(|d| d.to_timestamp()),
        preview: preview(&body_text),
        body_text,
        body_html,
        in_reply_to: ids(msg.in_reply_to()).into_iter().next(),
        references: ids(msg.references()),
        attachments: msg
            .attachments()
            .enumerate()
            .map(|(i, part)| {
                let mime_type = part
                    .content_type()
                    .map(|ct| match ct.subtype() {
                        Some(sub) => format!("{}/{}", ct.ctype(), sub),
                        None => ct.ctype().to_owned(),
                    })
                    .unwrap_or_else(|| "application/octet-stream".into())
                    .to_ascii_lowercase();
                let content_id = part.content_id().map(|c| strip_brackets(c).to_owned());
                let inline = part.content_disposition().is_some_and(|d| d.is_inline())
                    || (content_id.is_some() && part.content_disposition().is_none_or(|d| !d.is_attachment()));
                ParsedAttachment {
                    index: i as u32,
                    filename: part
                        .attachment_name()
                        .map(str::to_owned)
                        .unwrap_or_else(|| default_name(i, &mime_type)),
                    size: part.len() as u64,
                    mime_type,
                    content_id,
                    inline,
                }
            })
            .collect(),
    })
}

fn strip_brackets(id: &str) -> &str {
    id.trim().trim_start_matches('<').trim_end_matches('>')
}

fn ids(v: &HeaderValue<'_>) -> Vec<String> {
    let raw: Vec<&str> = match v {
        HeaderValue::Text(t) => vec![t.as_ref()],
        HeaderValue::TextList(l) => l.iter().map(|t| t.as_ref()).collect(),
        _ => vec![],
    };
    raw.into_iter()
        .flat_map(|s| s.split_whitespace())
        .map(strip_brackets)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}

fn default_name(i: usize, mime: &str) -> String {
    let ext = mime.rsplit('/').next().filter(|e| e.len() <= 5 && e.chars().all(|c| c.is_ascii_alphanumeric()));
    match ext {
        Some(ext) => format!("attachment-{}.{ext}", i + 1),
        None => format!("attachment-{}", i + 1),
    }
}

/// The iCalendar object of an invitation (iMIP, RFC 6047): the first
/// `text/calendar` part, or an `.ics` attachment.
pub fn calendar_part(raw: &[u8]) -> Option<String> {
    let msg = MessageParser::default().parse(raw)?;
    msg.parts.iter().find_map(|p| {
        let ct = p.content_type()?;
        let mime = format!("{}/{}", ct.ctype(), ct.subtype().unwrap_or_default()).to_ascii_lowercase();
        let ics_file = p.attachment_name().is_some_and(|n| n.to_ascii_lowercase().ends_with(".ics"));
        if mime == "text/calendar" || mime == "application/ics" || ics_file {
            let text = String::from_utf8_lossy(p.contents()).into_owned();
            text.contains("BEGIN:VCALENDAR").then_some(text)
        } else {
            None
        }
    })
}

/// The decoded bytes of one attachment, found by its index.
pub fn attachment_bytes(raw: &[u8], index: u32) -> Option<Vec<u8>> {
    let msg = MessageParser::default().parse(raw)?;
    msg.attachments().nth(index as usize).map(|p| p.contents().to_vec())
}

fn addresses(list: Option<&MpAddress<'_>>) -> Vec<Address> {
    list.map(|a| {
        a.clone()
            .into_list()
            .into_iter()
            .filter_map(|a| {
                Some(Address {
                    name: a.name.map(|n| n.into_owned()),
                    email: a.address?.into_owned(),
                })
            })
            .collect()
    })
    .unwrap_or_default()
}

/// One line of readable text: quoted replies and signatures dropped,
/// whitespace collapsed, cut at a word boundary.
pub fn preview(body: &str) -> String {
    let mut out = String::new();
    for line in body.lines() {
        let line = line.trim();
        if line == "--" || line.starts_with("-- ") {
            break; // signature delimiter (RFC 3676)
        }
        if line.is_empty() || line.starts_with('>') {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(&line.split_whitespace().collect::<Vec<_>>().join(" "));
        if out.chars().count() > PREVIEW_CHARS {
            break;
        }
    }
    if out.chars().count() <= PREVIEW_CHARS {
        return out;
    }
    let cut: String = out.chars().take(PREVIEW_CHARS).collect();
    match cut.rfind(' ') {
        Some(i) => format!("{}…", &cut[..i]),
        None => format!("{cut}…"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PLAIN: &[u8] = b"From: Priya Raman <priya@studio.example>\r\n\
To: Sean <sean@example.com>, team@example.com\r\n\
Subject: Token audit\r\n\
Date: Tue, 13 Oct 2026 09:41:00 +0000\r\n\
Message-ID: <abc@studio.example>\r\n\
\r\n\
Hi,\r\n\r\nThree surface tokens collapse in dark mode.\r\n\r\n> earlier quoted text\r\n-- \r\nPriya\r\n";

    #[test]
    fn parses_headers_and_body() {
        let p = parse(PLAIN).unwrap();
        assert_eq!(p.from.name.as_deref(), Some("Priya Raman"));
        assert_eq!(p.from.email, "priya@studio.example");
        assert_eq!(p.to.len(), 2);
        assert_eq!(p.subject, "Token audit");
        assert_eq!(p.message_id.as_deref(), Some("abc@studio.example"));
        assert_eq!(p.date, Some(1_791_884_460));
        assert!(p.body_html.is_none(), "text-only mail must not get synthesized HTML");
    }

    #[test]
    fn preview_skips_quotes_and_signature() {
        let p = parse(PLAIN).unwrap();
        assert_eq!(p.preview, "Hi, Three surface tokens collapse in dark mode.");
    }

    #[test]
    fn html_only_mail_gets_text_and_keeps_html() {
        let raw = b"From: a@example.com\r\nSubject: Hi\r\nContent-Type: text/html\r\n\r\n<p>Hello <b>there</b></p>";
        let p = parse(raw).unwrap();
        assert!(p.body_text.contains("Hello"));
        assert!(p.body_html.as_deref().unwrap().contains("<b>there</b>"));
    }

    const WITH_ATTACHMENTS: &[u8] = b"From: a@example.com\r\n\
Subject: Photos\r\n\
Message-ID: <child@example.com>\r\n\
In-Reply-To: <parent@example.com>\r\n\
References: <root@example.com> <parent@example.com>\r\n\
MIME-Version: 1.0\r\n\
Content-Type: multipart/mixed; boundary=\"b1\"\r\n\
\r\n\
--b1\r\n\
Content-Type: text/plain\r\n\
\r\n\
See attached.\r\n\
--b1\r\n\
Content-Type: application/pdf; name=\"itinerary.pdf\"\r\n\
Content-Disposition: attachment; filename=\"itinerary.pdf\"\r\n\
Content-Transfer-Encoding: base64\r\n\
\r\n\
SGVsbG8gUERG\r\n\
--b1\r\n\
Content-Type: image/png\r\n\
Content-ID: <logo@example.com>\r\n\
Content-Disposition: inline\r\n\
Content-Transfer-Encoding: base64\r\n\
\r\n\
iVBORw0KGgo=\r\n\
--b1--\r\n";

    #[test]
    fn reads_threading_headers() {
        let p = parse(WITH_ATTACHMENTS).unwrap();
        assert_eq!(p.in_reply_to.as_deref(), Some("parent@example.com"));
        assert_eq!(p.references, ["root@example.com", "parent@example.com"]);
    }

    #[test]
    fn lists_attachments_and_decodes_them() {
        let p = parse(WITH_ATTACHMENTS).unwrap();
        assert_eq!(p.attachments.len(), 2);
        let pdf = &p.attachments[0];
        assert_eq!((pdf.filename.as_str(), pdf.mime_type.as_str(), pdf.inline), ("itinerary.pdf", "application/pdf", false));
        assert_eq!(attachment_bytes(WITH_ATTACHMENTS, 0).unwrap(), b"Hello PDF");
        let logo = &p.attachments[1];
        assert!(logo.inline);
        assert_eq!(logo.content_id.as_deref(), Some("logo@example.com"));
        assert_eq!(logo.filename, "attachment-2.png");
        assert_eq!(p.body_text.trim(), "See attached.");
    }

    #[test]
    fn long_previews_cut_on_a_word() {
        let long = "word ".repeat(100);
        let p = preview(&long);
        assert!(p.ends_with('…'));
        assert!(p.chars().count() <= PREVIEW_CHARS + 1);
        assert!(!p.contains("wor…"));
    }
}
