//! Mail's power settings (ADR-0055): the FairEmail-style choices most people
//! never change, kept behind Advanced. Defaults are the private, quiet ones.

use serde::{Deserialize, Serialize};

use crate::Result;
use crate::store::{Store, from_json, json};

const PREFS: &str = "mail.prefs";
/// The intervals Settings offers for checking mail, in minutes.
pub const CHECK_MINUTES: &[u32] = &[2, 5, 15, 30, 60];

/// When remote images in a message load.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RemoteImages {
    /// Blocked until you ask, message by message: they can tell a sender you
    /// opened their mail, and when.
    #[default]
    Ask,
    /// Loaded for people in your contacts; asked for everyone else.
    Contacts,
    Always,
}

/// When opening a conversation marks it read.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MarkRead {
    #[default]
    Open,
    /// After it's been open a few seconds, so a glance doesn't count.
    Delay,
    /// Only when you say so.
    Manual,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailPrefs {
    #[serde(default)]
    pub images: RemoteImages,
    #[serde(default)]
    pub mark_read: MarkRead,
    /// Replies include the message they answer.
    #[serde(default = "yes")]
    pub quote: bool,
    /// Write below the quote (bottom-posting) instead of above it.
    #[serde(default)]
    pub reply_below: bool,
    /// How often accounts without push are checked, in minutes. Push
    /// (IMAP IDLE, the relay) is untouched: it's instant either way.
    #[serde(default = "two")]
    pub check_minutes: u32,
    /// Ask for a read receipt on everything you send. The composer can
    /// still turn it on or off per message.
    #[serde(default)]
    pub request_receipts: bool,
}

fn yes() -> bool {
    true
}

fn two() -> u32 {
    2
}

impl Default for MailPrefs {
    fn default() -> Self {
        Self { images: RemoteImages::Ask, mark_read: MarkRead::Open, quote: true, reply_below: false, check_minutes: 2, request_receipts: false }
    }
}

impl MailPrefs {
    /// An interval Settings offers: anything else snaps to the nearest one.
    fn clean(mut self) -> Self {
        self.check_minutes = *CHECK_MINUTES.iter().min_by_key(|m| m.abs_diff(self.check_minutes)).unwrap_or(&2);
        self
    }
}

impl Store {
    pub fn mail_prefs(&self) -> Result<MailPrefs> {
        Ok(self.setting(PREFS)?.map(from_json::<MailPrefs>).unwrap_or_default().clean())
    }

    pub fn set_mail_prefs(&self, prefs: &MailPrefs) -> Result<MailPrefs> {
        let prefs = prefs.clean();
        self.set_setting(PREFS, Some(&json(&prefs)))?;
        Ok(prefs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_private_and_quiet() {
        let s = Store::open_in_memory().unwrap();
        let p = s.mail_prefs().unwrap();
        assert_eq!((p.images, p.mark_read, p.quote, p.reply_below, p.check_minutes, p.request_receipts), (RemoteImages::Ask, MarkRead::Open, true, false, 2, false));
    }

    #[test]
    fn prefs_round_trip_and_intervals_snap() {
        let s = Store::open_in_memory().unwrap();
        let want = MailPrefs { images: RemoteImages::Contacts, mark_read: MarkRead::Delay, quote: false, reply_below: true, check_minutes: 15, request_receipts: true };
        assert_eq!(s.set_mail_prefs(&want).unwrap(), want);
        assert_eq!(s.mail_prefs().unwrap(), want);
        assert_eq!(s.set_mail_prefs(&MailPrefs { check_minutes: 7, ..want }).unwrap().check_minutes, 5, "an interval Settings doesn't offer snaps to the nearest");
        assert_eq!(s.set_mail_prefs(&MailPrefs { check_minutes: 0, ..want }).unwrap().check_minutes, 2);
    }

    #[test]
    fn older_saved_prefs_fill_in_defaults() {
        let s = Store::open_in_memory().unwrap();
        s.set_setting(PREFS, Some(r#"{"images":"always"}"#)).unwrap();
        let p = s.mail_prefs().unwrap();
        assert_eq!((p.images, p.quote, p.check_minutes), (RemoteImages::Always, true, 2));
    }
}
