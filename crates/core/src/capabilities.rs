//! What each provider can and cannot do, so the UI can show honest capability
//! states instead of failing silently. See docs/research/competitive-analysis.md §4.

use serde::{Deserialize, Serialize};

/// Where an account's data comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    /// Gmail API + Google Calendar (CalDAV/API) + People API.
    Google,
    /// Microsoft Graph for Microsoft 365 and Outlook.com.
    Microsoft,
    /// IMAP/SMTP + CalDAV/CardDAV with an app-specific password.
    ICloud,
    /// JMAP (Fastmail, Stalwart, Thundermail).
    Jmap,
    /// Any standards-based host: IMAP/SMTP + optional CalDAV/CardDAV.
    Generic,
    /// On-device only (notes, contacts) — no server.
    Local,
}

/// How a provider organizes mail.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MailOrganization {
    /// A message can carry many labels (Gmail, JMAP mailboxes-as-keywords).
    Labels,
    /// A message lives in exactly one folder (IMAP, Graph).
    Folders,
}

/// How the app signs in to a provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthMethod {
    OAuth2,
    /// iCloud and some hosts: a generated password, revoked when the main
    /// account password changes — the UI needs a re-auth recovery flow.
    AppPassword,
    /// Generic IMAP/JMAP hosts that still use passwords.
    Password,
    None,
}

/// How notes sync for this account, if at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NotesSupport {
    /// We own the format end to end (Markdown + CRDT), stored locally or via our sync.
    Native,
    /// No live sync; offer a one-time import (Google Takeout, Apple Notes Markdown export).
    ImportOnly,
    Unsupported,
}

/// What the UI is allowed to promise for one account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Capabilities {
    pub mail: bool,
    pub calendar: bool,
    pub contacts: bool,
    pub notes: NotesSupport,
    pub mail_organization: Option<MailOrganization>,
    /// Contact groups/labels are readable and writable.
    pub contact_groups: bool,
    /// The server stores snooze/send-later itself, so it works across devices
    /// even when this app is closed. When false, the app schedules locally.
    pub server_side_scheduling: bool,
    /// The server can push changes (Gmail watch, Graph subscriptions, JMAP push, IMAP IDLE).
    pub push: bool,
    pub auth: AuthMethod,
}

impl Provider {
    /// Capability matrix, as researched 2026-10. Keep in sync with
    /// docs/research/competitive-analysis.md when providers change.
    pub fn capabilities(self) -> Capabilities {
        use MailOrganization::*;
        match self {
            Provider::Google => Capabilities {
                mail: true,
                calendar: true,
                contacts: true,
                // Keep's API is Workspace-only; consumer accounts get Takeout import.
                notes: NotesSupport::ImportOnly,
                mail_organization: Some(Labels),
                // Groups need the People API — Google's CardDAV omits them.
                contact_groups: true,
                server_side_scheduling: true,
                // Gmail push needs a Pub/Sub server; the native app polls the history id every 30 s.
                push: true,
                auth: AuthMethod::OAuth2,
            },
            Provider::Microsoft => Capabilities {
                mail: true,
                calendar: true,
                contacts: true,
                notes: NotesSupport::Unsupported,
                mail_organization: Some(Folders),
                contact_groups: true,
                server_side_scheduling: true,
                // Graph push needs a public webhook; the native app polls the inbox every 30 s.
                push: true,
                auth: AuthMethod::OAuth2,
            },
            Provider::ICloud => Capabilities {
                mail: true,
                calendar: true,
                contacts: true,
                // No public Notes API; Notes 26 exports Markdown we can import.
                notes: NotesSupport::ImportOnly,
                mail_organization: Some(Folders),
                contact_groups: true,
                server_side_scheduling: false,
                push: true, // IMAP IDLE
                auth: AuthMethod::AppPassword,
            },
            Provider::Jmap => Capabilities {
                mail: true,
                calendar: true,
                contacts: true,
                notes: NotesSupport::Unsupported,
                mail_organization: Some(Labels),
                contact_groups: true,
                server_side_scheduling: false,
                push: true,
                // Fastmail: an API token; Stalwart and others: the account password.
                auth: AuthMethod::Password,
            },
            Provider::Generic => Capabilities {
                mail: true,
                calendar: false, // enabled per account once a CalDAV URL is discovered
                contacts: false,
                notes: NotesSupport::Unsupported,
                mail_organization: Some(Folders),
                contact_groups: false,
                server_side_scheduling: false,
                push: false, // upgraded at runtime if the server advertises IDLE
                auth: AuthMethod::Password,
            },
            Provider::Local => Capabilities {
                mail: false,
                calendar: true,
                contacts: true,
                notes: NotesSupport::Native,
                mail_organization: None,
                contact_groups: true,
                server_side_scheduling: false,
                push: false,
                auth: AuthMethod::None,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn google_notes_are_import_only() {
        // Keep has no consumer API; promising sync would be a lie in the UI.
        assert_eq!(Provider::Google.capabilities().notes, NotesSupport::ImportOnly);
    }

    #[test]
    fn icloud_uses_app_passwords_and_folders() {
        let caps = Provider::ICloud.capabilities();
        assert_eq!(caps.auth, AuthMethod::AppPassword);
        assert_eq!(caps.mail_organization, Some(MailOrganization::Folders));
    }

    #[test]
    fn only_local_owns_notes_natively() {
        let native: Vec<_> = [
            Provider::Google,
            Provider::Microsoft,
            Provider::ICloud,
            Provider::Jmap,
            Provider::Generic,
            Provider::Local,
        ]
        .into_iter()
        .filter(|p| p.capabilities().notes == NotesSupport::Native)
        .collect();
        assert_eq!(native, vec![Provider::Local]);
    }

    #[test]
    fn serializes_for_the_front_end() {
        let json = serde_json::to_string(&Provider::ICloud.capabilities()).unwrap();
        assert!(json.contains("\"auth\":\"app_password\""));
        assert!(json.contains("\"notes\":\"import_only\""));
    }
}
