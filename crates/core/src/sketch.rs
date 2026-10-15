//! Sketches (ADR-0046): drawings stored as SVG beside a note's photos.
//!
//! SVG can carry scripts, links, and styles that load things. A sketch is
//! only ever what the app draws, so the store accepts exactly that and
//! nothing else: an allow-list of elements and attributes, with values
//! checked character by character. Anything else is refused at the door,
//! from this device, another device, or an import.

use quick_xml::Reader;
use quick_xml::events::{BytesStart, Event};

use crate::{Error, Result};

pub(crate) const SVG: &str = "image/svg+xml";
/// Far more than a full page of drawing.
const MAX_SKETCH: usize = 4 * 1024 * 1024;
const SVG_NS: &str = "http://www.w3.org/2000/svg";

fn refuse(why: &str) -> Error {
    Error::Invalid(format!("that isn't a sketch Mailbird can keep ({why})"))
}

/// A number, as SVG writes them.
fn numeric(v: &str) -> bool {
    !v.is_empty() && v.chars().all(|c| c.is_ascii_digit() || matches!(c, '.' | '-' | 'e' | 'E'))
}

/// `#rgb`, `#rrggbb`, `#rrggbbaa`, or `none`: never `url(…)` or a name that could load anything.
fn color(v: &str) -> bool {
    v == "none" || (v.starts_with('#') && matches!(v.len(), 4 | 7 | 9) && v[1..].chars().all(|c| c.is_ascii_hexdigit()))
}

fn path_data(v: &str) -> bool {
    v.chars().all(|c| c.is_ascii_digit() || c.is_ascii_whitespace() || "MmLlHhVvCcSsQqTtAaZz.,-eE".contains(c))
}

fn check_attrs(e: &BytesStart, name: &str) -> Result<()> {
    for a in e.attributes() {
        let a = a.map_err(|_| refuse("damaged attribute"))?;
        let key: &str = a.key.as_ref();
        let key = key.to_string();
        let value = a.value.to_string();
        let ok = match (name, key.as_str()) {
            ("svg", "xmlns") => value == SVG_NS,
            ("svg", "viewBox") => value.split_whitespace().count() == 4 && value.split_whitespace().all(numeric),
            ("svg", "width" | "height") => numeric(&value),
            ("metadata", "id") => value == "mailbird-sketch",
            ("g" | "path", "fill" | "stroke") => color(&value),
            ("g" | "path", "stroke-width" | "opacity" | "fill-opacity" | "stroke-opacity") => numeric(&value),
            ("g" | "path", "stroke-linecap" | "stroke-linejoin") => matches!(value.as_str(), "round" | "butt" | "square" | "miter" | "bevel"),
            ("path", "d") => path_data(&value),
            _ => false,
        };
        if !ok {
            return Err(refuse(&format!("{name} {key}")));
        }
    }
    Ok(())
}

/// Whether these bytes are a sketch the app drew, and safe to show.
pub(crate) fn check_sketch(data: &[u8]) -> Result<()> {
    if data.len() > MAX_SKETCH {
        return Err(Error::Invalid("that sketch is over 4 MB".into()));
    }
    let text = std::str::from_utf8(data).map_err(|_| refuse("not text"))?;
    let mut r = Reader::from_str(text);
    let mut stack: Vec<String> = Vec::new();
    let mut saw_root = false;
    loop {
        match r.read_event().map_err(|_| refuse("damaged"))? {
            Event::Decl(_) => {}
            Event::Start(e) => {
                let name = open(&e, &stack, saw_root)?;
                saw_root = true;
                stack.push(name);
            }
            Event::Empty(e) => {
                open(&e, &stack, saw_root)?;
                saw_root = true;
            }
            Event::End(_) => {
                stack.pop();
            }
            // Text only inside <metadata> (the strokes, as JSON); elsewhere just whitespace.
            Event::Text(t) => {
                if stack.last().map(String::as_str) != Some("metadata") && !AsRef::<str>::as_ref(&t).chars().all(char::is_whitespace) {
                    return Err(refuse("text"));
                }
            }
            Event::Eof => break,
            // No DOCTYPE (entities), processing instructions, CDATA, comments, or entity references.
            _ => return Err(refuse("markup")),
        }
    }
    if !saw_root || !stack.is_empty() {
        return Err(refuse("incomplete"));
    }
    Ok(())
}

fn open(e: &BytesStart, stack: &[String], saw_root: bool) -> Result<String> {
    let qname = e.name();
    let name: &str = qname.as_ref();
    let name = name.to_string();
    let parent = stack.last().map(String::as_str);
    let ok = match name.as_str() {
        "svg" => parent.is_none() && !saw_root,
        "metadata" | "g" | "path" => matches!(parent, Some("svg" | "g")),
        _ => false,
    };
    if !ok {
        return Err(refuse(&name));
    }
    check_attrs(e, &name)?;
    Ok(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 700" width="1000" height="700"><metadata id="mailbird-sketch">{"v":1,"strokes":[]}</metadata><g fill="#1a1a1a"><path d="M1 2L3.5 4Z" fill="#ff000080" opacity="0.4"/></g></svg>"##;

    #[test]
    fn keeps_what_the_app_draws() {
        check_sketch(GOOD.as_bytes()).unwrap();
        check_sketch(format!("<?xml version=\"1.0\"?>{GOOD}").as_bytes()).unwrap();
    }

    #[test]
    fn refuses_anything_that_could_run_or_load() {
        for bad in [
            r#"<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>"#,
            r#"<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>"#,
            r#"<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0" fill="url(https://x.test/a)"/></svg>"#,
            r#"<svg xmlns="http://www.w3.org/2000/svg"><image href="https://x.test/a.png"/></svg>"#,
            r#"<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0" style="fill:red"/></svg>"#,
            r#"<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg"></svg>"#,
            r#"<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/></svg>"#,
            r#"<svg xmlns="http://www.w3.org/2000/svg">hello</svg>"#,
            r#"<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/>"#,
            r#"<svg xmlns="http://evil.test"></svg>"#,
            r#"<svg xmlns="http://www.w3.org/2000/svg"></svg><svg xmlns="http://www.w3.org/2000/svg"></svg>"#,
            r#"<svg xmlns="http://www.w3.org/2000/svg"><metadata id="mailbird-sketch">&amp;</metadata></svg>"#,
        ] {
            assert!(check_sketch(bad.as_bytes()).is_err(), "{bad}");
        }
    }
}
