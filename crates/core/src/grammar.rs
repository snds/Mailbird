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
}
