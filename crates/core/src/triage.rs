//! Sorting incoming mail into People, Updates, and Newsletters, from its
//! headers alone (the body never matters, and nothing leaves the device).
//!
//! - **Updates:** mail a machine sent about something you did or own:
//!   receipts, alerts, sign-in codes, notifications. `Auto-Submitted`
//!   (RFC 3834), `Precedence: junk`, or a sender like `no-reply@` or
//!   `notifications@`.
//! - **Newsletters:** mail sent to a list: `List-Id` or `List-Unsubscribe`
//!   (RFC 2919, RFC 2369), or `Precedence: bulk|list`.
//! - **People:** everything else.
//!
//! Updates are checked first: a notification service often adds list
//! headers too (GitHub does). A person can always move a sender to another
//! category, and that choice wins over these rules.

use crate::Category;
use crate::unsubscribe::{header, header_block};

/// Local parts that machines send from.
const MACHINE_SENDERS: &[&str] = &[
    "noreply",
    "no-reply",
    "no_reply",
    "donotreply",
    "do-not-reply",
    "do_not_reply",
    "notification",
    "notifications",
    "notify",
    "alert",
    "alerts",
    "mailer-daemon",
    "postmaster",
    "bounce",
    "bounces",
    "receipt",
    "receipts",
    "billing",
    "invoice",
    "invoices",
    "orders",
    "order-update",
    "shipping",
    "security",
    "account",
    "accounts",
    "verify",
    "verification",
];

pub fn classify(raw: &[u8], from_email: &str) -> Category {
    let headers = header_block(raw);
    let has = |name: &str| header(&headers, name).is_some();
    let precedence = header(&headers, "precedence").unwrap_or_default().trim().to_ascii_lowercase();
    let auto = header(&headers, "auto-submitted").is_some_and(|v| !v.trim().eq_ignore_ascii_case("no"));
    let local = from_email.split('@').next().unwrap_or("").to_ascii_lowercase();
    // "no-reply+abc", "notifications-github": the part before a separator.
    let stem = local.split(['+', '.']).next().unwrap_or("");
    if auto || precedence == "junk" || MACHINE_SENDERS.contains(&local.as_str()) || MACHINE_SENDERS.contains(&stem) {
        return Category::Updates;
    }
    if has("list-id") || has("list-unsubscribe") || precedence == "bulk" || precedence == "list" {
        return Category::Newsletters;
    }
    Category::People
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(headers: &str) -> Vec<u8> {
        format!("Subject: x\r\n{headers}\r\nList-Id: <in-the-body>\r\n").into_bytes()
    }

    #[test]
    fn sorting() {
        assert_eq!(classify(&raw("From: ana@example.com\r\n"), "ana@example.com"), Category::People);
        assert_eq!(classify(&raw("List-Id: Clay club <club.clay.example>\r\n"), "news@clay.example"), Category::Newsletters);
        assert_eq!(classify(&raw("List-Unsubscribe: <https://x.example/u>\r\n"), "hello@shop.example"), Category::Newsletters);
        assert_eq!(classify(&raw("Precedence: bulk\r\n"), "team@app.example"), Category::Newsletters);
        assert_eq!(classify(&raw("Auto-Submitted: auto-generated\r\n"), "ci@build.example"), Category::Updates);
        assert_eq!(classify(&raw("Auto-Submitted: no\r\n"), "ana@example.com"), Category::People, "explicitly not automatic");
        assert_eq!(classify(&raw(""), "no-reply@bank.example"), Category::Updates);
        assert_eq!(classify(&raw(""), "noreply+123@service.example"), Category::Updates);
        assert_eq!(
            classify(&raw("List-Id: <repo.github.com>\r\nList-Unsubscribe: <mailto:u@github.com>\r\n"), "notifications@github.com"),
            Category::Updates,
            "notifications beat list headers"
        );
        assert_eq!(classify(&raw(""), "receipts@shop.example"), Category::Updates);
        assert_eq!(classify(&raw("\r\n"), "ana@example.com"), Category::People, "headers below the body don't count");
    }
}
