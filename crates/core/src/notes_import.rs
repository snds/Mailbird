//! Reading other apps' note exports. Pure functions: files in, notes out.
//!
//! - **Google Keep** (Takeout): one `.json` per note. Checklists become
//!   Markdown task lists, labels become tags, and pinned, archived, and
//!   trashed carry over (trashed notes are skipped). The `.html` copies next
//!   to the JSON are ignored.
//! - **Markdown folders** (Obsidian, Bear, Apple Notes exporters, plain
//!   `.md`/`.txt`): YAML front matter (`title`, `tags`, `created`,
//!   `updated`/`modified`, `pinned`, `archived`) is read and removed; Bear-style
//!   `#tags` in the text are collected as tags; the folders under the one
//!   you picked become a tag (`Work/Clients`).
//!
//! Images, audio, and drawings aren't imported yet; the report counts them.

use crate::{ImportFile, ImportReport};

pub(crate) struct ImportedNote {
    /// `{format}:{path}`, so importing the same export twice adds nothing.
    pub source: String,
    pub markdown: String,
    pub tags: Vec<String>,
    pub pinned: bool,
    pub archived: bool,
    pub created: i64,
    pub updated: i64,
}

const MEDIA: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "heic", "svg", "pdf", "m4a", "mp3", "3gp", "awb", "wav", "mp4", "mov"];

pub(crate) fn parse(files: &[ImportFile]) -> (Vec<ImportedNote>, ImportReport) {
    let mut notes = Vec::new();
    let mut report = ImportReport::default();
    let json_stems: std::collections::HashSet<&str> = files.iter().filter_map(|f| f.path.strip_suffix(".json")).collect();
    for f in files {
        let path = f.path.replace('\\', "/");
        let segments: Vec<&str> = path.split('/').collect();
        if segments.iter().any(|s| s.starts_with('.') || *s == "__MACOSX") {
            continue; // .obsidian, .trash, .DS_Store, …
        }
        let name = segments.last().copied().unwrap_or_default();
        let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
        if name == "Labels.txt" && segments.contains(&"Keep") {
            continue; // Keep's list of label names
        }
        match ext.as_str() {
            "json" => match keep_note(&path, &f.contents) {
                Some(Keep::Note(n, dropped)) => {
                    report.attachments_dropped += dropped;
                    notes.push(n);
                }
                Some(Keep::Trashed) => report.trashed += 1,
                None => report.skipped.push(path),
            },
            "md" | "markdown" | "txt" => notes.push(markdown_note(&segments, &f.contents, f.modified)),
            "html" if json_stems.contains(path.trim_end_matches(".html")) => {}
            e if MEDIA.contains(&e) => report.attachments_dropped += 1,
            _ => report.skipped.push(path),
        }
    }
    (notes, report)
}

enum Keep {
    Note(ImportedNote, u32),
    Trashed,
}

fn keep_note(path: &str, contents: &str) -> Option<Keep> {
    let v: serde_json::Value = serde_json::from_str(contents).ok()?;
    let o = v.as_object()?;
    // Keep's own fields; any other JSON file isn't a note.
    if !o.contains_key("userEditedTimestampUsec") || !(o.contains_key("textContent") || o.contains_key("listContent")) {
        return None;
    }
    if o.get("isTrashed").and_then(|b| b.as_bool()).unwrap_or(false) {
        return Some(Keep::Trashed);
    }
    let text = |k: &str| o.get(k).and_then(|s| s.as_str()).unwrap_or_default().trim().to_string();
    let secs = |k: &str| o.get(k).and_then(|n| n.as_i64()).map(|us| us / 1_000_000).unwrap_or(0);
    let mut md = String::new();
    let title = text("title");
    if !title.is_empty() {
        md.push_str(&format!("# {title}\n\n"));
    }
    let body = text("textContent");
    if !body.is_empty() {
        md.push_str(&body);
        md.push('\n');
    }
    if let Some(items) = o.get("listContent").and_then(|l| l.as_array()) {
        if !body.is_empty() {
            md.push('\n');
        }
        for i in items {
            let checked = i.get("isChecked").and_then(|b| b.as_bool()).unwrap_or(false);
            let t = i.get("text").and_then(|t| t.as_str()).unwrap_or_default().replace('\n', " ");
            md.push_str(&format!("- [{}] {}\n", if checked { "x" } else { " " }, t.trim()));
        }
    }
    if let Some(links) = o.get("annotations").and_then(|a| a.as_array()) {
        let links: Vec<String> = links
            .iter()
            .filter_map(|a| {
                let url = a.get("url")?.as_str()?;
                let label = a.get("title").and_then(|t| t.as_str()).filter(|t| !t.is_empty()).unwrap_or(url);
                Some(format!("- [{label}]({url})"))
            })
            .collect();
        if !links.is_empty() {
            md.push_str(&format!("\n{}\n", links.join("\n")));
        }
    }
    let tags = o
        .get("labels")
        .and_then(|l| l.as_array())
        .map(|l| l.iter().filter_map(|x| x.get("name")?.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let dropped = o.get("attachments").and_then(|a| a.as_array()).map(|a| a.len() as u32).unwrap_or(0);
    let updated = secs("userEditedTimestampUsec");
    let created = Some(secs("createdTimestampUsec")).filter(|c| *c > 0).unwrap_or(updated);
    Some(Keep::Note(
        ImportedNote {
            source: format!("keep:{path}"),
            markdown: md.trim_end().to_string(),
            tags,
            pinned: o.get("isPinned").and_then(|b| b.as_bool()).unwrap_or(false),
            archived: o.get("isArchived").and_then(|b| b.as_bool()).unwrap_or(false),
            created,
            updated,
        },
        dropped,
    ))
}

fn markdown_note(segments: &[&str], contents: &str, modified: Option<i64>) -> ImportedNote {
    let contents = contents.replace("\r\n", "\n");
    let (front, body) = front_matter(&contents);
    let get = |k: &str| front.iter().find(|(key, _)| key.eq_ignore_ascii_case(k)).map(|(_, v)| v.clone());
    let mut tags: Vec<String> = Vec::new();
    // The folders between the one picked and the file.
    if segments.len() > 2 {
        tags.push(segments[1..segments.len() - 1].join("/"));
    }
    if let Some(FrontValue::List(l)) = get("tags") {
        tags.extend(l);
    } else if let Some(FrontValue::Text(t)) = get("tags") {
        tags.extend(t.split([',', ' ']).filter(|s| !s.is_empty()).map(str::to_string));
    }
    tags.extend(inline_tags(body));

    let stem = segments.last().and_then(|n| n.rsplit_once('.').map(|(s, _)| s)).unwrap_or_default();
    let title = match get("title") {
        Some(FrontValue::Text(t)) if !t.is_empty() => t,
        _ => stem.to_string(),
    };
    let body = body.trim();
    let first = crate::notes_store::title_and_snippet(body).0;
    // Obsidian keeps the title in the file name, not the text. A note that
    // already opens with a heading or its own title keeps its first line.
    let opens_with_heading = body.starts_with('#') && body.trim_start_matches('#').starts_with(' ');
    let markdown = if title.is_empty() || opens_with_heading || first.eq_ignore_ascii_case(&title) { body.to_string() } else { format!("# {title}\n\n{body}") };
    let date = |k: &str| match get(k) {
        Some(FrontValue::Text(t)) => parse_date(&t),
        _ => None,
    };
    let updated = date("updated").or_else(|| date("modified")).or(modified).unwrap_or(0);
    let created = date("created").or_else(|| date("date")).unwrap_or(updated);
    ImportedNote {
        source: format!("md:{}", segments.join("/")),
        markdown: markdown.trim_end().to_string(),
        tags,
        pinned: matches!(get("pinned"), Some(FrontValue::Text(t)) if t == "true"),
        archived: matches!(get("archived"), Some(FrontValue::Text(t)) if t == "true"),
        created,
        updated: updated.max(created),
    }
}

#[derive(Clone)]
enum FrontValue {
    Text(String),
    List(Vec<String>),
}

/// A small reader for the front matter notes apps write: `key: value`,
/// `key: [a, b]`, and `key:` followed by `- item` lines.
fn front_matter(contents: &str) -> (Vec<(String, FrontValue)>, &str) {
    let Some(rest) = contents.strip_prefix("---\n") else { return (Vec::new(), contents) };
    let Some(end) = rest.find("\n---") else { return (Vec::new(), contents) };
    let body = rest[end + 4..].trim_start_matches(['-']).trim_start_matches('\n');
    let mut out: Vec<(String, FrontValue)> = Vec::new();
    for line in rest[..end].lines() {
        let unquote = |s: &str| s.trim().trim_matches(['"', '\'']).to_string();
        if let Some(item) = line.trim_start().strip_prefix("- ") {
            if let Some((_, FrontValue::List(l))) = out.last_mut() {
                l.push(unquote(item));
            }
            continue;
        }
        let Some((k, v)) = line.split_once(':') else { continue };
        let v = v.trim();
        let value = if v.is_empty() {
            FrontValue::List(Vec::new())
        } else if let Some(inner) = v.strip_prefix('[').and_then(|v| v.strip_suffix(']')) {
            FrontValue::List(inner.split(',').map(unquote).filter(|s| !s.is_empty()).collect())
        } else {
            FrontValue::Text(unquote(v))
        };
        out.push((k.trim().to_string(), value));
    }
    (out, body)
}

/// Bear and Obsidian `#tags` in the text: a `#` at a word start followed by
/// letters, digits, `/`, `-`, or `_`. Headings and code are left alone.
fn inline_tags(body: &str) -> Vec<String> {
    let mut tags = Vec::new();
    let mut fenced = false;
    for line in body.lines() {
        if line.trim_start().starts_with("```") {
            fenced = !fenced;
            continue;
        }
        if fenced {
            continue;
        }
        let mut in_code = false;
        let mut prev = ' ';
        let chars: Vec<char> = line.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            let c = chars[i];
            if c == '`' {
                in_code = !in_code;
            } else if c == '#' && !in_code && prev.is_whitespace() {
                let tag: String = chars[i + 1..].iter().take_while(|c| c.is_alphanumeric() || matches!(c, '/' | '-' | '_')).collect();
                if tag.chars().any(|c| c.is_alphabetic()) {
                    i += tag.chars().count();
                    tags.push(tag.trim_end_matches('/').to_string());
                }
            }
            prev = c;
            i += 1;
        }
    }
    tags
}

/// `2024-05-01`, `2024-05-01 09:30`, or `2024-05-01T09:30:00Z` (UTC unless an offset is given).
fn parse_date(s: &str) -> Option<i64> {
    let s = s.trim();
    if let Ok(d) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(d.timestamp());
    }
    for f in ["%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M"] {
        if let Ok(d) = chrono::NaiveDateTime::parse_from_str(s, f) {
            return Some(d.and_utc().timestamp());
        }
    }
    chrono::NaiveDate::parse_from_str(s.get(..10)?, "%Y-%m-%d").ok().and_then(|d| d.and_hms_opt(0, 0, 0)).map(|d| d.and_utc().timestamp())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str, contents: &str) -> ImportFile {
        ImportFile { path: path.into(), contents: contents.into(), modified: None }
    }

    #[test]
    fn keep_takeout_notes_and_checklists() {
        let note = r#"{"color":"DEFAULT","isTrashed":false,"isPinned":true,"isArchived":false,
            "textContent":"Remember the tokens","title":"Crit prep","userEditedTimestampUsec":1700000000000000,
            "createdTimestampUsec":1690000000000000,"labels":[{"name":"Work"}],
            "annotations":[{"url":"https://example.test/doc","title":"Doc","source":"WEBLINK"}],
            "attachments":[{"filePath":"a.png","mimetype":"image/png"}]}"#;
        let list = r#"{"isTrashed":false,"isPinned":false,"isArchived":true,"title":"",
            "listContent":[{"text":"Oat milk","isChecked":false},{"text":"Lemons","isChecked":true}],
            "userEditedTimestampUsec":1700000000000000}"#;
        let trashed = r#"{"isTrashed":true,"textContent":"x","userEditedTimestampUsec":1}"#;
        let (notes, r) = parse(&[
            file("Takeout/Keep/Crit prep.json", note),
            file("Takeout/Keep/Crit prep.html", "<html>"),
            file("Takeout/Keep/list.json", list),
            file("Takeout/Keep/old.json", trashed),
            file("Takeout/Keep/a.png", ""),
            file("Takeout/Keep/Labels.txt", "Work"),
            file("Takeout/archive_browser.html", "<html>"),
        ]);
        assert_eq!(notes.len(), 2);
        assert_eq!(notes[0].markdown, "# Crit prep\n\nRemember the tokens\n\n- [Doc](https://example.test/doc)");
        assert_eq!((notes[0].pinned, notes[0].created, notes[0].updated), (true, 1_690_000_000, 1_700_000_000));
        assert_eq!(notes[0].tags, ["Work"]);
        assert_eq!(notes[1].markdown, "- [ ] Oat milk\n- [x] Lemons");
        assert!(notes[1].archived);
        assert_eq!(notes[1].created, notes[1].updated);
        assert_eq!((r.trashed, r.attachments_dropped), (1, 2));
        assert_eq!(r.skipped, ["Takeout/archive_browser.html"]);
    }

    #[test]
    fn markdown_front_matter_folders_and_inline_tags() {
        let obsidian = "---\ntitle: \"Roadmap\"\ntags:\n  - planning\n  - q4\ncreated: 2026-01-05\nupdated: 2026-02-01T10:00:00Z\npinned: true\n---\nShip notes #release and `#notatag`\n\n```\n#nope\n```\n# Heading";
        let bear = "Groceries\n\n- lemons #home/errands #2024";
        let (notes, r) = parse(&[
            file("Vault/Work/Plans/roadmap.md", obsidian),
            file("Vault/groceries.md", bear),
            file("Vault/.obsidian/workspace.json", "{}"),
            file("Vault/.trash/old.md", "gone"),
        ]);
        assert!(r.skipped.is_empty());
        assert_eq!(notes.len(), 2);
        let n = &notes[0];
        assert_eq!(n.markdown, "# Roadmap\n\nShip notes #release and `#notatag`\n\n```\n#nope\n```\n# Heading");
        assert_eq!(n.tags, ["Work/Plans", "planning", "q4", "release"]);
        assert_eq!(n.created, 1_767_571_200);
        assert_eq!(n.updated, 1_769_940_000);
        assert!(n.pinned);
        let g = &notes[1];
        assert_eq!(g.markdown, "Groceries\n\n- lemons #home/errands #2024");
        assert_eq!(g.tags, ["home/errands"]);
    }

    #[test]
    fn apple_notes_export_keeps_its_first_line_title() {
        let (notes, _) = parse(&[ImportFile { path: "Notes/iCloud/Trip.md".into(), contents: "Trip\r\n\r\nPack the charger".into(), modified: Some(42) }]);
        assert_eq!(notes[0].markdown, "Trip\n\nPack the charger");
        assert_eq!(notes[0].tags, ["iCloud"]);
        assert_eq!((notes[0].created, notes[0].updated), (42, 42));
    }
}
