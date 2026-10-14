//! A self-hosted push relay for Mailbird (ADR-0015).
//!
//! Phones can't hold a mail connection open in the background, so this
//! small server does it for them: it watches each mailbox (IMAP IDLE, JMAP
//! push, or Outlook's webhooks) and sends the phone a content-free wake-up
//! through APNs, FCM, or UnifiedPush. The phone then syncs itself.

pub mod api;
pub mod crypto;
pub mod notify;
pub mod store;
pub mod watch;
