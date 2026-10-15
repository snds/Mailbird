//! One action grammar (ADR-0025): which mail actions your swipes do. The
//! actions themselves are the shared vocabulary the toolbar, shortcuts, and
//! ⌘K already use; this stores the user's mapping, in the core, so every
//! browser on the gateway and every device shell agrees.

use serde::{Deserialize, Serialize};

use crate::store::{Store, from_json, json};
use crate::{Error, Result};

/// Mail actions a swipe can do.
pub const SWIPE_ACTIONS: &[&str] = &["none", "read", "archive", "star", "snooze-tomorrow", "snooze-next-week", "remind", "newsletters"];

const KEY: &str = "swipe_actions";

/// A swipe each way, short and long. A long swipe set to "none" does the
/// short swipe's action, so one action per side is the simple case.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwipeActions {
    /// Swipe right (toward the end of the line in left-to-right text).
    pub right: String,
    pub right_long: String,
    pub left: String,
    pub left_long: String,
}

impl Default for SwipeActions {
    /// Apple Mail's: right toggles read, left archives.
    fn default() -> Self {
        Self { right: "read".into(), right_long: "none".into(), left: "archive".into(), left_long: "none".into() }
    }
}

impl Store {
    pub fn swipe_actions(&self) -> Result<SwipeActions> {
        Ok(self.setting(KEY)?.map(from_json::<SwipeActions>).unwrap_or_default())
    }

    pub fn set_swipe_actions(&self, actions: &SwipeActions) -> Result<SwipeActions> {
        for a in [&actions.right, &actions.right_long, &actions.left, &actions.left_long] {
            if !SWIPE_ACTIONS.contains(&a.as_str()) {
                return Err(Error::Invalid(format!("“{a}” isn't something a swipe can do")));
            }
        }
        self.set_setting(KEY, Some(&json(actions)))?;
        Ok(actions.clone())
    }
}

// ── Keys (ADR-0032) ──────────────────────────────────────────────────────

/// Commands a single key can do, and their default key ("" for none).
/// Mail and Calendar are separate areas: a key can mean one thing in each.
pub const KEY_COMMANDS: &[(&str, &str)] = &[
    ("mail.next", "j"),
    ("mail.previous", "k"),
    ("mail.archive", "e"),
    ("mail.star", "s"),
    ("mail.unread", "u"),
    ("mail.snooze-tomorrow", "h"),
    ("mail.snooze-next-week", ""),
    ("mail.remind", ""),
    ("mail.newsletters", ""),
    ("mail.compose", "c"),
    ("mail.search", "/"),
    ("calendar.today", "t"),
    ("calendar.day", "d"),
    ("calendar.week", "w"),
    ("calendar.month", "m"),
    ("calendar.agenda", "a"),
    ("calendar.previous", "ArrowLeft"),
    ("calendar.next", "ArrowRight"),
];

/// Named keys that can be bound, besides one visible character.
const NAMED_KEYS: &[&str] = &["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", "Delete", "Backspace"];

const KEYS: &str = "key_bindings";

/// Command id → key, as the browser names it (`KeyboardEvent.key`): "e",
/// "E" for Shift+E, "/", "ArrowLeft". An empty key means none.
pub type KeyBindings = std::collections::BTreeMap<String, String>;

fn area(command: &str) -> &str {
    command.split('.').next().unwrap_or("")
}

/// Why `key` can't be bound, if it can't.
fn key_problem(key: &str) -> Option<String> {
    let mut chars = key.chars();
    let one = matches!((chars.next(), chars.next()), (Some(c), None) if !c.is_whitespace() && !c.is_control());
    match key {
        "" => None,
        "?" => Some("? opens the list of keys, so it stays as it is".into()),
        k if one || NAMED_KEYS.contains(&k) => None,
        k => Some(format!("“{k}” can't be a shortcut: use one key (Shift is fine)")),
    }
}

/// The defaults, with `saved` laid over them. A command added after you
/// saved gets its default key unless you already use that key in its area.
fn merged(saved: &KeyBindings) -> KeyBindings {
    let mut out = KeyBindings::new();
    for (id, default) in KEY_COMMANDS {
        let key = match saved.get(*id) {
            Some(k) => k.clone(),
            None if saved.iter().any(|(c, k)| k == default && area(c) == area(id)) => String::new(),
            None => default.to_string(),
        };
        out.insert(id.to_string(), key);
    }
    out
}

impl Store {
    /// Every command's key (ADR-0032).
    pub fn key_bindings(&self) -> Result<KeyBindings> {
        let saved = self.setting(KEYS)?.map(from_json::<KeyBindings>).unwrap_or_default();
        Ok(merged(&saved))
    }

    /// Saves keys. Commands left out keep their defaults, so `{}` resets.
    /// Refuses unknown commands, keys that can't be shortcuts, and one key
    /// for two commands in the same area, changing nothing.
    pub fn set_key_bindings(&self, bindings: &KeyBindings) -> Result<KeyBindings> {
        for (id, key) in bindings {
            if !KEY_COMMANDS.iter().any(|(c, _)| c == id) {
                return Err(Error::Invalid(format!("“{id}” isn't a command a key can do")));
            }
            if let Some(why) = key_problem(key) {
                return Err(Error::Invalid(why));
            }
        }
        let all = merged(bindings);
        let mut seen: std::collections::HashMap<(&str, &str), &str> = Default::default();
        for (id, key) in all.iter().filter(|(_, k)| !k.is_empty()) {
            if let Some(other) = seen.insert((area(id), key.as_str()), id.as_str()) {
                return Err(Error::Invalid(format!("“{key}” is already the key for {other}")));
            }
        }
        // Keep only what differs, so later defaults still reach you.
        let changed: KeyBindings = all.iter().filter(|(id, k)| KEY_COMMANDS.iter().any(|(c, d)| c == id && d != k)).map(|(a, b)| (a.clone(), b.clone())).collect();
        let stored = (!changed.is_empty()).then(|| json(&changed));
        self.set_setting(KEYS, stored.as_deref())?;
        Ok(all)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn swipes_default_to_apple_mail_and_save() {
        let s = Store::open_in_memory().unwrap();
        assert_eq!(s.swipe_actions().unwrap(), SwipeActions::default());
        let mine = SwipeActions { right: "star".into(), right_long: "remind".into(), left: "snooze-tomorrow".into(), left_long: "archive".into() };
        s.set_swipe_actions(&mine).unwrap();
        assert_eq!(s.swipe_actions().unwrap(), mine);
        let bad = SwipeActions { left: "delete-forever".into(), ..mine.clone() };
        assert!(s.set_swipe_actions(&bad).unwrap_err().to_string().contains("isn't something a swipe can do"));
        assert_eq!(s.swipe_actions().unwrap(), mine, "a bad mapping changes nothing");
    }

    #[test]
    fn keys_default_remap_and_refuse() {
        let s = Store::open_in_memory().unwrap();
        let keys = s.key_bindings().unwrap();
        assert_eq!(keys.len(), KEY_COMMANDS.len());
        assert_eq!((keys["mail.archive"].as_str(), keys["mail.remind"].as_str()), ("e", ""));

        // Swap archive and star, give remind a key, and Shift+N for next week.
        let mut mine = keys.clone();
        mine.insert("mail.archive".into(), "s".into());
        mine.insert("mail.star".into(), "e".into());
        mine.insert("mail.remind".into(), "r".into());
        mine.insert("mail.snooze-next-week".into(), "N".into());
        assert_eq!(s.set_key_bindings(&mine).unwrap(), mine);
        assert_eq!(s.key_bindings().unwrap(), mine);
        // Only the differences are stored.
        let stored: KeyBindings = from_json(s.setting(KEYS).unwrap().unwrap());
        assert_eq!(stored.len(), 4);

        // The same key may mean different things in Mail and Calendar.
        let mut both = mine.clone();
        both.insert("calendar.today".into(), "e".into());
        s.set_key_bindings(&both).unwrap();

        for (id, key, why) in [
            ("mail.star", "s", "already the key"),
            ("mail.star", "?", "opens the list"),
            ("mail.star", "Control", "use one key"),
            ("mail.star", " ", "use one key"),
            ("mail.delete-forever", "x", "isn't a command"),
        ] {
            let mut bad = both.clone();
            bad.insert(id.into(), key.into());
            assert!(s.set_key_bindings(&bad).unwrap_err().to_string().contains(why), "{id} {key:?}");
        }
        assert_eq!(s.key_bindings().unwrap(), both, "a refused change changes nothing");

        // An empty map resets; nothing is stored.
        assert_eq!(s.set_key_bindings(&KeyBindings::new()).unwrap(), keys);
        assert!(s.setting(KEYS).unwrap().is_none());
    }

    #[test]
    fn a_new_default_yields_to_a_key_you_chose() {
        let mut saved = KeyBindings::new();
        saved.insert("mail.remind".into(), "h".into());
        saved.insert("mail.snooze-tomorrow".into(), "".into());
        let m = merged(&saved);
        assert_eq!((m["mail.remind"].as_str(), m["mail.snooze-tomorrow"].as_str()), ("h", ""));
        // A default that collides with a saved key in its area goes unbound.
        let mut taken = KeyBindings::new();
        taken.insert("mail.remind".into(), "e".into());
        assert_eq!(merged(&taken)["mail.archive"], "");
    }
}
