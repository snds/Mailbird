//! RFC 8058 one-click unsubscribe: one POST to the sender's https address.
//!
//! The address comes from a message, so anyone can write it. The request
//! carries no cookies and no credentials, follows no redirects, and refuses
//! addresses that name this machine or a private network by IP. A gateway on
//! a home network must not become a way to poke at the router.

use std::net::IpAddr;
use std::time::Duration;

use crate::{Error, Result};

const TIMEOUT: Duration = Duration::from_secs(15);

/// Unsubscribe with one POST (`List-Unsubscribe=One-Click`).
pub async fn one_click(url: &str) -> Result<()> {
    check(url)?;
    let http = reqwest::Client::builder()
        .tls_backend_preconfigured(super::tls_config())
        .timeout(TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| Error::Network(e.to_string()))?;
    let res = http
        .post(url)
        .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .header(reqwest::header::USER_AGENT, "Mailbird")
        .body("List-Unsubscribe=One-Click")
        .send()
        .await
        .map_err(|e| Error::Network(e.to_string()))?;
    match res.status() {
        s if s.is_success() => Ok(()),
        // RFC 8058 says senders mustn't redirect; one that does wants a browser.
        s if s.is_redirection() => Err(Error::Invalid("the sender wants you to unsubscribe on their page instead".into())),
        s => Err(Error::Network(format!("the sender's server answered {s}"))),
    }
}

/// Only public https hosts: no IP literals for local or private networks,
/// no `localhost`, no single-label names.
pub fn check(url: &str) -> Result<()> {
    let bad = || Err(Error::Invalid("that unsubscribe address isn't a public https address".into()));
    let Some(rest) = url.strip_prefix("https://") else { return bad() };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.contains('@') {
        return bad();
    }
    let host = match authority.strip_prefix('[') {
        Some(v6) => v6.split(']').next().unwrap_or(""),
        None => authority.split(':').next().unwrap_or(""),
    }
    .trim_end_matches('.')
    .to_ascii_lowercase();
    if let Ok(ip) = host.parse::<IpAddr>() {
        let private = match ip {
            IpAddr::V4(v4) => {
                v4.is_loopback()
                    || v4.is_private()
                    || v4.is_link_local()
                    || v4.is_unspecified()
                    || v4.is_broadcast()
                    || v4.octets()[0] == 100 && v4.octets()[1] >= 64 && v4.octets()[1] < 128
            }
            IpAddr::V6(v6) => {
                v6.is_loopback() || v6.is_unspecified() || (v6.segments()[0] & 0xfe00) == 0xfc00 || (v6.segments()[0] & 0xffc0) == 0xfe80 || v6.to_ipv4_mapped().is_some()
            }
        };
        return if private { bad() } else { Ok(()) };
    }
    if host.is_empty() || !host.contains('.') || host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") || host.ends_with(".internal") {
        return bad();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::check;

    #[test]
    fn only_public_https() {
        for ok in ["https://list.example.com/u/abc", "https://list.example.com:8443/u?x=1", "https://8.8.8.8/u"] {
            assert!(check(ok).is_ok(), "{ok}");
        }
        for bad in [
            "http://list.example.com/u",
            "https://localhost/u",
            "https://router/u",
            "https://192.168.1.1/u",
            "https://10.0.0.5/u",
            "https://127.0.0.1:8080/u",
            "https://169.254.169.254/latest",
            "https://100.100.1.1/u",
            "https://[::1]/u",
            "https://[fd00::1]/u",
            "https://[::ffff:192.168.0.1]/u",
            "https://nas.local/u",
            "https://user@list.example.com/u",
            "https://printer.internal/u",
        ] {
            assert!(check(bad).is_err(), "{bad}");
        }
    }
}
