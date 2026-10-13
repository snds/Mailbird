//! Turning raw RFC 5322 messages into the fields the store keeps.

use mail_parser::{Address as MpAddress, MessageParser};

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
    })
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

    #[test]
    fn long_previews_cut_on_a_word() {
        let long = "word ".repeat(100);
        let p = preview(&long);
        assert!(p.ends_with('…'));
        assert!(p.chars().count() <= PREVIEW_CHARS + 1);
        assert!(!p.contains("wor…"));
    }
}
