//! pim-core: the provider-agnostic heart of the app.
//!
//! Every shell (Tauri desktop, Tauri/Capacitor mobile, web gateway) calls into
//! this crate. The layering is deliberate:
//!
//! - [`store`] owns the local SQLite database. It is synchronous and has no
//!   network code, so it is easy to test and safe to hold behind a mutex.
//! - [`net`] (feature `net`) talks to servers. Its functions take plain config
//!   and return plain data, and they never touch the store. A shell fetches
//!   with `net`, then applies the result with `store`, so no lock is held
//!   across a network await.
//! - [`capabilities`] tells the UI what each provider supports.

pub mod capabilities;
mod compose_store;
mod connected_store;
mod contacts_store;
mod planning_store;
mod inbox_store;
mod people_store;
pub mod interesting;
pub mod grammar;
mod booking_store;
mod tasks_store;
pub use tasks_store::{NoteTask, NotesPrefs, PlannedTask};
pub use booking_store::{Booked, BookingChange, BookingLink, BookingLinkInput, BookingRequest, ManagedBooking, PublicBooking};
pub use grammar::{KEY_COMMANDS, KeyBindings, SWIPE_ACTIONS, SwipeActions};
pub use interesting::{INTERESTING_PREFIX, InterestingCalendar, REGIONS, RegionChoice, SPECIAL_PREFIX};
pub mod ical;
pub mod itip;
pub use connected_store::BIRTHDAY_PREFIX;
pub use contacts_store::{ContactCopy, ContactExport, ContactLabel, ContactSuggestion, DeletedContact};
pub use people_store::{ContactsRestore, ContactsRestored, RestorePoint, SmartGroup, SmartGroupInput};
pub use signature::SignatureCard;
pub mod meeting;
pub mod signature;
pub mod mime;
pub mod model;
mod pim_store;
mod sender_store;
pub mod triage;
mod invite_store;
mod notes_import;
mod notes_store;
pub mod store;
pub mod unsubscribe;
pub mod vcard;

#[cfg(feature = "net")]
pub mod net;

pub use capabilities::{AuthMethod, Capabilities, MailOrganization, NotesSupport, Provider};
pub use model::*;
pub use store::Store;

/// Errors surfaced to shells. Messages are written for people, because the
/// UI shows them as-is.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Invalid(String),
    #[error("couldn't read this message: {0}")]
    Parse(String),
    #[error("connection failed: {0}")]
    Network(String),
    #[error("the server rejected the sign-in: {0}")]
    Auth(String),
}

pub type Result<T> = std::result::Result<T, Error>;

/// Seconds since the Unix epoch. All timestamps in the core use this.
pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
